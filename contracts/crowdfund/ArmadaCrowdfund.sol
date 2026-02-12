// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./IArmadaCrowdfund.sol";

/// @title ArmadaCrowdfund — Word-of-mouth whitelist crowdfund with hop-based allocation
/// @notice Implements the full crowdfund lifecycle: seed management, invitation chains,
///         USDC commitment escrow, deterministic allocation with pro-rata scaling and rollover,
///         elastic expansion, and refund mechanism.
contract ArmadaCrowdfund is ReentrancyGuard {
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

    // ============ Immutable ============

    IERC20 public immutable usdc;
    IERC20 public immutable armToken;

    // ============ State ============

    address public admin;
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
    uint256 public totalAllocated;       // ARM (18 dec)
    uint256 public totalAllocatedUsdc;   // USDC (6 dec)
    bool public proceedsWithdrawn;
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

    constructor(address _usdc, address _armToken, address _admin) {
        usdc = IERC20(_usdc);
        armToken = IERC20(_armToken);
        admin = _admin;
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
    function invite(address invitee) external {
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
    function commit(uint256 amount) external nonReentrant {
        require(
            block.timestamp >= commitmentStart && block.timestamp <= commitmentEnd,
            "ArmadaCrowdfund: not commitment window"
        );

        Participant storage p = participants[msg.sender];
        require(p.isWhitelisted, "ArmadaCrowdfund: not whitelisted");
        require(amount > 0, "ArmadaCrowdfund: zero amount");

        uint8 hop = p.hop;
        require(
            p.committed + amount <= hopConfigs[hop].capUsdc,
            "ArmadaCrowdfund: exceeds hop cap"
        );

        bool firstCommit = (p.committed == 0);

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        p.committed += amount;
        hopStats[hop].totalCommitted += amount;
        totalCommitted += amount;

        if (firstCommit) {
            hopStats[hop].uniqueCommitters++;
        }

        emit Committed(msg.sender, amount, p.committed, hop);
    }

    // ============ Finalization ============

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

        // Step 3: Compute individual allocations
        uint256 totalAllocUsdc_ = 0;
        uint256 totalAllocArm_ = 0;

        for (uint256 i = 0; i < participantList.length; i++) {
            address addr = participantList[i];
            Participant storage p = participants[addr];

            if (p.committed == 0) continue;

            uint8 h = p.hop;
            uint256 allocUsdc;

            if (demands[h] <= reserves[h]) {
                allocUsdc = p.committed; // full allocation
            } else {
                // Pro-rata: allocUsdc = (committed * reserve) / demand
                allocUsdc = (p.committed * reserves[h]) / demands[h];
            }

            uint256 allocArm = (allocUsdc * 1e18) / ARM_PRICE;
            p.allocation = allocArm;
            p.refund = p.committed - allocUsdc;

            totalAllocUsdc_ += allocUsdc;
            totalAllocArm_ += allocArm;
        }

        totalAllocatedUsdc = totalAllocUsdc_;
        totalAllocated = totalAllocArm_;
        phase = Phase.Finalized;

        emit SaleFinalized(saleSize, totalAllocUsdc_, totalAllocArm_, treasuryLeftover);
    }

    // ============ Claims & Withdrawals ============

    /// @notice Claim ARM allocation and USDC refund after finalization
    function claim() external nonReentrant {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");

        Participant storage p = participants[msg.sender];
        require(p.committed > 0, "ArmadaCrowdfund: no commitment");
        require(!p.claimed, "ArmadaCrowdfund: already claimed");

        p.claimed = true;

        if (p.allocation > 0) {
            armToken.safeTransfer(msg.sender, p.allocation);
        }
        if (p.refund > 0) {
            usdc.safeTransfer(msg.sender, p.refund);
        }

        emit Claimed(msg.sender, p.allocation, p.refund);
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
    function withdrawProceeds(address treasury) external onlyAdmin {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        require(treasury != address(0), "ArmadaCrowdfund: zero address");
        require(!proceedsWithdrawn, "ArmadaCrowdfund: already withdrawn");

        proceedsWithdrawn = true;
        usdc.safeTransfer(treasury, totalAllocatedUsdc);

        emit ProceedsWithdrawn(treasury, totalAllocatedUsdc);
    }

    /// @notice Admin withdraws unallocated ARM tokens to treasury
    function withdrawUnallocatedArm(address treasury) external onlyAdmin {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        require(treasury != address(0), "ArmadaCrowdfund: zero address");
        require(!unallocatedArmWithdrawn, "ArmadaCrowdfund: already withdrawn");

        unallocatedArmWithdrawn = true;
        uint256 armBalance = armToken.balanceOf(address(this));
        uint256 unallocated = armBalance - totalAllocated;

        if (unallocated > 0) {
            armToken.safeTransfer(treasury, unallocated);
        }

        emit UnallocatedArmWithdrawn(treasury, unallocated);
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
    function getAllocation(address addr) external view returns (
        uint256 allocation,
        uint256 _refund,
        bool claimed
    ) {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        Participant storage p = participants[addr];
        return (p.allocation, p.refund, p.claimed);
    }

    /// @notice Get total number of participants (whitelisted addresses)
    function getParticipantCount() external view returns (uint256) {
        return participantList.length;
    }
}
