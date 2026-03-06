// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./IArmadaCrowdfund.sol";

/// @title ArmadaCrowdfund — Word-of-mouth whitelist crowdfund with hop-based allocation
/// @notice Implements the full crowdfund lifecycle: seed management, invitation chains,
///         USDC commitment escrow, deterministic allocation with pro-rata scaling and rollover,
///         elastic expansion, and refund mechanism.
contract ArmadaCrowdfund is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    uint256 public constant BASE_SALE = 1_200_000 * 1e6;       // $1.2M USDC
    uint256 public constant MAX_SALE  = 1_800_000 * 1e6;       // $1.8M USDC
    uint256 public constant MIN_SALE  = 1_000_000 * 1e6;       // $1.0M USDC
    uint256 public constant ARM_PRICE = 1e6;                    // $1.00 per ARM in USDC
    uint256 public constant ELASTIC_TRIGGER = (BASE_SALE * 15) / 10; // 1.5 × BASE_SALE

    uint32 public constant HOP1_ROLLOVER_MIN = 30;  // min unique hop-1 committers for rollover
    uint32 public constant HOP2_ROLLOVER_MIN = 50;  // min unique hop-2 committers for rollover
    uint8 public constant NUM_HOPS = 3;

    uint256 public constant INVITATION_DURATION = 14 days;
    uint256 public constant COMMITMENT_DURATION = 7 days;
    uint256 public constant FINALIZE_GRACE_PERIOD = 30 days;
    uint256 public constant MIN_COMMIT = 10 * 1e6;               // $10 USDC minimum per commit

    // ============ Immutable ============

    IERC20 public immutable usdc;
    IERC20 public immutable armToken;
    address public immutable admin;
    /// @notice Protocol treasury — destination for sale proceeds and unallocated ARM.
    // TODO: Admin is immutable. For production, add an admin transfer function
    // so governance (timelock) can take over post-sale admin duties.
    // Tracked in Codeberg issue.
    address public immutable treasury;

    // ============ State ============
    Phase public phase;

    // Timing
    uint256 public invitationStart;
    uint256 public invitationEnd;
    uint256 public commitmentStart;
    uint256 public commitmentEnd;

    // Hop configuration (set in constructor)
    HopConfig[3] public hopConfigs;

    // Participant data
    mapping(address => Participant) public participants;
    address[] public participantList;

    // Aggregate stats
    HopStats[3] public hopStats;
    uint256 public totalCommitted;

    // Finalization results
    uint256 public saleSize;
    uint256 public totalAllocated;       // ARM (18 dec) — hop-level upper bound
    uint256 public totalAllocatedUsdc;   // USDC (6 dec) — hop-level upper bound
    uint256[3] public finalReserves;     // hop reserves after rollover (stored at finalization)
    uint256[3] public finalDemands;      // hop demands (stored at finalization)

    // Lazy evaluation accumulators (tracked during claims)
    uint256 public totalProceedsAccrued; // exact sum of allocUsdc from claims
    uint256 public totalArmClaimed;      // exact sum of allocArm from claims
    uint256 public proceedsWithdrawnAmount;
    bool public unallocatedArmWithdrawn;

    // ============ Events ============

    event SeedAdded(address indexed seed);
    event InvitationStarted(uint256 invitationEnd, uint256 commitmentStart, uint256 commitmentEnd);
    event Invited(address indexed inviter, address indexed invitee, uint8 hop);
    event Committed(address indexed participant, uint256 amount, uint256 totalForParticipant, uint8 hop);
    event SaleFinalized(uint256 saleSize, uint256 totalAllocUsdc, uint256 totalAllocArm, uint256 treasuryLeftoverUsdc);
    event SaleCanceled(uint256 totalCommitted);
    event Claimed(address indexed participant, uint256 armAmount, uint256 usdcRefund);
    event Refunded(address indexed participant, uint256 amount);
    event ProceedsWithdrawn(address indexed treasury, uint256 amount);
    event UnallocatedArmWithdrawn(address indexed treasury, uint256 amount);

    // ============ Modifiers ============

    modifier onlyAdmin() {
        require(msg.sender == admin, "ArmadaCrowdfund: not admin");
        _;
    }

    modifier inPhase(Phase _phase) {
        require(phase == _phase, "ArmadaCrowdfund: wrong phase");
        _;
    }

    // ============ Constructor ============

    constructor(address _usdc, address _armToken, address _admin, address _treasury) {
        require(_admin != address(0), "ArmadaCrowdfund: zero admin");
        require(_treasury != address(0), "ArmadaCrowdfund: zero treasury");
        usdc = IERC20(_usdc);
        armToken = IERC20(_armToken);
        admin = _admin;
        treasury = _treasury;
        phase = Phase.Setup;

        hopConfigs[0] = HopConfig({ reserveBps: 7000, capUsdc: 15_000 * 1e6, maxInvites: 3 });
        hopConfigs[1] = HopConfig({ reserveBps: 2500, capUsdc: 4_000 * 1e6,  maxInvites: 2 });
        hopConfigs[2] = HopConfig({ reserveBps: 500,  capUsdc: 1_000 * 1e6,  maxInvites: 0 });
    }

    // ============ Setup Phase ============

    /// @notice Add seed addresses (hop 0)
    function addSeeds(address[] calldata seeds) external onlyAdmin inPhase(Phase.Setup) {
        for (uint256 i = 0; i < seeds.length; i++) {
            _addSeed(seeds[i]);
        }
    }

    /// @notice Add a single seed address (hop 0)
    function addSeed(address seed) external onlyAdmin inPhase(Phase.Setup) {
        _addSeed(seed);
    }

    function _addSeed(address seed) internal {
        require(seed != address(0), "ArmadaCrowdfund: zero address");
        require(!participants[seed].isWhitelisted, "ArmadaCrowdfund: already whitelisted");

        participants[seed].hop = 0;
        participants[seed].isWhitelisted = true;
        // invitedBy defaults to address(0) for seeds
        participantList.push(seed);
        hopStats[0].whitelistCount++;

        emit SeedAdded(seed);
    }

    /// @notice Start the invitation window
    function startInvitations() external onlyAdmin inPhase(Phase.Setup) {
        require(hopStats[0].whitelistCount > 0, "ArmadaCrowdfund: no seeds");

        invitationStart = block.timestamp;
        invitationEnd = block.timestamp + INVITATION_DURATION;
        commitmentStart = invitationEnd;
        commitmentEnd = commitmentStart + COMMITMENT_DURATION;
        phase = Phase.Invitation;

        emit InvitationStarted(invitationEnd, commitmentStart, commitmentEnd);
    }

    // ============ Invitation Phase ============

    /// @notice Invite an address to participate at (your hop + 1)
    function invite(address invitee) external whenNotPaused {
        require(
            block.timestamp >= invitationStart && block.timestamp <= invitationEnd,
            "ArmadaCrowdfund: not invitation window"
        );

        Participant storage inviter = participants[msg.sender];
        require(inviter.isWhitelisted, "ArmadaCrowdfund: not whitelisted");

        uint8 inviterHop = inviter.hop;
        require(inviterHop < NUM_HOPS - 1, "ArmadaCrowdfund: max hop reached");
        require(
            inviter.invitesSent < hopConfigs[inviterHop].maxInvites,
            "ArmadaCrowdfund: invite limit reached"
        );
        require(invitee != address(0), "ArmadaCrowdfund: zero address");
        require(!participants[invitee].isWhitelisted, "ArmadaCrowdfund: already whitelisted");

        uint8 inviteeHop = inviterHop + 1;

        participants[invitee].hop = inviteeHop;
        participants[invitee].isWhitelisted = true;
        participants[invitee].invitedBy = msg.sender;
        participantList.push(invitee);

        inviter.invitesSent++;
        hopStats[inviteeHop].whitelistCount++;

        emit Invited(msg.sender, invitee, inviteeHop);
    }

    // ============ Commitment Phase ============

    /// @notice Commit USDC to the crowdfund
    function commit(uint256 amount) external nonReentrant whenNotPaused {
        require(
            block.timestamp >= commitmentStart && block.timestamp <= commitmentEnd,
            "ArmadaCrowdfund: not commitment window"
        );

        // Lazy phase transition: first commit advances phase from Invitation
        if (phase == Phase.Invitation) {
            phase = Phase.Commitment;
        }

        Participant storage p = participants[msg.sender];
        require(p.isWhitelisted, "ArmadaCrowdfund: not whitelisted");
        require(amount >= MIN_COMMIT, "ArmadaCrowdfund: below minimum commitment");

        uint8 hop = p.hop;
        require(
            p.committed + amount <= hopConfigs[hop].capUsdc,
            "ArmadaCrowdfund: exceeds hop cap"
        );

        bool firstCommit = (p.committed == 0);

        // CEI: update state before external call
        p.committed += amount;
        hopStats[hop].totalCommitted += amount;
        totalCommitted += amount;

        if (firstCommit) {
            hopStats[hop].uniqueCommitters++;
        }

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit Committed(msg.sender, amount, p.committed, hop);
    }

    // ============ Finalization ============

    /// @notice Anyone can cancel the sale if admin hasn't finalized within the grace period
    /// @dev Prevents permanent fund lockup if admin key is lost or admin is unresponsive
    function permissionlessCancel() external {
        require(
            phase == Phase.Invitation || phase == Phase.Commitment,
            "ArmadaCrowdfund: not in active phase"
        );
        require(
            block.timestamp > commitmentEnd + FINALIZE_GRACE_PERIOD,
            "ArmadaCrowdfund: grace period not elapsed"
        );
        phase = Phase.Canceled;
        emit SaleCanceled(totalCommitted);
    }

    /// @notice Finalize the crowdfund: compute allocations or cancel
    function finalize() external onlyAdmin nonReentrant {
        require(block.timestamp > commitmentEnd, "ArmadaCrowdfund: commitment not ended");
        require(
            phase == Phase.Invitation || phase == Phase.Commitment,
            "ArmadaCrowdfund: already finalized"
        );

        // Check minimum raise
        if (totalCommitted < MIN_SALE) {
            phase = Phase.Canceled;
            emit SaleCanceled(totalCommitted);
            return;
        }

        // Step 1: Elastic expansion
        if (totalCommitted >= ELASTIC_TRIGGER) {
            saleSize = MAX_SALE;
        } else {
            saleSize = BASE_SALE;
        }

        // Ensure contract holds enough ARM
        uint256 requiredArm = (saleSize * 1e18) / ARM_PRICE;
        require(
            armToken.balanceOf(address(this)) >= requiredArm,
            "ArmadaCrowdfund: insufficient ARM"
        );

        // Step 2: Per-hop allocation with sequential rollover
        uint256[3] memory reserves;
        uint256[3] memory demands;
        uint256 treasuryLeftover = 0;

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            reserves[h] = (saleSize * hopConfigs[h].reserveBps) / 10000;
            demands[h] = hopStats[h].totalCommitted;
        }

        // Process hops sequentially (0 → 1 → 2) with rollover
        for (uint8 h = 0; h < NUM_HOPS; h++) {
            if (demands[h] <= reserves[h]) {
                // Under-subscribed: full allocation, compute leftover
                uint256 hopLeftover = reserves[h] - demands[h];

                // Apply rollover rules
                if (h == 0) {
                    if (hopStats[1].uniqueCommitters >= HOP1_ROLLOVER_MIN) {
                        reserves[1] += hopLeftover;
                    } else {
                        treasuryLeftover += hopLeftover;
                    }
                } else if (h == 1) {
                    if (hopStats[2].uniqueCommitters >= HOP2_ROLLOVER_MIN) {
                        reserves[2] += hopLeftover;
                    } else {
                        treasuryLeftover += hopLeftover;
                    }
                } else {
                    treasuryLeftover += hopLeftover;
                }
            }
            // Over-subscribed: no leftover (all reserve used), no rollover
        }

        // Step 3: Store hop-level data for lazy evaluation in claim()
        // Individual allocations are computed on-the-fly in claim() and getAllocation()
        // using finalReserves[hop] and finalDemands[hop], making finalize() O(1).
        uint256 totalAllocUsdc_ = 0;
        uint256 totalAllocArm_ = 0;

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            finalReserves[h] = reserves[h];
            finalDemands[h] = demands[h];

            // Hop-level totals (upper bounds due to per-participant integer division)
            uint256 hopAlloc = demands[h] <= reserves[h] ? demands[h] : reserves[h];
            totalAllocUsdc_ += hopAlloc;
            totalAllocArm_ += (hopAlloc * 1e18) / ARM_PRICE;
        }

        totalAllocatedUsdc = totalAllocUsdc_;
        totalAllocated = totalAllocArm_;
        phase = Phase.Finalized;

        emit SaleFinalized(saleSize, totalAllocUsdc_, totalAllocArm_, treasuryLeftover);
    }

    // ============ Claims & Withdrawals ============

    /// @notice Claim ARM allocation and USDC refund after finalization
    /// @dev Allocation is computed lazily from stored hop-level reserves/demands
    function claim() external nonReentrant {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");

        Participant storage p = participants[msg.sender];
        require(p.committed > 0, "ArmadaCrowdfund: no commitment");
        require(!p.claimed, "ArmadaCrowdfund: already claimed");

        (uint256 allocArm, uint256 allocUsdc, uint256 refundUsdc) = _computeAllocation(p.committed, p.hop);

        p.claimed = true;
        p.allocation = allocArm;    // store for record-keeping
        p.refund = refundUsdc;      // store for record-keeping
        totalProceedsAccrued += allocUsdc;
        totalArmClaimed += allocArm;

        if (allocArm > 0) {
            armToken.safeTransfer(msg.sender, allocArm);
        }
        if (refundUsdc > 0) {
            usdc.safeTransfer(msg.sender, refundUsdc);
        }

        emit Claimed(msg.sender, allocArm, refundUsdc);
    }

    /// @notice Full USDC refund if sale was canceled (below minimum)
    function refund() external nonReentrant {
        require(phase == Phase.Canceled, "ArmadaCrowdfund: not canceled");

        Participant storage p = participants[msg.sender];
        require(p.committed > 0, "ArmadaCrowdfund: no commitment");
        require(!p.claimed, "ArmadaCrowdfund: already refunded");

        p.claimed = true;
        uint256 amount = p.committed;

        usdc.safeTransfer(msg.sender, amount);

        emit Refunded(msg.sender, amount);
    }

    /// @notice Admin withdraws USDC sale proceeds to treasury
    /// @dev Proceeds accrue as participants claim. Can be called multiple times.
    function withdrawProceeds() external onlyAdmin nonReentrant {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");

        uint256 available = totalProceedsAccrued - proceedsWithdrawnAmount;
        require(available > 0, "ArmadaCrowdfund: no proceeds");

        proceedsWithdrawnAmount += available;
        usdc.safeTransfer(treasury, available);

        emit ProceedsWithdrawn(treasury, available);
    }

    /// @notice Admin withdraws unallocated ARM tokens to treasury
    /// @dev Uses hop-level totalAllocated (upper bound) minus claimed ARM to compute unallocated.
    ///      Safe: unallocated = initialFunding - totalAllocated_upper >= 0.
    function withdrawUnallocatedArm() external onlyAdmin nonReentrant {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        require(!unallocatedArmWithdrawn, "ArmadaCrowdfund: already withdrawn");

        unallocatedArmWithdrawn = true;
        uint256 armBalance = armToken.balanceOf(address(this));
        uint256 armStillOwed = totalAllocated - totalArmClaimed;
        uint256 unallocated = armBalance - armStillOwed;

        if (unallocated > 0) {
            armToken.safeTransfer(treasury, unallocated);
        }

        emit UnallocatedArmWithdrawn(treasury, unallocated);
    }

    // ============ Emergency Pause ============

    /// @notice Admin pauses invite() and commit() in case of emergency
    function pause() external onlyAdmin {
        _pause();
    }

    /// @notice Admin unpauses to resume normal operations
    function unpause() external onlyAdmin {
        _unpause();
    }

    // ============ View Functions ============

    /// @notice Get aggregate stats for a hop (visible during sale)
    function getHopStats(uint8 hop) external view returns (
        uint256 _totalCommitted,
        uint32 _uniqueCommitters,
        uint32 _whitelistCount
    ) {
        require(hop < NUM_HOPS, "ArmadaCrowdfund: invalid hop");
        HopStats storage s = hopStats[hop];
        return (s.totalCommitted, s.uniqueCommitters, s.whitelistCount);
    }

    /// @notice Get overall sale stats
    function getSaleStats() external view returns (
        uint256 _totalCommitted,
        Phase _phase,
        uint256 _invitationEnd,
        uint256 _commitmentEnd
    ) {
        return (totalCommitted, phase, invitationEnd, commitmentEnd);
    }

    /// @notice Check if an address is whitelisted
    function isWhitelisted(address addr) external view returns (bool) {
        return participants[addr].isWhitelisted;
    }

    /// @notice Get commitment details for an address
    function getCommitment(address addr) external view returns (uint256 committed, uint8 hop) {
        Participant storage p = participants[addr];
        return (p.committed, p.hop);
    }

    /// @notice Get remaining invites for an address
    function getInvitesRemaining(address addr) external view returns (uint8) {
        Participant storage p = participants[addr];
        if (!p.isWhitelisted) return 0;
        uint8 maxInv = hopConfigs[p.hop].maxInvites;
        if (p.invitesSent >= maxInv) return 0;
        return maxInv - p.invitesSent;
    }

    /// @notice Get invite edge (only after finalization — graph hidden during sale)
    function getInviteEdge(address invitee) external view returns (address inviter, uint8 hop) {
        require(
            phase == Phase.Finalized || phase == Phase.Canceled,
            "ArmadaCrowdfund: graph hidden during sale"
        );
        Participant storage p = participants[invitee];
        return (p.invitedBy, p.hop);
    }

    /// @notice Get allocation details (only after finalization)
    /// @dev Computes allocation on the fly from stored hop-level data if not yet claimed
    function getAllocation(address addr) external view returns (
        uint256 allocation,
        uint256 _refund,
        bool claimed
    ) {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        Participant storage p = participants[addr];
        if (p.claimed) {
            return (p.allocation, p.refund, true);
        }
        (uint256 allocArm, , uint256 refundUsdc) = _computeAllocation(p.committed, p.hop);
        return (allocArm, refundUsdc, false);
    }

    /// @notice Get total number of participants (whitelisted addresses)
    function getParticipantCount() external view returns (uint256) {
        return participantList.length;
    }

    // ============ Internal ============

    /// @dev Compute allocation for a participant from stored hop-level reserves/demands.
    ///      Identical math to the original finalize() loop, but evaluated lazily.
    function _computeAllocation(uint256 committed, uint8 hop) internal view returns (
        uint256 allocArm,
        uint256 allocUsdc,
        uint256 refundUsdc
    ) {
        if (committed == 0) return (0, 0, 0);

        if (finalDemands[hop] <= finalReserves[hop]) {
            // Under-subscribed: full allocation
            allocUsdc = committed;
            allocArm = (committed * 1e18) / ARM_PRICE;
        } else {
            // Over-subscribed: pro-rata
            allocUsdc = (committed * finalReserves[hop]) / finalDemands[hop];
            // Compute ARM directly to avoid divide-before-multiply precision loss
            allocArm = (committed * finalReserves[hop] * 1e18) / (finalDemands[hop] * ARM_PRICE);
        }
        refundUsdc = committed - allocUsdc;
    }
}
