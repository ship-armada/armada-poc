// SPDX-License-Identifier: MIT
// ABOUTME: Fixed-cap, irrevocable grants backed by one beneficiary allocation in RevenueLock.
// ABOUTME: Anyone can fund a bounded batch payout; the allocator inherits the unassigned wind-down remainder.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

interface IRevenueLockReserveDistributor {
    function armToken() external view returns (address);
    function allocation(address beneficiary) external view returns (uint256);
    function released(address beneficiary) external view returns (uint256);
    function activated() external view returns (bool);
    function frozenAtWindDown() external view returns (bool);
    function releasable(address beneficiary) external view returns (uint256);
    function release(address delegatee) external;
}

interface IArmadaReserveDelegation {
    function delegate(address delegatee) external;
    function whitelistInitialized() external view returns (bool);
    function noDelegationSet() external view returns (bool);
    function authorizedDelegatorsInitialized() external view returns (bool);
    function transferWhitelist(address account) external view returns (bool);
    function noDelegation(address account) external view returns (bool);
    function authorizedDelegator(address account) external view returns (bool);
}

/// @title RevenueReserveDistributor
/// @notice Immutable reserve distributor for the existing, unmodified RevenueLock.
/// The allocator (intended to be a 2-of-3 multisig) can only add grants, up to a
/// lifetime cap. Claims and collection never restore assignment capacity.
/// At wind-down the unassigned allocation belongs to that same allocator, subject
/// to the original lock's frozen milestone. Assignments then permanently stop.
/// @dev distribute() collects and pays everyone. claimCollected(), claimRange() and
/// claimSelf() use only tokens already collected, without reading RevenueCounter.
/// Batch calls intentionally let third parties cause ARM to enter circulation.
/// Recipient delegation is preserved; undelegated recipients must delegate themselves.
/// No upgrades, sweep, approvals, arbitrary calls, or configurable delegation.
contract RevenueReserveDistributor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    /// @notice 50 distinct grantees plus the allocator, whose slot is reserved.
    uint256 public constant MAX_BENEFICIARIES = 51;
    /// @notice 10^-14 ARM. Ensures all basis-point entitlements divide exactly.
    uint256 public constant ALLOCATION_QUANTUM = 10_000;

    IERC20 public immutable armToken;
    address public immutable allocator;
    address public immutable deployer;
    uint256 public immutable reserveCap;

    /// @notice Bound once by deployer after RevenueLock is deployed with this beneficiary.
    IRevenueLockReserveDistributor public revenueLock;
    mapping(address => uint256) public assigned;
    mapping(address => uint256) public claimed;
    uint256 public totalAssigned;
    uint256 public totalCollected;
    uint256 public totalClaimed;
    uint256 public collectedBps;
    /// @notice Allocator is always index 0, even with no explicit grant.
    address[] public beneficiaries;

    error InvalidAddress();
    error InvalidAmount();
    error NotDeployer();
    error NotAllocator();
    error NotBound();
    error AlreadyBound();
    error InvalidLock();
    error NotActivated();
    error AssignmentsClosed();
    error ReserveExceeded();
    error TooManyBeneficiaries();
    error InvalidRange();
    error InvalidCollection();
    error IncompleteTokenSetup();
    error InvalidIntegration();

    event RevenueLockBound(address indexed revenueLock);
    event Assigned(address indexed beneficiary, uint256 amount, uint256 cumulativeAssigned);
    event Collected(uint256 amount, uint256 cumulativeCollected, uint256 unlockBps);
    event Claimed(address indexed beneficiary, uint256 amount, uint256 cumulativeClaimed);

    constructor(address _armToken, address _allocator, uint256 _reserveCap) {
        if (
            _armToken.code.length == 0 || _allocator == address(0) || _allocator == address(this)
                || _allocator == _armToken
        ) revert InvalidAddress();
        if (_reserveCap == 0 || _reserveCap % ALLOCATION_QUANTUM != 0 || _reserveCap > IERC20(_armToken).totalSupply()) revert InvalidAmount();

        armToken = IERC20(_armToken);
        allocator = _allocator;
        deployer = msg.sender;
        reserveCap = _reserveCap;
        beneficiaries.push(_allocator);
    }

    /// @notice One-time deployer-only binding. Matching getters are consistency
    /// checks, not code authentication: deployment must verify the exact lock code/address.
    function bindRevenueLock(address lockAddress) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(revenueLock) != address(0)) revert AlreadyBound();
        if (
            lockAddress.code.length == 0 || lockAddress == address(this) || lockAddress == address(armToken)
                || lockAddress == allocator
        ) revert InvalidLock();
        IRevenueLockReserveDistributor lock = IRevenueLockReserveDistributor(lockAddress);
        if (
            lock.armToken() != address(armToken) || lock.allocation(address(this)) != reserveCap
                || lock.released(address(this)) != 0 || lock.frozenAtWindDown()
        ) revert InvalidLock();
        revenueLock = lock;
        emit RevenueLockBound(lockAddress);
    }

    /// @notice Returns true or reverts if the bound lock/token permissions are unsafe.
    /// Deployment MUST call this after token initialization and before funding the lock.
    /// @dev A current-state check, not an ongoing permission gate. Does not authenticate
    /// contract code or verify the allocator, governor exclusions, or wind-down wiring.
    /// Keeping it out of payout paths preserves access to already-collected entitlements.
    function verifyIntegration() external view returns (bool) {
        _requireBound();
        IArmadaReserveDelegation token = IArmadaReserveDelegation(address(armToken));
        if (!token.whitelistInitialized() || !token.noDelegationSet() || !token.authorizedDelegatorsInitialized()) {
            revert IncompleteTokenSetup();
        }
        address lockAddress = address(revenueLock);
        if (
            revenueLock.armToken() != address(armToken) || revenueLock.allocation(address(this)) != reserveCap
                || token.noDelegation(address(this)) || !token.transferWhitelist(address(this))
                || token.authorizedDelegator(address(this)) || !token.transferWhitelist(lockAddress)
                || !token.authorizedDelegator(lockAddress)
        ) revert InvalidIntegration();
        return true;
    }

    /// @notice Add an irrevocable grant. Self-assignment by the allocator is allowed.
    function assign(address beneficiary, uint256 amount) external {
        if (msg.sender != allocator) revert NotAllocator();
        _requireBound();
        if (revenueLock.frozenAtWindDown()) revert AssignmentsClosed();
        if (
            beneficiary == address(0) || beneficiary == address(this) || beneficiary == address(revenueLock)
                || beneficiary == address(armToken)
        ) revert InvalidAddress();
        if (amount == 0 || amount % ALLOCATION_QUANTUM != 0) revert InvalidAmount();
        if (amount > reserveCap - totalAssigned) revert ReserveExceeded();

        if (beneficiary != allocator && assigned[beneficiary] == 0) {
            if (beneficiaries.length == MAX_BENEFICIARIES) revert TooManyBeneficiaries();
            beneficiaries.push(beneficiary);
        }
        assigned[beneficiary] += amount;
        totalAssigned += amount;
        emit Assigned(beneficiary, amount, assigned[beneficiary]);
    }

    /// @notice Anyone may collect newly unlocked ARM without triggering payouts.
    function collect() external nonReentrant returns (uint256 amount) {
        _requireBound();
        return _collect();
    }

    /// @notice Anyone pays gas once to collect and pay all registered beneficiaries.
    /// Nothing due is a successful no-op. A failed transfer reverts the whole batch.
    /// If RevenueCounter is unavailable, use claimCollected/claimRange/claimSelf.
    function distribute() external nonReentrant returns (uint256 amount) {
        _requireBound();
        _collect();
        return _claimRange(0, beneficiaries.length);
    }

    /// @notice Pay everyone from already-collected funds, without calling RevenueCounter.
    function claimCollected() external nonReentrant returns (uint256 amount) {
        _requireBound();
        return _claimRange(0, beneficiaries.length);
    }

    /// @notice Pay a smaller batch from collected funds; indexes are [start, end).
    /// No persistent cursor: repeat/overlapping ranges safely skip amounts already paid.
    function claimRange(uint256 start, uint256 end) external nonReentrant returns (uint256 amount) {
        _requireBound();
        if (start > end || end > beneficiaries.length) revert InvalidRange();
        return _claimRange(start, end);
    }

    /// @notice Individual escape hatch from already-collected funds. Pays msg.sender only.
    function claimSelf() external nonReentrant returns (uint256 amount) {
        _requireBound();
        return _pay(msg.sender, collectedBps, revenueLock.frozenAtWindDown());
    }

    function beneficiaryCount() external view returns (uint256) {
        return beneficiaries.length;
    }

    /// @notice Unassigned accounting remainder. After wind-down this belongs to allocator.
    function unassigned() external view returns (uint256) {
        return reserveCap - totalAssigned;
    }

    function remainingAssignable() external view returns (uint256) {
        _requireBound();
        return revenueLock.frozenAtWindDown() ? 0 : reserveCap - totalAssigned;
    }

    function effectiveAllocation(address beneficiary) public view returns (uint256) {
        _requireBound();
        return _effectiveAllocation(beneficiary, revenueLock.frozenAtWindDown());
    }

    /// @notice Payable from collected funds now. Does not preview a future collection.
    /// A zero value can become positive after collect() or distribute() collects another tier.
    function claimable(address beneficiary) external view returns (uint256) {
        return Math.mulDiv(effectiveAllocation(beneficiary), collectedBps, BPS) - claimed[beneficiary];
    }

    function _requireBound() internal view {
        if (address(revenueLock) == address(0)) revert NotBound();
    }

    function _collect() internal returns (uint256 amount) {
        // Full collection removes even the normal claim path's counter dependency.
        if (totalCollected == reserveCap) return 0;
        if (!revenueLock.activated()) revert NotActivated();
        if (revenueLock.releasable(address(this)) == 0) return 0;

        // RevenueLock requires nonzero delegation. Immediately undelegate our own
        // balance in the same transaction. Never delegate it to caller/allocator.
        revenueLock.release(address(this));
        IArmadaReserveDelegation(address(armToken)).delegate(address(0));

        uint256 nextCollected = revenueLock.released(address(this));
        uint256 perBasisPoint = reserveCap / BPS;
        if (nextCollected <= totalCollected || nextCollected > reserveCap || nextCollected % perBasisPoint != 0) {
            revert InvalidCollection();
        }
        amount = nextCollected - totalCollected;
        totalCollected = nextCollected;
        collectedBps = nextCollected / perBasisPoint;
        emit Collected(amount, nextCollected, collectedBps);
    }

    function _effectiveAllocation(address beneficiary, bool frozen) internal view returns (uint256 amount) {
        amount = assigned[beneficiary];
        if (frozen && beneficiary == allocator) amount += reserveCap - totalAssigned;
    }

    function _claimRange(uint256 start, uint256 end) internal returns (uint256 amount) {
        uint256 bps = collectedBps;
        bool frozen = revenueLock.frozenAtWindDown();
        for (uint256 i = start; i < end; ++i) {
            amount += _pay(beneficiaries[i], bps, frozen);
        }
    }

    function _pay(address beneficiary, uint256 bps, bool frozen) internal returns (uint256 amount) {
        uint256 entitled = Math.mulDiv(_effectiveAllocation(beneficiary, frozen), bps, BPS);
        amount = entitled - claimed[beneficiary];
        if (amount == 0) return 0;
        claimed[beneficiary] = entitled;
        totalClaimed += amount;
        armToken.safeTransfer(beneficiary, amount);
        emit Claimed(beneficiary, amount, entitled);
    }
}
