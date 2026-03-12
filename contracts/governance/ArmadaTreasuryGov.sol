// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./EmergencyPausable.sol";

/// @title ArmadaTreasuryGov — Governance-controlled treasury with claims mechanism
/// @notice Owned by TimelockController (immutable). Supports direct distributions,
///         claims (deferred exercise), and steward operational budget.
contract ArmadaTreasuryGov is ReentrancyGuard, EmergencyPausable {
    using SafeERC20 for IERC20;

    // ============ Types ============

    struct Claim {
        address token;
        address beneficiary;
        uint256 amount;
        uint256 exercised;
        uint256 createdAt;
        uint256 expiresAt; // 0 = never expires
        bool revoked;
    }

    // ============ State ============

    address public immutable owner; // TimelockController address (set once at deployment, cannot be changed)
    address public steward; // Treasury steward (limited powers)

    // Claims system
    uint256 public claimCount;
    mapping(uint256 => Claim) public claims;
    mapping(address => uint256[]) private _beneficiaryClaims;

    // Steward budget tracking (per token)
    //
    // The steward can spend up to 1% of the treasury balance per 30-day period.
    // The budget basis (treasury balance used for the 1% calculation) is snapshotted
    // once at the start of each period and held constant for the full 30 days.
    // This prevents mid-period balance changes from shifting the budget.
    //
    // The 30-day period starts on the steward's first spend after the previous period
    // expires (not on a fixed calendar schedule). Changing the steward does not reset
    // the budget window or the amount already spent.
    uint256 public constant STEWARD_BUDGET_BPS = 100; // 1%
    uint256 public constant BUDGET_PERIOD = 30 days;
    mapping(address => uint256) public budgetSpentThisPeriod; // cumulative spend in current period
    mapping(address => uint256) public lastBudgetReset; // timestamp when current period started
    mapping(address => uint256) public budgetBasis; // treasury balance snapshotted at period start

    // ============ Events ============

    event DirectDistribution(address indexed token, address indexed recipient, uint256 amount);
    event ClaimCreated(uint256 indexed claimId, address indexed beneficiary, address token, uint256 amount, uint256 expiresAt);
    event ClaimRevoked(uint256 indexed claimId, address indexed beneficiary, uint256 unexercised);
    event ClaimExercised(uint256 indexed claimId, address indexed beneficiary, uint256 amount);
    event StewardUpdated(address indexed oldSteward, address indexed newSteward);
    event StewardSpent(address indexed token, address indexed recipient, uint256 amount, uint256 budgetRemaining);

    // ============ Modifiers ============

    modifier onlyOwner() {
        require(msg.sender == owner, "ArmadaTreasuryGov: not owner");
        _;
    }

    modifier onlySteward() {
        require(msg.sender == steward, "ArmadaTreasuryGov: not steward");
        _;
    }

    // ============ Constructor ============

    constructor(
        address _owner,
        address _guardian,
        uint256 _maxPauseDuration
    ) EmergencyPausable(_guardian, _maxPauseDuration, _owner) {
        require(_owner != address(0), "ArmadaTreasuryGov: zero owner");
        owner = _owner; // Should be the timelock address
    }

    // ============ Governance Functions (owner = timelock) ============

    /// @notice Direct distribution: send tokens to recipient immediately
    function distribute(address token, address recipient, uint256 amount) external onlyOwner whenNotPaused {
        require(recipient != address(0), "ArmadaTreasuryGov: zero address");
        IERC20(token).safeTransfer(recipient, amount);
        emit DirectDistribution(token, recipient, amount);
    }

    /// @notice Create a claim: right to receive tokens, exercisable by beneficiary
    /// @param token Token address
    /// @param beneficiary Address that can exercise the claim
    /// @param amount Total claimable amount
    /// @param expiresAt Timestamp after which the claim cannot be exercised (0 = never expires)
    function createClaim(
        address token,
        address beneficiary,
        uint256 amount,
        uint256 expiresAt
    ) external onlyOwner returns (uint256) {
        require(beneficiary != address(0), "ArmadaTreasuryGov: zero address");
        require(amount > 0, "ArmadaTreasuryGov: zero amount");
        require(expiresAt == 0 || expiresAt > block.timestamp, "ArmadaTreasuryGov: expires in past");

        uint256 claimId = ++claimCount;
        claims[claimId] = Claim({
            token: token,
            beneficiary: beneficiary,
            amount: amount,
            exercised: 0,
            createdAt: block.timestamp,
            expiresAt: expiresAt,
            revoked: false
        });
        _beneficiaryClaims[beneficiary].push(claimId);

        emit ClaimCreated(claimId, beneficiary, token, amount, expiresAt);
        return claimId;
    }

    /// @notice Revoke a claim — prevents further exercise. Only callable by owner (timelock).
    /// @dev Tokens already exercised are not affected. Only the unexercised portion is reclaimed.
    function revokeClaim(uint256 claimId) external onlyOwner {
        Claim storage c = claims[claimId];
        require(c.beneficiary != address(0), "ArmadaTreasuryGov: claim does not exist");
        require(!c.revoked, "ArmadaTreasuryGov: already revoked");

        c.revoked = true;
        uint256 unexercised = c.amount - c.exercised;

        emit ClaimRevoked(claimId, c.beneficiary, unexercised);
    }

    /// @notice Set the treasury steward (governance only).
    /// @dev Does not reset the budget window or spending. The new steward inherits the
    /// current period's remaining budget and timing.
    function setSteward(address _steward) external onlyOwner {
        emit StewardUpdated(steward, _steward);
        steward = _steward;
    }

    // ============ Claim Functions ============

    /// @notice Exercise a claim — beneficiary receives tokens at their discretion
    /// @param claimId Claim to exercise
    /// @param amount Amount to exercise (can be partial)
    function exerciseClaim(uint256 claimId, uint256 amount) external nonReentrant whenNotPaused {
        Claim storage c = claims[claimId];
        require(c.beneficiary == msg.sender, "ArmadaTreasuryGov: not beneficiary");
        require(!c.revoked, "ArmadaTreasuryGov: claim revoked");
        require(c.expiresAt == 0 || block.timestamp <= c.expiresAt, "ArmadaTreasuryGov: claim expired");
        require(amount > 0, "ArmadaTreasuryGov: zero amount");
        require(c.exercised + amount <= c.amount, "ArmadaTreasuryGov: exceeds claim");

        c.exercised += amount;
        IERC20(c.token).safeTransfer(c.beneficiary, amount);

        emit ClaimExercised(claimId, c.beneficiary, amount);
    }

    // ============ Steward Functions ============

    /// @notice Steward: spend from operational budget
    /// @dev The budget is 1% of the treasury balance snapshotted at the start of each 30-day period.
    /// The period starts on the first spend after the previous period expires. Mid-period balance
    /// changes (deposits, governance distributions) do not affect the current period's budget.
    function stewardSpend(address token, address recipient, uint256 amount) external onlySteward whenNotPaused {
        require(recipient != address(0), "ArmadaTreasuryGov: zero address");
        require(amount > 0, "ArmadaTreasuryGov: zero amount");

        // Start a new budget period if the previous one has expired.
        // Snapshot the treasury balance as the basis for this period's 1% cap.
        if (block.timestamp >= lastBudgetReset[token] + BUDGET_PERIOD) {
            budgetSpentThisPeriod[token] = 0;
            lastBudgetReset[token] = block.timestamp;
            budgetBasis[token] = IERC20(token).balanceOf(address(this));
        }

        // Budget for this period: 1% of the snapshotted balance
        uint256 monthlyBudget = (budgetBasis[token] * STEWARD_BUDGET_BPS) / 10000;
        require(
            budgetSpentThisPeriod[token] + amount <= monthlyBudget,
            "ArmadaTreasuryGov: exceeds monthly budget"
        );

        budgetSpentThisPeriod[token] += amount;
        IERC20(token).safeTransfer(recipient, amount);

        uint256 remaining = monthlyBudget - budgetSpentThisPeriod[token];
        emit StewardSpent(token, recipient, amount, remaining);
    }

    // ============ View Functions ============

    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function getBeneficiaryClaims(address beneficiary) external view returns (uint256[] memory) {
        return _beneficiaryClaims[beneficiary];
    }

    function getClaimRemaining(uint256 claimId) external view returns (uint256) {
        Claim storage c = claims[claimId];
        if (c.revoked) return 0;
        if (c.expiresAt != 0 && block.timestamp > c.expiresAt) return 0;
        return c.amount - c.exercised;
    }

    /// @notice View the steward's current budget status for a token
    /// @dev If the period has expired, returns what the budget *would* be if a new period
    /// started now (based on current balance). During an active period, returns the
    /// snapshotted budget basis.
    function getStewardBudget(address token) external view returns (uint256 budget, uint256 spent, uint256 remaining) {
        if (block.timestamp >= lastBudgetReset[token] + BUDGET_PERIOD) {
            // Period expired — show what the next period's budget would be
            uint256 treasuryBalance = IERC20(token).balanceOf(address(this));
            budget = (treasuryBalance * STEWARD_BUDGET_BPS) / 10000;
            spent = 0;
        } else {
            // Active period — use snapshotted basis
            budget = (budgetBasis[token] * STEWARD_BUDGET_BPS) / 10000;
            spent = budgetSpentThisPeriod[token];
        }
        remaining = budget > spent ? budget - spent : 0;
    }

}
