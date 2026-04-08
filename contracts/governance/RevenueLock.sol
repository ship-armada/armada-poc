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
}

/// @title RevenueLock — Revenue-gated token release for team and airdrop ARM
/// @notice Holds ARM for beneficiaries and releases it as cumulative protocol revenue
///         milestones are reached. Immutable after deployment: no admin, no upgradeability,
///         no sweep. Released ARM is atomically delegated via delegateOnBehalf.
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

    // ============ State ============

    /// @notice Per-beneficiary total allocation
    mapping(address => uint256) public allocation;

    /// @notice Per-beneficiary cumulative released amount
    mapping(address => uint256) public released;

    /// @notice Ordered list of beneficiaries (for enumeration)
    address[] internal _beneficiaries;

    // ============ Events ============

    event Released(
        address indexed beneficiary,
        uint256 amount,
        address delegatee,
        uint256 cumulativeReleased
    );

    // ============ Constructor ============

    /// @param _armToken ARM token address (must whitelist this contract for transfers)
    /// @param _revenueCounter RevenueCounter UUPS proxy address
    /// @param beneficiaries Array of beneficiary addresses
    /// @param amounts Array of allocation amounts (18-decimal ARM), parallel to beneficiaries
    constructor(
        address _armToken,
        address _revenueCounter,
        address[] memory beneficiaries,
        uint256[] memory amounts
    ) {
        require(_armToken != address(0), "RevenueLock: zero armToken");
        require(_revenueCounter != address(0), "RevenueLock: zero revenueCounter");
        require(beneficiaries.length > 0, "RevenueLock: empty beneficiaries");
        require(beneficiaries.length == amounts.length, "RevenueLock: length mismatch");

        armToken = IArmadaTokenRevenueLock(_armToken);
        revenueCounter = IRevenueCounterRevenueLock(_revenueCounter);

        uint256 total = 0;
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

    // ============ Release ============

    /// @notice Release unlocked ARM to the caller and delegate their voting power.
    /// @param delegatee Address to receive the caller's voting power delegation.
    ///        Self-delegation is valid. Cannot be address(0).
    function release(address delegatee) external {
        require(delegatee != address(0), "RevenueLock: zero delegatee");
        uint256 alloc = allocation[msg.sender];
        require(alloc > 0, "RevenueLock: not a beneficiary");

        uint256 unlockBps = unlockPercentage();
        uint256 entitled = (alloc * unlockBps) / BPS_100;
        uint256 alreadyReleased = released[msg.sender];
        uint256 amount = entitled - alreadyReleased;
        require(amount > 0, "RevenueLock: nothing to release");

        released[msg.sender] = alreadyReleased + amount;

        require(armToken.transfer(msg.sender, amount), "RevenueLock: transfer failed");
        armToken.delegateOnBehalf(msg.sender, delegatee);

        emit Released(msg.sender, amount, delegatee, released[msg.sender]);
    }

    // ============ View Functions ============

    /// @notice Amount currently available for a beneficiary to release.
    function releasable(address beneficiary) external view returns (uint256) {
        uint256 alloc = allocation[beneficiary];
        if (alloc == 0) return 0;
        uint256 entitled = (alloc * unlockPercentage()) / BPS_100;
        uint256 alreadyReleased = released[beneficiary];
        if (entitled <= alreadyReleased) return 0;
        return entitled - alreadyReleased;
    }

    /// @notice Current unlock percentage in basis points (0 = 0%, 10000 = 100%).
    ///         Step function based on cumulative protocol revenue milestones.
    function unlockPercentage() public view returns (uint256) {
        uint256 revenue = revenueCounter.recognizedRevenueUsd();
        return _unlockBpsForRevenue(revenue);
    }

    /// @notice Current cumulative recognized revenue from the RevenueCounter.
    function currentRevenue() external view returns (uint256) {
        return revenueCounter.recognizedRevenueUsd();
    }

    /// @notice Number of beneficiaries in the list.
    function beneficiaryCount() external view returns (uint256) {
        return _beneficiaries.length;
    }

    // ============ Internal ============

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
}
