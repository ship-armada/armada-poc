// ABOUTME: Word-of-mouth whitelist crowdfund with hop-based allocation.
// ABOUTME: Implements overlapping ceilings, hop-2 floor, elastic expansion, and pro-rata refunds.

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
    uint256 public constant HOP2_FLOOR_BPS = 500;  // 5% of saleSize reserved for hop-2

    uint256 public constant INVITATION_DURATION = 14 days;
    uint256 public constant COMMITMENT_DURATION = 7 days;
    uint256 public constant FINALIZE_GRACE_PERIOD = 30 days;
    uint256 public constant MIN_COMMIT = 10 * 1e6;               // $10 USDC minimum per commit
    uint16 public constant MAX_INVITES_RECEIVED = 10;            // cap on invite stacking per (address, hop) node

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

    // Participant data — keyed by (address, hop). Same address may appear at multiple hops.
    mapping(address => mapping(uint8 => Participant)) public participants;
    ParticipantNode[] public participantNodes;

    // Aggregate stats
    HopStats[3] public hopStats;
    uint256 public totalCommitted;

    // Finalization results
    uint256 public saleSize;
    uint256 public totalAllocated;       // ARM (18 dec) — hop-level upper bound
    uint256 public totalAllocatedUsdc;   // USDC (6 dec) — hop-level upper bound
    uint256[3] public finalCeilings;     // budget-capped hop ceilings (stored at finalization)
    uint256[3] public finalDemands;      // hop demands (stored at finalization)
    uint256 public treasuryLeftoverUsdc; // USDC (6 dec) — unallocated reserve that goes to treasury

    // Lazy evaluation accumulators (tracked during claims)
    uint256 public totalProceedsAccrued; // exact sum of allocUsdc from claims
    uint256 public totalArmClaimed;      // exact sum of allocArm from claims
    uint256 public proceedsWithdrawnAmount;
    bool public unallocatedArmWithdrawn;

    // ============ Events ============

    event SeedAdded(address indexed seed);
    event InvitationStarted(uint256 invitationEnd, uint256 commitmentStart, uint256 commitmentEnd);
    event Invited(address indexed inviter, address indexed invitee, uint8 hop);
    event InviteAdded(address indexed inviter, address indexed invitee, uint8 hop, uint16 newInviteCount);
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

        hopConfigs[0] = HopConfig({ ceilingBps: 7000, capUsdc: 15_000 * 1e6, maxInvites: 3 });
        hopConfigs[1] = HopConfig({ ceilingBps: 4500, capUsdc: 4_000 * 1e6,  maxInvites: 2 });
        hopConfigs[2] = HopConfig({ ceilingBps: 1000, capUsdc: 1_000 * 1e6,  maxInvites: 0 });
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
        require(!participants[seed][0].isWhitelisted, "ArmadaCrowdfund: already whitelisted");

        participants[seed][0].isWhitelisted = true;
        participants[seed][0].invitesReceived = 1;
        // invitedBy defaults to address(0) for seeds
        participantNodes.push(ParticipantNode(seed, 0));
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

    /// @notice Invite an address to participate at (inviterHop + 1).
    ///         Re-inviting an already-whitelisted (invitee, hop) node increments its
    ///         invitesReceived counter, scaling its cap and outgoing invite budget.
    /// @param invitee Address to invite
    /// @param inviterHop Which of the caller's hop-level nodes is doing the inviting
    function invite(address invitee, uint8 inviterHop) external whenNotPaused {
        require(
            block.timestamp >= invitationStart && block.timestamp < invitationEnd,
            "ArmadaCrowdfund: not invitation window"
        );

        Participant storage inviter = participants[msg.sender][inviterHop];
        require(inviter.isWhitelisted, "ArmadaCrowdfund: not whitelisted");
        require(inviterHop < NUM_HOPS - 1, "ArmadaCrowdfund: max hop reached");
        // Scaled invite budget: invitesReceived * maxInvites for this hop
        uint16 maxBudget = inviter.invitesReceived * uint16(hopConfigs[inviterHop].maxInvites);
        require(
            inviter.invitesSent < maxBudget,
            "ArmadaCrowdfund: invite limit reached"
        );
        require(invitee != address(0), "ArmadaCrowdfund: zero address");

        uint8 inviteeHop = inviterHop + 1;
        Participant storage inviteeNode = participants[invitee][inviteeHop];

        if (!inviteeNode.isWhitelisted) {
            // First invite to this (address, hop) — whitelist the node
            inviteeNode.isWhitelisted = true;
            inviteeNode.invitesReceived = 1;
            inviteeNode.invitedBy = msg.sender;
            participantNodes.push(ParticipantNode(invitee, inviteeHop));
            hopStats[inviteeHop].whitelistCount++;

            emit Invited(msg.sender, invitee, inviteeHop);
        } else {
            // Subsequent invite — increment counter (scales cap + outgoing budget)
            // TODO: MAX_INVITES_RECEIVED = 10 is a placeholder — revisit after modeling
            // expected invite patterns and desired cap concentration limits.
            require(
                inviteeNode.invitesReceived < MAX_INVITES_RECEIVED,
                "ArmadaCrowdfund: max invites received"
            );
            inviteeNode.invitesReceived++;

            emit InviteAdded(msg.sender, invitee, inviteeHop, inviteeNode.invitesReceived);
        }

        inviter.invitesSent++;
    }

    // ============ Commitment Phase ============

    /// @notice Commit USDC to the crowdfund at a specific hop level
    /// @param amount USDC amount to commit (6 decimals)
    /// @param hop Which of the caller's (address, hop) nodes to commit to
    function commit(uint256 amount, uint8 hop) external nonReentrant whenNotPaused {
        require(
            block.timestamp >= commitmentStart && block.timestamp <= commitmentEnd,
            "ArmadaCrowdfund: not commitment window"
        );

        // Lazy phase transition: first commit advances phase from Invitation
        if (phase == Phase.Invitation) {
            phase = Phase.Commitment;
        }

        require(hop < NUM_HOPS, "ArmadaCrowdfund: invalid hop");
        Participant storage p = participants[msg.sender][hop];
        require(p.isWhitelisted, "ArmadaCrowdfund: not whitelisted");
        require(amount >= MIN_COMMIT, "ArmadaCrowdfund: below minimum commitment");

        // Invite-scaling cap: invitesReceived * per-slot cap
        uint256 effectiveCap = uint256(p.invitesReceived) * hopConfigs[hop].capUsdc;
        require(
            p.committed + amount <= effectiveCap,
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

        // Step 2: Per-hop allocation with overlapping ceilings and global budget constraint
        //
        // Hop-2 floor is reserved off the top. Hop-0/hop-1 ceilings are applied against
        // the net raise (saleSize minus floor). Ceilings overlap (sum > 100%) so a global
        // budget constraint (remaining) ensures total allocation never exceeds saleSize.

        uint256 hop2Floor = (saleSize * HOP2_FLOOR_BPS) / 10000;
        uint256 netRaise = saleSize - hop2Floor;

        // Base ceilings: hop 0/1 against netRaise, hop 2 against full saleSize
        uint256[3] memory effectiveCeilings;
        effectiveCeilings[0] = (netRaise * hopConfigs[0].ceilingBps) / 10000;
        effectiveCeilings[1] = (netRaise * hopConfigs[1].ceilingBps) / 10000;
        effectiveCeilings[2] = (saleSize * hopConfigs[2].ceilingBps) / 10000;

        uint256[3] memory demands;
        uint256 remaining = netRaise;  // hops 0/1 compete for netRaise only
        uint256 totalAllocUsdc_ = 0;
        uint256 totalAllocArm_ = 0;

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            demands[h] = hopStats[h].totalCommitted;

            // When we reach hop 2, add back the floor reservation to the remaining budget
            if (h == 2) {
                remaining += hop2Floor;
            }

            // Global budget constraint: cap effective ceiling against remaining supply
            uint256 ceiling = effectiveCeilings[h] < remaining ? effectiveCeilings[h] : remaining;

            uint256 allocated = demands[h] <= ceiling ? demands[h] : ceiling;
            remaining -= allocated;

            // Store budget-capped ceiling for lazy evaluation in claim() and getAllocation()
            finalCeilings[h] = ceiling;
            finalDemands[h] = demands[h];

            totalAllocUsdc_ += allocated;
            totalAllocArm_ += (allocated * 1e18) / ARM_PRICE;

            // Rollover: unused ceiling capacity flows to the next hop
            uint256 leftover = ceiling - allocated;
            if (leftover > 0) {
                if (h == 0 && hopStats[1].uniqueCommitters >= HOP1_ROLLOVER_MIN) {
                    effectiveCeilings[1] += leftover;
                } else if (h == 1 && hopStats[2].uniqueCommitters >= HOP2_ROLLOVER_MIN) {
                    effectiveCeilings[2] += leftover;
                }
                // If not rolled over, leftover remains in the budget pool (remaining)
                // and becomes part of treasuryLeftoverUsdc at the end
            }
        }

        totalAllocatedUsdc = totalAllocUsdc_;
        totalAllocated = totalAllocArm_;
        treasuryLeftoverUsdc = saleSize - totalAllocUsdc_;
        phase = Phase.Finalized;

        emit SaleFinalized(saleSize, totalAllocUsdc_, totalAllocArm_, treasuryLeftoverUsdc);
    }

    // ============ Claims & Withdrawals ============

    /// @notice Claim ARM allocation and USDC refund after finalization.
    ///         Aggregates across all hops where the caller has committed.
    /// @dev Allocation is computed lazily from stored hop-level reserves/demands
    function claim() external nonReentrant {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");

        uint256 totalAllocArm = 0;
        uint256 totalAllocUsdc = 0;
        uint256 totalRefundUsdc = 0;
        bool hasCommitment = false;

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            Participant storage p = participants[msg.sender][h];
            if (p.committed == 0) continue;

            hasCommitment = true;
            require(!p.claimed, "ArmadaCrowdfund: already claimed");

            (uint256 allocArm, uint256 allocUsdc, uint256 refundUsdc) = _computeAllocation(p.committed, h);

            p.claimed = true;
            p.allocation = allocArm;    // store for record-keeping
            p.refund = refundUsdc;      // store for record-keeping

            totalAllocArm += allocArm;
            totalAllocUsdc += allocUsdc;
            totalRefundUsdc += refundUsdc;
        }

        require(hasCommitment, "ArmadaCrowdfund: no commitment");

        totalProceedsAccrued += totalAllocUsdc;
        totalArmClaimed += totalAllocArm;

        if (totalAllocArm > 0) {
            armToken.safeTransfer(msg.sender, totalAllocArm);
        }
        if (totalRefundUsdc > 0) {
            usdc.safeTransfer(msg.sender, totalRefundUsdc);
        }

        emit Claimed(msg.sender, totalAllocArm, totalRefundUsdc);
    }

    /// @notice Full USDC refund if sale was canceled (below minimum).
    ///         Aggregates across all hops where the caller has committed.
    function refund() external nonReentrant {
        require(phase == Phase.Canceled, "ArmadaCrowdfund: not canceled");

        uint256 totalAmount = 0;
        bool hasCommitment = false;

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            Participant storage p = participants[msg.sender][h];
            if (p.committed == 0) continue;

            hasCommitment = true;
            require(!p.claimed, "ArmadaCrowdfund: already refunded");

            p.claimed = true;
            totalAmount += p.committed;
        }

        require(hasCommitment, "ArmadaCrowdfund: no commitment");

        usdc.safeTransfer(msg.sender, totalAmount);

        emit Refunded(msg.sender, totalAmount);
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
        require(
            phase == Phase.Finalized || phase == Phase.Canceled,
            "ArmadaCrowdfund: not finalized or canceled"
        );
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

    /// @notice Check if an address is whitelisted at a specific hop
    function isWhitelisted(address addr, uint8 hop) external view returns (bool) {
        return participants[addr][hop].isWhitelisted;
    }

    /// @notice Get commitment for an address at a specific hop
    function getCommitment(address addr, uint8 hop) external view returns (uint256 committed) {
        return participants[addr][hop].committed;
    }

    /// @notice Get remaining invites for an address at a specific hop (scaled by invitesReceived)
    function getInvitesRemaining(address addr, uint8 hop) external view returns (uint16) {
        Participant storage p = participants[addr][hop];
        if (!p.isWhitelisted) return 0;
        uint16 maxBudget = p.invitesReceived * uint16(hopConfigs[hop].maxInvites);
        if (p.invitesSent >= maxBudget) return 0;
        return maxBudget - p.invitesSent;
    }

    /// @notice Get invite edge for an (address, hop) node — visible at all times
    function getInviteEdge(address invitee, uint8 hop) external view returns (address inviter) {
        return participants[invitee][hop].invitedBy;
    }

    /// @notice Get aggregate allocation across all hops (only after finalization)
    /// @dev Computes allocation on the fly from stored hop-level data if not yet claimed
    function getAllocation(address addr) external view returns (
        uint256 allocation,
        uint256 _refund,
        bool claimed
    ) {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");

        uint256 totalAllocArm = 0;
        uint256 totalRefundUsdc = 0;
        bool anyClaimed = false;
        bool anyCommitted = false;

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            Participant storage p = participants[addr][h];
            if (p.committed == 0) continue;
            anyCommitted = true;

            if (p.claimed) {
                anyClaimed = true;
                totalAllocArm += p.allocation;
                totalRefundUsdc += p.refund;
            } else {
                (uint256 allocArm, , uint256 refundUsdc) = _computeAllocation(p.committed, h);
                totalAllocArm += allocArm;
                totalRefundUsdc += refundUsdc;
            }
        }

        return (totalAllocArm, totalRefundUsdc, anyClaimed);
    }

    /// @notice Get allocation at a specific hop (only after finalization)
    function getAllocationAtHop(address addr, uint8 hop) external view returns (
        uint256 allocation,
        uint256 _refund,
        bool claimed
    ) {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        Participant storage p = participants[addr][hop];
        if (p.claimed) {
            return (p.allocation, p.refund, true);
        }
        (uint256 allocArm, , uint256 refundUsdc) = _computeAllocation(p.committed, hop);
        return (allocArm, refundUsdc, false);
    }

    /// @notice Get effective cap for an address at a hop (invitesReceived * per-slot cap)
    function getEffectiveCap(address addr, uint8 hop) external view returns (uint256) {
        Participant storage p = participants[addr][hop];
        if (!p.isWhitelisted) return 0;
        return uint256(p.invitesReceived) * hopConfigs[hop].capUsdc;
    }

    /// @notice Get number of invites received at a specific hop
    function getInvitesReceived(address addr, uint8 hop) external view returns (uint16) {
        return participants[addr][hop].invitesReceived;
    }

    /// @notice Get total number of (address, hop) nodes (not unique addresses)
    function getParticipantCount() external view returns (uint256) {
        return participantNodes.length;
    }

    // ============ Internal ============

    /// @dev Compute allocation for a participant from stored hop-level ceilings/demands.
    ///      Uses the budget-capped ceiling stored at finalization for pro-rata scaling.
    function _computeAllocation(uint256 committed, uint8 hop) internal view returns (
        uint256 allocArm,
        uint256 allocUsdc,
        uint256 refundUsdc
    ) {
        if (committed == 0) return (0, 0, 0);

        if (finalDemands[hop] <= finalCeilings[hop]) {
            // Under-subscribed: full allocation
            allocUsdc = committed;
            allocArm = (committed * 1e18) / ARM_PRICE;
        } else {
            // Over-subscribed: pro-rata
            allocUsdc = (committed * finalCeilings[hop]) / finalDemands[hop];
            // Compute ARM directly to avoid divide-before-multiply precision loss
            allocArm = (committed * finalCeilings[hop] * 1e18) / (finalDemands[hop] * ARM_PRICE);
        }
        refundUsdc = committed - allocUsdc;
    }
}
