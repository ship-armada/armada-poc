// SPDX-License-Identifier: MIT
// ABOUTME: Revenue-gated token release contract for team and airdrop ARM allocations.
// ABOUTME: Releases ARM to beneficiaries as cumulative protocol revenue milestones are reached.
pragma solidity ^0.8.17;

// Minimal interfaces for cross-contract calls
interface IRevenueCounterRevenueLock {
    function recognizedRevenueUsd() external view returns (uint256);
}

interface IArmadaTokenRevenueLock {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function delegateOnBehalf(address delegator, address delegatee) external;
    function transferAndDelegate(address to, uint256 amount, address delegatee) external;
}

/// @title RevenueLock — Revenue-gated token release for team and airdrop ARM
/// @notice Holds ARM for beneficiaries and releases it as cumulative protocol revenue
///         milestones are reached. Immutable after deployment: no admin, no upgradeability,
///         no sweep. Released ARM is atomically delegated via delegateOnBehalf.
///
///         Entitlements derive from `maxObservedRevenue`, a monotonic ratchet maintained
///         internally — never from a direct read of RevenueCounter. The ratchet advances
///         at no more than MAX_REVENUE_INCREASE_PER_DAY per elapsed day, which structurally
///         neutralises governance-controlled RevenueCounter upgrades that could otherwise
///         rewind (→ freeze) or accelerate (→ instant-unlock) entitlements.
contract RevenueLock {

    // ============ Constants ============

    /// @notice Maximum basis points (100%)
    uint256 private constant BPS_100 = 10000;

    // ============ Immutable References ============

    /// @notice ARM governance token
    IArmadaTokenRevenueLock public immutable armToken;

    /// @notice Revenue counter (reads cumulative recognized revenue)
    IRevenueCounterRevenueLock public immutable revenueCounter;

    /// @notice Total ARM allocated across all beneficiaries
    uint256 public immutable totalAllocation;

    /// @notice Maximum amount that `maxObservedRevenue` can advance per elapsed day,
    ///         in 18-decimal USD to match RevenueCounter.recognizedRevenueUsd.
    ///         Defensive security calibration: if set to $10k/day, a malicious
    ///         RevenueCounter upgrade cannot accelerate $0 → $1M full-unlock faster
    ///         than ~100 days, giving the community and Security Council time to respond.
    ///         See PARAMETER_MANIFEST.md (ship-armada/crowdfund) and issue #225.
    uint256 public immutable MAX_REVENUE_INCREASE_PER_DAY;

    // ============ State ============

    /// @notice Per-beneficiary total allocation
    mapping(address => uint256) public allocation;

    /// @notice Per-beneficiary cumulative released amount
    mapping(address => uint256) public released;

    /// @notice Ordered list of beneficiaries (for enumeration)
    address[] internal _beneficiaries;

    /// @notice Monotonic ratchet over RevenueCounter reads. Used for all entitlement math.
    ///         Only ever advances, never decreases, even if RevenueCounter returns a lower
    ///         value on a later call.
    uint256 public maxObservedRevenue;

    /// @notice Wall-clock timestamp of the most recent call to `_updateMaxObservedRevenue`.
    ///         Advances unconditionally on every sync (including no-ops) so the rate-limit
    ///         allowance budget is consumed by real elapsed time rather than accumulating
    ///         indefinitely during quiet periods.
    uint256 public lastSyncTimestamp;

    /// @notice Wind-down contract authorized to freeze the lock at trigger time.
    ///         Set once via setWindDownContract.
    address public windDownContract;
    /// @notice One-time setter lock for windDownContract.
    bool public windDownContractSet;

    /// @notice Whether the ratchet is permanently frozen. Set by the wind-down contract
    ///         at trigger time. Once frozen, _updateMaxObservedRevenue is a no-op so
    ///         maxObservedRevenue is fixed. ArmadaRedemption.circulatingSupply uses
    ///         lockedAtWindDown() to read the frozen locked-portion deterministically
    ///         across the post-wind-down redemption window.
    bool public frozenAtWindDown;

    /// @notice Whether the contract has been verified as fully funded. Releases are
    ///         blocked until activation. Set once via the permissionless `activate()`.
    bool public activated;

    // ============ Events ============

    event Released(
        address indexed beneficiary,
        uint256 amount,
        address delegatee,
        uint256 cumulativeReleased
    );

    /// @notice Emitted once when activation succeeds. fundedBalance is the contract's
    ///         ARM balance at activation time (must be >= totalAllocation).
    event Activated(uint256 fundedBalance);

    /// @notice Emitted on every actual ratchet advance of maxObservedRevenue.
    /// @param oldMax             Previous maxObservedRevenue value.
    /// @param newMax             New maxObservedRevenue value (post-ratchet, post-cap).
    /// @param reportedByCounter  Raw value returned by RevenueCounter at the time of update.
    ///                           If `reportedByCounter > newMax`, the advance was rate-limited.
    event ObservedRevenueUpdated(
        uint256 oldMax,
        uint256 newMax,
        uint256 reportedByCounter
    );

    /// @notice Emitted on every non-frozen call to _updateMaxObservedRevenue, including
    ///         no-op syncs that consume elapsed-time budget without advancing the ratchet.
    ///         Distinct from ObservedRevenueUpdated, which fires only when maxObservedRevenue
    ///         actually advances. Subscribers wanting advance-detection should use
    ///         ObservedRevenueUpdated; subscribers wanting full sync observability (e.g. to
    ///         detect budget consumption during flat-revenue periods) should use Synced.
    /// @param syncedAt              block.timestamp at sync.
    /// @param reportedByCounter     Raw value returned by RevenueCounter at the time of sync.
    /// @param maxObservedRevenue_   Post-call maxObservedRevenue (equals oldMax on no-op).
    event Synced(
        uint256 syncedAt,
        uint256 reportedByCounter,
        uint256 maxObservedRevenue_
    );

    event WindDownContractSet(address indexed windDownContract);
    event FrozenAtWindDown(uint256 maxObservedRevenue, uint256 unlockBps);

    // ============ Constructor ============

    /// @param _armToken ARM token address (must whitelist this contract for transfers)
    /// @param _revenueCounter RevenueCounter UUPS proxy address
    /// @param _maxIncreasePerDay Max observed-revenue advance per elapsed day, 18-decimal USD
    /// @param beneficiaries Array of beneficiary addresses
    /// @param amounts Array of allocation amounts (18-decimal ARM), parallel to beneficiaries
    constructor(
        address _armToken,
        address _revenueCounter,
        uint256 _maxIncreasePerDay,
        address[] memory beneficiaries,
        uint256[] memory amounts
    ) {
        require(_armToken != address(0), "RevenueLock: zero armToken");
        require(_revenueCounter != address(0), "RevenueLock: zero revenueCounter");
        require(_maxIncreasePerDay > 0, "RevenueLock: zero maxIncrease");
        require(beneficiaries.length > 0, "RevenueLock: empty beneficiaries");
        require(beneficiaries.length == amounts.length, "RevenueLock: length mismatch");

        armToken = IArmadaTokenRevenueLock(_armToken);
        revenueCounter = IRevenueCounterRevenueLock(_revenueCounter);
        MAX_REVENUE_INCREASE_PER_DAY = _maxIncreasePerDay;

        // CRITICAL: lastSyncTimestamp must start at block.timestamp, NOT 0.
        // A zero timestamp would make the first _updateMaxObservedRevenue() see
        // `elapsed == block.timestamp`, which would let the ratchet leap to whatever
        // RevenueCounter reports on the first call — fully bypassing the rate limit.
        // Do NOT seed maxObservedRevenue from the counter for the same reason: a
        // malicious initial counter implementation could start the ratchet high.
        lastSyncTimestamp = block.timestamp;

        uint256 total;
        for (uint256 i = 0; i < beneficiaries.length; i++) {
            require(beneficiaries[i] != address(0), "RevenueLock: zero beneficiary");
            require(amounts[i] > 0, "RevenueLock: zero amount");
            require(allocation[beneficiaries[i]] == 0, "RevenueLock: duplicate beneficiary");

            allocation[beneficiaries[i]] = amounts[i];
            _beneficiaries.push(beneficiaries[i]);
            total += amounts[i];
        }

        totalAllocation = total;
    }

    // ============ Activation ============

    /// @notice Permissionless: verify the contract holds at least totalAllocation ARM
    ///         and unlock release() for all beneficiaries. One-shot — once activated,
    ///         the gate cannot be re-armed. Must be called after the deployer/governance
    ///         funds the contract and before any beneficiary attempts to release.
    /// @dev Without this gate, partial funding (e.g. 1.2M of 2.4M) produces order-
    ///      dependent claims: early beneficiaries claim, later ones revert at transfer.
    ///      The contract is immutable with no admin/sweep, so an underfunded deployment
    ///      would have no recovery path. This check fails fast for ALL beneficiaries
    ///      until the funding is fully topped up.
    function activate() external {
        require(!activated, "RevenueLock: already activated");
        uint256 balance = armToken.balanceOf(address(this));
        require(balance >= totalAllocation, "RevenueLock: underfunded");
        activated = true;
        emit Activated(balance);
    }

    // ============ Release ============

    /// @notice Release unlocked ARM to the caller and delegate their voting power.
    /// @param delegatee Address to receive the caller's voting power delegation.
    ///        Self-delegation is valid. Cannot be address(0).
    function release(address delegatee) external {
        require(activated, "RevenueLock: not activated");
        require(delegatee != address(0), "RevenueLock: zero delegatee");
        uint256 alloc = allocation[msg.sender];
        require(alloc > 0, "RevenueLock: not a beneficiary");

        // Advance the ratchet first so entitlement math uses the current capped value.
        // _updateMaxObservedRevenue returns the effective post-update value to avoid
        // re-SLOADing maxObservedRevenue right after it was just written (audit-75).
        uint256 effectiveMax = _updateMaxObservedRevenue();

        uint256 unlockBps = _unlockBpsForRevenue(effectiveMax);
        uint256 entitled = (alloc * unlockBps) / BPS_100;
        uint256 alreadyReleased = released[msg.sender];
        uint256 amount = entitled - alreadyReleased;
        require(amount > 0, "RevenueLock: nothing to release");

        // Compute new released into a local first to avoid SLOAD in the emit (audit-76).
        uint256 newReleased = alreadyReleased + amount;
        released[msg.sender] = newReleased;

        // Combined transfer + delegateOnBehalf — atomic by construction, one CALL.
        armToken.transferAndDelegate(msg.sender, amount, delegatee);

        emit Released(msg.sender, amount, delegatee, newReleased);
    }

    /// @notice Permissionless: advance the observed-revenue ratchet without claiming.
    /// @dev Intended for monitoring bots and operational tooling. Keeps the rate-limit
    ///      allowance window tight: without regular syncs, elapsed-time budget
    ///      accumulates and a single later call could leap `maxObservedRevenue` by
    ///      N × MAX_REVENUE_INCREASE_PER_DAY. OPERATIONS.md requires at least daily
    ///      calls; monitoring infrastructure should call more frequently.
    ///      Every call writes to storage (lastSyncTimestamp), including no-ops — that
    ///      is expected behavior, not an inefficiency.
    function syncObservedRevenue() external {
        _updateMaxObservedRevenue();
    }

    // ============ View Functions ============

    /// @notice Amount currently available for a beneficiary to release.
    /// @dev Uses `getCappedObservedRevenue()` so this view reflects what `release()`
    ///      would actually deliver after advancing the ratchet. Callers should prefer
    ///      this over simulating the internal logic themselves.
    function releasable(address beneficiary) external view returns (uint256) {
        uint256 alloc = allocation[beneficiary];
        if (alloc == 0) return 0;
        uint256 effective = getCappedObservedRevenue();
        uint256 entitled = (alloc * _unlockBpsForRevenue(effective)) / BPS_100;
        uint256 alreadyReleased = released[beneficiary];
        if (entitled <= alreadyReleased) return 0;
        return entitled - alreadyReleased;
    }

    /// @notice Current unlock percentage in basis points (0 = 0%, 10000 = 100%).
    ///         Step function based on the rate-limited observed-revenue ratchet —
    ///         NOT a direct read of the RevenueCounter. This matches what `release()`
    ///         will see after `_updateMaxObservedRevenue()` runs.
    function unlockPercentage() public view returns (uint256) {
        return _unlockBpsForRevenue(getCappedObservedRevenue());
    }

    /// @notice Raw cumulative recognized revenue as reported by the RevenueCounter.
    /// @dev Exposed for monitoring/diagnostics only — does NOT flow through the ratchet.
    ///      Entitlement logic uses `maxObservedRevenue` / `getCappedObservedRevenue()`.
    ///      A sustained divergence between `currentRevenue()` and `getCappedObservedRevenue()`
    ///      indicates either an over-reporting RevenueCounter being rate-limited or a
    ///      malicious upgrade in progress; either warrants off-chain investigation.
    function currentRevenue() external view returns (uint256) {
        return revenueCounter.recognizedRevenueUsd();
    }

    /// @notice Preview of `maxObservedRevenue` after a hypothetical call to
    ///         `syncObservedRevenue()` at the current block, without modifying state.
    /// @dev Mirrors `_updateMaxObservedRevenue()` exactly. Monitoring bots should use
    ///      this instead of re-implementing the cap math off-chain.
    function getCappedObservedRevenue() public view returns (uint256) {
        // Cache maxObservedRevenue: read twice (audit-76).
        uint256 maxObs = maxObservedRevenue;
        // Post-freeze: mirror _updateMaxObservedRevenue's no-op behavior. Without
        // this check, elapsed-driven maxAllowedIncrease causes the view to drift
        // above storage as time passes post-trigger — contradicting the natspec's
        // "mirrors exactly" contract and over-reporting `releasable()` to
        // beneficiaries vs. what `release()` will actually deliver (audit-90 follow-up).
        if (frozenAtWindDown) return maxObs;
        uint256 reported = revenueCounter.recognizedRevenueUsd();
        uint256 elapsed = block.timestamp - lastSyncTimestamp;
        uint256 maxAllowedIncrease = (elapsed * MAX_REVENUE_INCREASE_PER_DAY) / 1 days;
        uint256 capped = _min(reported, maxObs + maxAllowedIncrease);
        return capped > maxObs ? capped : maxObs;
    }

    /// @notice Number of beneficiaries in the list.
    function beneficiaryCount() external view returns (uint256) {
        return _beneficiaries.length;
    }

    /// @notice Locked (unvested) ARM portion at this point in time, used by
    ///         ArmadaRedemption.circulatingSupply as the non-circulating share of
    ///         this contract.
    /// @dev Pre-freeze: computed from the live (rate-limited) ratchet — useful for
    ///      monitoring. Post-freeze: returns the value frozen at wind-down trigger.
    ///      The frozen value remains stable across the redemption window so the
    ///      denominator does not shift between sequential redemptions.
    function lockedAtWindDown() external view returns (uint256) {
        // unlockBps is uniform across all beneficiaries (single milestone schedule),
        // so total entitled = totalAllocation * unlockBps / 10000 and locked is the
        // complement against the constant totalAllocation.
        uint256 unlockBps = _unlockBpsForRevenue(maxObservedRevenue);
        return totalAllocation - (totalAllocation * unlockBps) / BPS_100;
    }

    // ============ Wind-Down ============

    /// @notice Register the wind-down contract. One-shot setter; locks after the
    ///         first non-zero call. Permissionless (no admin on RevenueLock).
    function setWindDownContract(address _windDownContract) external {
        require(!windDownContractSet, "RevenueLock: wind-down already set");
        require(_windDownContract != address(0), "RevenueLock: zero windDown");
        windDownContractSet = true;
        windDownContract = _windDownContract;
        emit WindDownContractSet(_windDownContract);
    }

    /// @notice Freeze the ratchet at the current state. Wind-down only; one-shot.
    /// @dev Performs one final ratchet update to absorb whatever value the (just
    ///      frozen) RevenueCounter currently reports, then sets frozenAtWindDown.
    ///      After this, _updateMaxObservedRevenue is a no-op and lockedAtWindDown
    ///      returns a stable value. The wind-down contract is responsible for
    ///      freezing the RevenueCounter BEFORE calling this so the final ratchet
    ///      update reads a stable upstream value.
    function freezeAtWindDown() external {
        require(msg.sender == windDownContract, "RevenueLock: not wind-down");
        require(!frozenAtWindDown, "RevenueLock: already frozen");

        // One last ratchet update against the frozen counter.
        _updateMaxObservedRevenue();

        frozenAtWindDown = true;
        emit FrozenAtWindDown(maxObservedRevenue, _unlockBpsForRevenue(maxObservedRevenue));
    }

    // ============ Internal ============

    /// @dev Advance `maxObservedRevenue` to the minimum of (reported, prev + budget),
    ///      where budget = elapsed * MAX_REVENUE_INCREASE_PER_DAY / 1 days.
    ///      `lastSyncTimestamp` ALWAYS advances to `block.timestamp`, even when
    ///      `maxObservedRevenue` does not. This is the mechanism that consumes the
    ///      elapsed-time allowance on every sync — without it, daily syncs during
    ///      flat-revenue periods would fail to bound the cumulative budget and the
    ///      rate cap would become meaningless over time.
    /// @return effectiveMax The post-update maxObservedRevenue. Equals the prior
    ///         value when no advance occurs (no-op or frozen). Returned so callers
    ///         like release() don't have to SLOAD maxObservedRevenue right back (audit-75).
    function _updateMaxObservedRevenue() internal returns (uint256 effectiveMax) {
        // Cache maxObservedRevenue: read 3 times below (audit-76) and returned
        // as the effective post-update value (audit-75).
        effectiveMax = maxObservedRevenue;

        // Post-freeze: ratchet is permanently fixed. release() must still work for
        // beneficiaries holding entitled-unreleased ARM, so we silently no-op here
        // rather than revert. lastSyncTimestamp is also frozen — there is no
        // budget to consume once the ratchet is locked.
        if (frozenAtWindDown) return effectiveMax;

        uint256 reported = revenueCounter.recognizedRevenueUsd();

        uint256 elapsed = block.timestamp - lastSyncTimestamp;
        uint256 maxAllowedIncrease = (elapsed * MAX_REVENUE_INCREASE_PER_DAY) / 1 days;
        uint256 capped = _min(reported, effectiveMax + maxAllowedIncrease);

        if (capped > effectiveMax) {
            // Emit before SSTORE so the optimizer doesn't hold the prior value in
            // a stack slot across the write — see audit-91.
            emit ObservedRevenueUpdated(effectiveMax, capped, reported);
            maxObservedRevenue = capped;
            effectiveMax = capped;
        }

        lastSyncTimestamp = block.timestamp;
        emit Synced(block.timestamp, reported, effectiveMax);
    }

    /// @dev Step function: returns the unlock bps for a given cumulative revenue.
    ///      No interpolation — jumps at each threshold.
    function _unlockBpsForRevenue(uint256 revenue) internal pure returns (uint256) {
        // Milestones checked in descending order for early return at highest reached
        if (revenue >= 1_000_000e18) return 10000; // 100%
        if (revenue >= 500_000e18)   return 8000;  // 80%
        if (revenue >= 250_000e18)   return 6000;  // 60%
        if (revenue >= 100_000e18)   return 4000;  // 40%
        if (revenue >= 50_000e18)    return 2500;  // 25%
        if (revenue >= 10_000e18)    return 1000;  // 10%
        return 0;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
