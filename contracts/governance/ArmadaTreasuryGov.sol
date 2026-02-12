// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @title ArmadaTreasuryGov — Governance-controlled treasury with claims mechanism
/// @notice Owned by TimelockController. Supports direct distributions, claims (deferred exercise),
///         and steward operational budget (1% monthly).
contract ArmadaTreasuryGov is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Types ============

    struct Claim {
        address token;
        address beneficiary;
        uint256 amount;
        uint256 exercised;
        uint256 createdAt;
    }

    // ============ State ============

    address public owner; // TimelockController address (governance-controlled)
    address public steward; // Treasury steward (limited powers)

    // Claims system
    uint256 public claimCount;
    mapping(uint256 => Claim) public claims;
    mapping(address => uint256[]) private _beneficiaryClaims;

    // Steward monthly budget tracking
    uint256 public constant STEWARD_BUDGET_BPS = 100; // 1%
    uint256 public constant BUDGET_PERIOD = 30 days;
    mapping(address => uint256) public budgetSpentThisPeriod; // per token
    mapping(address => uint256) public lastBudgetReset; // per token

    // ============ Events ============

    event DirectDistribution(address indexed token, address indexed recipient, uint256 amount);
    event ClaimCreated(uint256 indexed claimId, address indexed beneficiary, address token, uint256 amount);
    event ClaimExercised(uint256 indexed claimId, address indexed beneficiary, uint256 amount);
    event StewardUpdated(address indexed oldSteward, address indexed newSteward);
    event StewardSpent(address indexed token, address indexed recipient, uint256 amount, uint256 budgetRemaining);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

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

    constructor(address _owner) {
        owner = _owner; // Should be the timelock address
    }

    // ============ Governance Functions (owner = timelock) ============

    /// @notice Direct distribution: send tokens to recipient immediately
    function distribute(address token, address recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "ArmadaTreasuryGov: zero address");
        IERC20(token).safeTransfer(recipient, amount);
        emit DirectDistribution(token, recipient, amount);
    }

    /// @notice Create a claim: right to receive tokens, exercisable by beneficiary
    /// @param token Token address
    /// @param beneficiary Address that can exercise the claim
    /// @param amount Total claimable amount
    function createClaim(
        address token,
        address beneficiary,
        uint256 amount
    ) external onlyOwner returns (uint256) {
        require(beneficiary != address(0), "ArmadaTreasuryGov: zero address");
        require(amount > 0, "ArmadaTreasuryGov: zero amount");

        uint256 claimId = ++claimCount;
        claims[claimId] = Claim({
            token: token,
            beneficiary: beneficiary,
            amount: amount,
            exercised: 0,
            createdAt: block.timestamp
        });
        _beneficiaryClaims[beneficiary].push(claimId);

        emit ClaimCreated(claimId, beneficiary, token, amount);
        return claimId;
    }

    /// @notice Set the treasury steward (governance only)
    function setSteward(address _steward) external onlyOwner {
        emit StewardUpdated(steward, _steward);
        steward = _steward;
    }

    /// @notice Transfer ownership (governance only)
    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "ArmadaTreasuryGov: zero address");
        emit OwnerUpdated(owner, _newOwner);
        owner = _newOwner;
    }

    // ============ Claim Functions ============

    /// @notice Exercise a claim — beneficiary receives tokens at their discretion
    /// @param claimId Claim to exercise
    /// @param amount Amount to exercise (can be partial)
    function exerciseClaim(uint256 claimId, uint256 amount) external nonReentrant {
        Claim storage c = claims[claimId];
        require(c.beneficiary == msg.sender, "ArmadaTreasuryGov: not beneficiary");
        require(amount > 0, "ArmadaTreasuryGov: zero amount");
        require(c.exercised + amount <= c.amount, "ArmadaTreasuryGov: exceeds claim");

        c.exercised += amount;
        IERC20(c.token).safeTransfer(c.beneficiary, amount);

        emit ClaimExercised(claimId, c.beneficiary, amount);
    }

    // ============ Steward Functions ============

    /// @notice Steward: deploy operational budget (up to 1% of treasury balance monthly)
    function stewardSpend(address token, address recipient, uint256 amount) external onlySteward {
        require(recipient != address(0), "ArmadaTreasuryGov: zero address");
        require(amount > 0, "ArmadaTreasuryGov: zero amount");

        // Reset budget period if expired
        if (block.timestamp >= lastBudgetReset[token] + BUDGET_PERIOD) {
            budgetSpentThisPeriod[token] = 0;
            lastBudgetReset[token] = block.timestamp;
        }

        // Check budget limit: 1% of current treasury balance
        uint256 treasuryBalance = IERC20(token).balanceOf(address(this));
        uint256 monthlyBudget = (treasuryBalance * STEWARD_BUDGET_BPS) / 10000;
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
        return c.amount - c.exercised;
    }

    function getStewardBudget(address token) external view returns (uint256 budget, uint256 spent, uint256 remaining) {
        uint256 treasuryBalance = IERC20(token).balanceOf(address(this));
        budget = (treasuryBalance * STEWARD_BUDGET_BPS) / 10000;

        // Check if period has reset
        if (block.timestamp >= lastBudgetReset[token] + BUDGET_PERIOD) {
            spent = 0;
        } else {
            spent = budgetSpentThisPeriod[token];
        }
        remaining = budget > spent ? budget - spent : 0;
    }

    // ============ Receive ============

    receive() external payable {}
}
