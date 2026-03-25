// ABOUTME: Word-of-mouth whitelist crowdfund with hop-based allocation.
// ABOUTME: Implements overlapping ceilings, hop-2 floor, elastic expansion, and pro-rata refunds.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "./IArmadaCrowdfund.sol";

/// @title ArmadaCrowdfund — Word-of-mouth whitelist crowdfund with hop-based allocation
/// @notice Implements the full crowdfund lifecycle: seed management, invitation chains,
///         USDC commitment escrow, deterministic allocation with pro-rata scaling and rollover,
///         elastic expansion, and refund mechanism.
contract ArmadaCrowdfund is ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    uint256 public constant BASE_SALE = 1_200_000 * 1e6;       // $1.2M USDC
    uint256 public constant MAX_SALE  = 1_800_000 * 1e6;       // $1.8M USDC
    uint256 public constant MIN_SALE  = 1_000_000 * 1e6;       // $1.0M USDC
    uint256 public constant ARM_PRICE = 1e6;                    // $1.00 per ARM in USDC
    uint256 public constant ELASTIC_TRIGGER = 1_500_000 * 1e6;  // $1.5M capped demand triggers expansion
    uint8 public constant NUM_HOPS = 3;
    uint256 public constant HOP2_FLOOR_BPS = 500;  // 5% of saleSize reserved for hop-2

    uint256 public constant WINDOW_DURATION = 21 days;
    uint256 public constant LAUNCH_TEAM_INVITE_PERIOD = 7 days;
    uint256 public constant CLAIM_DEADLINE_DURATION = 1095 days; // 3 years
    uint256 public constant MIN_COMMIT = 10 * 1e6;               // $10 USDC minimum per commit
    // Per-hop invite stacking caps are stored in hopConfigs[].maxInvitesReceived (1, 10, 20)
    uint8 public constant MAX_SEEDS = 150;                       // max number of seeds (hop-0 participants)
    uint8 public constant LAUNCH_TEAM_HOP1_BUDGET = 60;          // launch team direct hop-1 invite slots
    uint8 public constant LAUNCH_TEAM_HOP2_BUDGET = 60;          // launch team direct hop-2 invite slots

    // EIP-712 typehash for off-chain invite signatures
    bytes32 public constant INVITE_TYPEHASH = keccak256(
        "Invite(address invitee,uint8 fromHop,uint256 nonce,uint256 deadline)"
    );

    // ============ Immutable ============

    IERC20 public immutable usdc;
    IERC20 public immutable armToken;
    /// @notice Protocol treasury — destination for sale proceeds and unallocated ARM.
    address public immutable treasury;
    /// @notice Launch team sentinel — issues predeclared invite budgets, not a participant.
    address public immutable launchTeam;
    /// @notice Security council multisig — can cancel the sale at any pre-finalization phase.
    address public immutable securityCouncil;

    // ============ State ============
    Phase public phase;

    // Timing
    uint256 public windowStart;
    uint256 public windowEnd;
    uint256 public launchTeamInviteEnd;

    // Hop configuration (set in constructor)
    HopConfig[3] public hopConfigs;

    // Participant data — keyed by (address, hop). Same address may appear at multiple hops.
    mapping(address => mapping(uint8 => Participant)) public participants;
    ParticipantNode[] public participantNodes;

    // Aggregate stats
    HopStats[3] public hopStats;
    uint256 public totalCommitted;
    uint256 public cappedDemand;    // sum of capped deposits (set at finalization)

    // Finalization results
    uint256 public saleSize;
    uint256 public totalAllocated;       // ARM (18 dec) — hop-level upper bound
    uint256 public totalAllocatedUsdc;   // USDC (6 dec) — hop-level upper bound
    uint256[3] public finalCeilings;     // budget-capped hop ceilings (stored at finalization)
    uint256[3] public finalDemands;      // hop demands (stored at finalization)
    uint256 public treasuryLeftoverUsdc; // USDC (6 dec) — unallocated reserve that goes to treasury

    // Lazy evaluation accumulators (tracked during claims)
    uint256 public totalArmClaimed;      // exact sum of allocArm from claims

    // Claim deadline — set at finalization, after which unclaimed ARM is sweepable
    uint256 public claimDeadline;

    // Launch team invite budget tracking
    uint8 public launchTeamHop1Used;
    uint8 public launchTeamHop2Used;

    // ARM pre-load verification
    bool public armLoaded;

    // Post-allocation minimum raise check: true when finalize() ran but
    // net proceeds fell below MIN_SALE. All USDC is refundable via claimRefund().
    bool public refundMode;

    // Timestamp when finalize() was called — used by ArmadaGovernor for the
    // 7-day governance quiet period. Set on both normal and refundMode paths.
    uint256 public finalizedAt;

    // EIP-712 invite nonce tracking — used/revoked nonces per inviter
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    // ============ Events ============

    event SeedAdded(address indexed seed);
    event Invited(address indexed inviter, address indexed invitee, uint8 hop, uint256 nonce);
    event InviteAdded(address indexed inviter, address indexed invitee, uint8 hop, uint16 newInviteCount);
    event Committed(address indexed participant, uint256 amount, uint256 totalForParticipant, uint8 hop);
    event SaleFinalized(uint256 saleSize, uint256 totalAllocUsdc, uint256 totalAllocArm, uint256 treasuryLeftoverUsdc);
    event SaleCanceled(uint256 totalCommitted);
    event ArmClaimed(address indexed participant, uint256 armAmount, address delegate);
    event RefundClaimed(address indexed participant, uint256 usdcAmount);
    event UnallocatedArmWithdrawn(address indexed treasury, uint256 amount);
    event ArmLoaded(uint256 balance);
    event SaleFinalizedRefundMode(uint256 totalCommitted, uint256 netProceeds);
    event InviteNonceRevoked(address indexed inviter, uint256 nonce);

    // ============ Modifiers ============

    modifier onlyLaunchTeam() {
        require(msg.sender == launchTeam, "ArmadaCrowdfund: not launch team");
        _;
    }

    // ============ Constructor ============

    /// @param _openTimestamp When the 3-week active window begins (must be >= block.timestamp)
    constructor(
        address _usdc,
        address _armToken,
        address _treasury,
        address _launchTeam,
        address _securityCouncil,
        uint256 _openTimestamp
    ) EIP712("ArmadaCrowdfund", "1") {
        require(_treasury != address(0), "ArmadaCrowdfund: zero treasury");
        require(_launchTeam != address(0), "ArmadaCrowdfund: zero launchTeam");
        require(_securityCouncil != address(0), "ArmadaCrowdfund: zero securityCouncil");
        require(_openTimestamp >= block.timestamp, "ArmadaCrowdfund: openTimestamp in past");
        usdc = IERC20(_usdc);
        armToken = IERC20(_armToken);
        treasury = _treasury;
        launchTeam = _launchTeam;
        securityCouncil = _securityCouncil;

        windowStart = _openTimestamp;
        windowEnd = _openTimestamp + WINDOW_DURATION;
        launchTeamInviteEnd = _openTimestamp + LAUNCH_TEAM_INVITE_PERIOD;
        // phase defaults to Phase.Active (value 0)

        hopConfigs[0] = HopConfig({ ceilingBps: 7000, capUsdc: 15_000 * 1e6, maxInvites: 3, maxInvitesReceived: 1 });
        hopConfigs[1] = HopConfig({ ceilingBps: 4500, capUsdc: 4_000 * 1e6,  maxInvites: 2, maxInvitesReceived: 10 });
        hopConfigs[2] = HopConfig({ ceilingBps: 0,    capUsdc: 1_000 * 1e6,  maxInvites: 0, maxInvitesReceived: 20 });
    }

    // ============ Seed Management ============

    /// @notice Add seed addresses (hop 0). Allowed before invite period ends (requires ARM loaded).
    function addSeeds(address[] calldata seeds) external onlyLaunchTeam {
        _requireArmLoadedAndPreInviteEnd();
        for (uint256 i = 0; i < seeds.length; i++) {
            _addSeed(seeds[i]);
        }
    }

    /// @notice Add a single seed address (hop 0). Allowed before invite period ends (requires ARM loaded).
    function addSeed(address seed) external onlyLaunchTeam {
        _requireArmLoadedAndPreInviteEnd();
        _addSeed(seed);
    }

    function _addSeed(address seed) internal {
        require(seed != address(0), "ArmadaCrowdfund: zero address");
        require(hopStats[0].whitelistCount < MAX_SEEDS, "ArmadaCrowdfund: seed cap reached");
        require(!participants[seed][0].isWhitelisted, "ArmadaCrowdfund: already whitelisted");

        participants[seed][0].isWhitelisted = true;
        participants[seed][0].invitesReceived = 1;
        // invitedBy defaults to address(0) for seeds
        participantNodes.push(ParticipantNode(seed, 0));
        hopStats[0].whitelistCount++;

        emit SeedAdded(seed);
    }

    /// @notice Verify the contract holds sufficient ARM for the maximum possible sale.
    ///         Permissionless. Idempotent: no-op if already loaded.
    function loadArm() external {
        if (armLoaded) return;

        uint256 requiredArm = (MAX_SALE * 1e18) / ARM_PRICE;
        uint256 balance = armToken.balanceOf(address(this));
        require(balance >= requiredArm, "ArmadaCrowdfund: insufficient ARM for MAX_SALE");

        armLoaded = true;
        emit ArmLoaded(balance);
    }

    // ============ Invitation Phase ============

    /// @notice Invite an address to participate at (inviterHop + 1).
    ///         Re-inviting an already-whitelisted (invitee, hop) node increments its
    ///         invitesReceived counter, scaling its cap and outgoing invite budget.
    /// @param invitee Address to invite
    /// @param inviterHop Which of the caller's hop-level nodes is doing the inviting
    function invite(address invitee, uint8 inviterHop) external whenNotPaused {
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(block.timestamp < windowEnd, "ArmadaCrowdfund: window closed");

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

            emit Invited(msg.sender, invitee, inviteeHop, 0);
        } else {
            // Subsequent invite — increment counter (scales cap + outgoing budget)
            require(
                inviteeNode.invitesReceived < hopConfigs[inviteeHop].maxInvitesReceived,
                "ArmadaCrowdfund: max invites received"
            );
            inviteeNode.invitesReceived++;

            emit InviteAdded(msg.sender, invitee, inviteeHop, inviteeNode.invitesReceived);
        }

        inviter.invitesSent++;
    }

    /// @notice Launch team issues a direct invite at hop-1 or hop-2 (week 1 only).
    ///         The launch team is a sentinel with predeclared invite budgets — it is not
    ///         a participant and cannot commit USDC.
    /// @param invitee Address to invite
    /// @param fromHop Source hop level (0 = invite to hop-1, 1 = invite to hop-2)
    function launchTeamInvite(address invitee, uint8 fromHop) external whenNotPaused {
        require(msg.sender == launchTeam, "ArmadaCrowdfund: not launch team");
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(
            block.timestamp < launchTeamInviteEnd,
            "ArmadaCrowdfund: launch team invite window closed"
        );
        require(fromHop == 0 || fromHop == 1, "ArmadaCrowdfund: invalid hop for launch team");
        require(invitee != address(0), "ArmadaCrowdfund: zero address");

        uint8 inviteeHop = fromHop + 1;

        if (fromHop == 0) {
            require(launchTeamHop1Used < LAUNCH_TEAM_HOP1_BUDGET, "ArmadaCrowdfund: hop-1 budget exhausted");
            launchTeamHop1Used++;
        } else {
            require(launchTeamHop2Used < LAUNCH_TEAM_HOP2_BUDGET, "ArmadaCrowdfund: hop-2 budget exhausted");
            launchTeamHop2Used++;
        }

        Participant storage inviteeNode = participants[invitee][inviteeHop];

        if (!inviteeNode.isWhitelisted) {
            inviteeNode.isWhitelisted = true;
            inviteeNode.invitesReceived = 1;
            inviteeNode.invitedBy = msg.sender;
            participantNodes.push(ParticipantNode(invitee, inviteeHop));
            hopStats[inviteeHop].whitelistCount++;

            emit Invited(msg.sender, invitee, inviteeHop, 0);
        } else {
            require(
                inviteeNode.invitesReceived < hopConfigs[inviteeHop].maxInvitesReceived,
                "ArmadaCrowdfund: max invites received"
            );
            inviteeNode.invitesReceived++;

            emit InviteAdded(msg.sender, invitee, inviteeHop, inviteeNode.invitesReceived);
        }
    }

    // ============ Commitment Phase ============

    /// @notice Commit USDC to the crowdfund at a specific hop level
    /// @param hop Which of the caller's (address, hop) nodes to commit to
    /// @param amount USDC amount to commit (6 decimals)
    function commit(uint8 hop, uint256 amount) external nonReentrant whenNotPaused {
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(armLoaded, "ArmadaCrowdfund: ARM not loaded");
        require(
            block.timestamp >= windowStart && block.timestamp <= windowEnd,
            "ArmadaCrowdfund: not active window"
        );

        require(msg.sender != launchTeam, "ArmadaCrowdfund: launch team cannot commit");
        require(hop < NUM_HOPS, "ArmadaCrowdfund: invalid hop");
        Participant storage p = participants[msg.sender][hop];
        require(p.isWhitelisted, "ArmadaCrowdfund: not whitelisted");
        require(amount >= MIN_COMMIT, "ArmadaCrowdfund: below minimum commitment");

        // Over-cap deposits are accepted. Excess beyond effective cap is refunded
        // at settlement. Capped demand is computed at finalization time.

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

    /// @notice Redeem an off-chain EIP-712 signed invite and commit USDC in one transaction.
    ///         The inviter signs an invite ticket off-chain; the invitee (msg.sender) presents
    ///         the signature along with their USDC commitment.
    /// @param inviter Address that signed the invite
    /// @param fromHop Source hop level of the inviter (invitee joins at fromHop + 1)
    /// @param nonce Unique nonce for this invite (must be > 0; 0 is reserved for direct invites)
    /// @param deadline Timestamp after which the invite expires
    /// @param signature EIP-712 signature from inviter (supports EOA and EIP-1271 wallets)
    /// @param amount USDC amount to commit (6 decimals)
    function commitWithInvite(
        address inviter,
        uint8 fromHop,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(armLoaded, "ArmadaCrowdfund: ARM not loaded");
        require(
            block.timestamp >= windowStart && block.timestamp <= windowEnd,
            "ArmadaCrowdfund: not active window"
        );
        require(nonce > 0, "ArmadaCrowdfund: zero nonce");
        require(block.timestamp <= deadline, "ArmadaCrowdfund: invite expired");
        require(!usedNonces[inviter][nonce], "ArmadaCrowdfund: nonce already used");

        // Verify EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(
            INVITE_TYPEHASH,
            msg.sender,     // invitee
            fromHop,
            nonce,
            deadline
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        require(
            SignatureChecker.isValidSignatureNow(inviter, digest, signature),
            "ArmadaCrowdfund: invalid invite signature"
        );

        // Mark nonce as used
        usedNonces[inviter][nonce] = true;

        // --- Whitelist registration ---
        require(fromHop < NUM_HOPS - 1, "ArmadaCrowdfund: max hop reached");

        Participant storage inviterNode = participants[inviter][fromHop];
        require(inviterNode.isWhitelisted, "ArmadaCrowdfund: inviter not whitelisted");
        uint16 maxBudget = inviterNode.invitesReceived * uint16(hopConfigs[fromHop].maxInvites);
        require(inviterNode.invitesSent < maxBudget, "ArmadaCrowdfund: invite limit reached");

        uint8 inviteeHop = fromHop + 1;
        Participant storage inviteeNode = participants[msg.sender][inviteeHop];

        if (!inviteeNode.isWhitelisted) {
            inviteeNode.isWhitelisted = true;
            inviteeNode.invitesReceived = 1;
            inviteeNode.invitedBy = inviter;
            participantNodes.push(ParticipantNode(msg.sender, inviteeHop));
            hopStats[inviteeHop].whitelistCount++;

            emit Invited(inviter, msg.sender, inviteeHop, nonce);
        } else {
            require(
                inviteeNode.invitesReceived < hopConfigs[inviteeHop].maxInvitesReceived,
                "ArmadaCrowdfund: max invites received"
            );
            inviteeNode.invitesReceived++;
            emit InviteAdded(inviter, msg.sender, inviteeHop, inviteeNode.invitesReceived);
        }
        inviterNode.invitesSent++;

        // --- USDC escrow ---
        require(msg.sender != launchTeam, "ArmadaCrowdfund: launch team cannot commit");
        require(amount >= MIN_COMMIT, "ArmadaCrowdfund: below minimum commitment");

        bool firstCommit = (inviteeNode.committed == 0);

        inviteeNode.committed += amount;
        hopStats[inviteeHop].totalCommitted += amount;
        totalCommitted += amount;

        if (firstCommit) {
            hopStats[inviteeHop].uniqueCommitters++;
        }

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit Committed(msg.sender, amount, inviteeNode.committed, inviteeHop);
    }

    /// @notice Revoke an invite nonce so it can no longer be used.
    /// @param nonce The nonce to revoke (must be > 0)
    function revokeInviteNonce(uint256 nonce) external {
        require(nonce > 0, "ArmadaCrowdfund: zero nonce");
        require(!usedNonces[msg.sender][nonce], "ArmadaCrowdfund: nonce already used");
        usedNonces[msg.sender][nonce] = true;
        emit InviteNonceRevoked(msg.sender, nonce);
    }

    // ============ Finalization ============

    /// @notice Security council emergency cancel. Immediate and irreversible.
    ///         Available during Active phase (pre- or post-window).
    function cancel() external {
        require(msg.sender == securityCouncil, "ArmadaCrowdfund: not security council");
        require(phase != Phase.Finalized, "ArmadaCrowdfund: already finalized");
        require(phase != Phase.Canceled, "ArmadaCrowdfund: already canceled");
        phase = Phase.Canceled;
        emit SaleCanceled(totalCommitted);
    }

    /// @notice Finalize the crowdfund: compute allocations.
    ///         Permissionless — anyone may call once the window has ended and
    ///         totalCommitted meets the minimum raise.
    function finalize() external nonReentrant whenNotPaused {
        require(block.timestamp > windowEnd, "ArmadaCrowdfund: window not ended");
        require(phase == Phase.Active, "ArmadaCrowdfund: already finalized");

        // Compute capped demand by iterating all participant nodes. Over-cap
        // deposits are accepted during commit() but only capped amounts count
        // toward minimum raise, expansion trigger, and hop-level allocation.
        _computeCappedDemand();
        require(cappedDemand >= MIN_SALE, "ArmadaCrowdfund: below minimum raise");

        // Step 1: Elastic expansion (based on capped demand)
        if (cappedDemand >= ELASTIC_TRIGGER) {
            saleSize = MAX_SALE;
        } else {
            saleSize = BASE_SALE;
        }

        // Step 2: Per-hop allocation (matches spec pseudocode steps 3–6)
        //
        // Hop-2 floor is reserved off the top. Hop-0/hop-1 ceilings are BPS of the
        // available pool (saleSize minus floor). Ceilings overlap (sum > 100%) so a
        // remainingAvailable tracker ensures total allocation never exceeds saleSize.
        // Hop-2 has no BPS ceiling — its effective ceiling is floor + hop-1 leftover.
        // Rollover is unconditional: leftover always flows to the next hop.

        (uint256 totalAllocUsdc_, uint256 totalAllocArm_) = _computeHopAllocations(saleSize);

        // Post-allocation minimum raise check: if net proceeds (allocated USDC) fall
        // below MIN_SALE, enter refundMode. Participants get full USDC refunds via
        // claimRefund(); no ARM is distributed. This can occur at BASE_SALE when hop-0
        // is oversubscribed and later hops don't close the gap to $1M. Cannot occur
        // after expansion (hop-0 ceiling alone exceeds MIN_SALE).
        if (totalAllocUsdc_ < MIN_SALE) {
            refundMode = true;
            phase = Phase.Finalized;
            finalizedAt = block.timestamp;
            emit SaleFinalizedRefundMode(totalCommitted, totalAllocUsdc_);
            return;
        }

        totalAllocatedUsdc = totalAllocUsdc_;
        totalAllocated = totalAllocArm_;
        treasuryLeftoverUsdc = saleSize - totalAllocUsdc_;
        claimDeadline = block.timestamp + CLAIM_DEADLINE_DURATION;
        phase = Phase.Finalized;
        finalizedAt = block.timestamp;

        // Push net proceeds to treasury atomically. Contract retains refund USDC.
        // Pro-rata division rounds each participant's allocUsdc down, making the
        // sum of individual refunds slightly larger than (totalCommitted - totalAllocUsdc).
        // Retain a small rounding buffer (1 unit per participant node) so the contract
        // never runs short on refund payouts. Residual dust (< $0.01) remains
        // in the contract as the cost of rounding safety.
        uint256 roundingBuffer = participantNodes.length;
        uint256 proceedsPush = totalAllocUsdc_ > roundingBuffer
            ? totalAllocUsdc_ - roundingBuffer
            : 0;
        usdc.safeTransfer(treasury, proceedsPush);

        emit SaleFinalized(saleSize, totalAllocUsdc_, totalAllocArm_, treasuryLeftoverUsdc);
    }

    // ============ Claims & Withdrawals ============

    /// @notice Claim ARM allocation after finalization. ARM tokens only — USDC
    ///         refunds are handled separately by claimRefund().
    /// @param delegate Governance delegate preference, emitted in ArmClaimed for
    ///        off-chain indexing. Actual ERC20Votes delegation must be performed by
    ///        the claimant directly on the ARM token contract (delegate() uses msg.sender).
    /// @dev Allocation is computed lazily from stored hop-level reserves/demands
    function claim(address delegate) external nonReentrant whenNotPaused {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        require(!refundMode, "ArmadaCrowdfund: sale in refund mode");
        require(block.timestamp <= claimDeadline, "ArmadaCrowdfund: claim deadline passed");

        uint256 totalAllocArm = 0;
        bool hasCommitment = false;

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            Participant storage p = participants[msg.sender][h];
            if (p.committed == 0) continue;

            hasCommitment = true;
            require(!p.armClaimed, "ArmadaCrowdfund: ARM already claimed");

            uint256 effectiveCap = uint256(p.invitesReceived) * hopConfigs[h].capUsdc;
            (uint256 allocArm, , ) = _computeAllocation(p.committed, h, effectiveCap);

            p.armClaimed = true;
            p.allocation = allocArm;    // store for record-keeping

            totalAllocArm += allocArm;
        }

        require(hasCommitment, "ArmadaCrowdfund: no commitment");

        totalArmClaimed += totalAllocArm;

        if (totalAllocArm > 0) {
            armToken.safeTransfer(msg.sender, totalAllocArm);
        }

        emit ArmClaimed(msg.sender, totalAllocArm, delegate);
    }

    /// @notice Claim USDC refund. Four eligibility paths (any one suffices):
    ///         1. Normal post-finalization — pro-rata refund (finalized, not refundMode)
    ///         2. RefundMode — full deposit refund (finalized + refundMode)
    ///         3. Phase.Canceled — full deposit refund (security council cancel)
    ///         4. Deadline fallback — full deposit refund (window expired, not finalized, below MIN_SALE)
    ///         ARM claims are handled separately by claim().
    function claimRefund() external nonReentrant whenNotPaused {
        // Determine which refund path applies
        bool normalRefund = false;
        bool fullRefund = false;

        if (phase == Phase.Finalized && !refundMode) {
            // Path 1: Normal post-finalization pro-rata refund
            require(block.timestamp <= claimDeadline, "ArmadaCrowdfund: claim deadline passed");
            normalRefund = true;
        } else if (refundMode || phase == Phase.Canceled) {
            // Paths 2 & 3: Full deposit refund (no deadline — participants must always recover USDC)
            fullRefund = true;
        } else if (block.timestamp > windowEnd && phase != Phase.Finalized) {
            // Path 4: Deadline fallback — window expired without finalization
            _computeCappedDemand();
            if (cappedDemand < MIN_SALE) {
                fullRefund = true;
            }
        }

        require(normalRefund || fullRefund, "ArmadaCrowdfund: refund not available");

        uint256 totalRefundUsdc = 0;
        bool hasCommitment = false;

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            Participant storage p = participants[msg.sender][h];
            if (p.committed == 0) continue;

            hasCommitment = true;
            require(!p.refundClaimed, "ArmadaCrowdfund: already refunded");

            p.refundClaimed = true;

            if (normalRefund) {
                // Pro-rata refund: committed minus allocated portion
                uint256 effectiveCap = uint256(p.invitesReceived) * hopConfigs[h].capUsdc;
                (, , uint256 refundUsdc) = _computeAllocation(p.committed, h, effectiveCap);
                p.refund = refundUsdc;  // store for record-keeping
                totalRefundUsdc += refundUsdc;
            } else {
                // Full refund: return entire committed amount
                totalRefundUsdc += p.committed;
            }
        }

        require(hasCommitment, "ArmadaCrowdfund: no commitment");

        if (totalRefundUsdc > 0) {
            usdc.safeTransfer(msg.sender, totalRefundUsdc);
        }

        emit RefundClaimed(msg.sender, totalRefundUsdc);
    }

    /// @notice Sweep unallocated or unclaimed ARM to treasury. Permissionless. Callable
    ///         multiple times — no idempotency flag. Three sweep windows:
    ///         1. Post-finalization: sweeps unsold ARM immediately (MAX_SALE - totalAllocated)
    ///         2. Post-claim-deadline: sweeps all remaining ARM (unclaimed participant ARM)
    ///         3. Post-cancel/refundMode: sweeps all ARM (nothing owed)
    function withdrawUnallocatedArm() external nonReentrant {
        require(
            phase == Phase.Finalized || phase == Phase.Canceled,
            "ArmadaCrowdfund: not finalized or canceled"
        );

        uint256 armBalance = armToken.balanceOf(address(this));
        uint256 armStillOwed;
        if (phase == Phase.Canceled || refundMode) {
            armStillOwed = 0;
        } else if (block.timestamp > claimDeadline) {
            armStillOwed = 0;
        } else {
            armStillOwed = totalAllocated - totalArmClaimed;
        }
        uint256 sweepable = armBalance - armStillOwed;
        require(sweepable > 0, "ArmadaCrowdfund: nothing to sweep");

        armToken.safeTransfer(treasury, sweepable);

        emit UnallocatedArmWithdrawn(treasury, sweepable);
    }

    // ============ Emergency Pause ============

    /// @notice Pause invite(), commit(), claim(), and claimRefund() in case of emergency.
    ///         Pre-finalization: launch team or security council. Post-finalization/cancel: security council only.
    function pause() external {
        if (phase == Phase.Finalized || phase == Phase.Canceled) {
            require(msg.sender == securityCouncil, "ArmadaCrowdfund: only security council");
        } else {
            require(
                msg.sender == launchTeam || msg.sender == securityCouncil,
                "ArmadaCrowdfund: not launch team or security council"
            );
        }
        _pause();
    }

    /// @notice Unpause to resume normal operations.
    ///         Pre-finalization: launch team or security council. Post-finalization/cancel: security council only.
    function unpause() external {
        if (phase == Phase.Finalized || phase == Phase.Canceled) {
            require(msg.sender == securityCouncil, "ArmadaCrowdfund: only security council");
        } else {
            require(
                msg.sender == launchTeam || msg.sender == securityCouncil,
                "ArmadaCrowdfund: not launch team or security council"
            );
        }
        _unpause();
    }

    // ============ View Functions ============

    /// @notice Get aggregate stats for a hop (visible during sale)
    function getHopStats(uint8 hop) external view returns (
        uint256 _totalCommitted,
        uint256 _cappedCommitted,
        uint32 _uniqueCommitters,
        uint32 _whitelistCount
    ) {
        require(hop < NUM_HOPS, "ArmadaCrowdfund: invalid hop");
        HopStats storage s = hopStats[hop];
        return (s.totalCommitted, s.cappedCommitted, s.uniqueCommitters, s.whitelistCount);
    }

    /// @notice Get overall sale stats
    function getSaleStats() external view returns (
        uint256 _totalCommitted,
        Phase _phase,
        uint256 _windowStart,
        uint256 _windowEnd
    ) {
        return (totalCommitted, phase, windowStart, windowEnd);
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

    /// @notice Get aggregate allocation across all hops (only after finalization).
    ///         The `claimed` return reflects ARM claim status (armClaimed); refund
    ///         claim status is tracked separately via refundClaimed.
    /// @dev Computes allocation on the fly from stored hop-level data if ARM not yet claimed
    function getAllocation(address addr) external view returns (
        uint256 allocation,
        uint256 _refund,
        bool claimed
    ) {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        require(!refundMode, "ArmadaCrowdfund: sale in refund mode");

        uint256 totalAllocArm = 0;
        uint256 totalRefundUsdc = 0;
        bool anyClaimed = false;

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            Participant storage p = participants[addr][h];
            if (p.committed == 0) continue;

            if (p.armClaimed) {
                anyClaimed = true;
                totalAllocArm += p.allocation;
            } else {
                uint256 effectiveCap = uint256(p.invitesReceived) * hopConfigs[h].capUsdc;
                (uint256 allocArm, , ) = _computeAllocation(p.committed, h, effectiveCap);
                totalAllocArm += allocArm;
            }

            if (p.refundClaimed) {
                totalRefundUsdc += p.refund;
            } else {
                uint256 effectiveCap = uint256(p.invitesReceived) * hopConfigs[h].capUsdc;
                (, , uint256 refundUsdc) = _computeAllocation(p.committed, h, effectiveCap);
                totalRefundUsdc += refundUsdc;
            }
        }

        return (totalAllocArm, totalRefundUsdc, anyClaimed);
    }

    /// @notice Get allocation at a specific hop (only after finalization).
    ///         The `claimed` return reflects ARM claim status (armClaimed).
    function getAllocationAtHop(address addr, uint8 hop) external view returns (
        uint256 allocation,
        uint256 _refund,
        bool claimed
    ) {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        require(!refundMode, "ArmadaCrowdfund: sale in refund mode");
        Participant storage p = participants[addr][hop];

        uint256 allocArm;
        uint256 refundUsdc;

        if (p.armClaimed) {
            allocArm = p.allocation;
        } else {
            uint256 effectiveCap = uint256(p.invitesReceived) * hopConfigs[hop].capUsdc;
            (allocArm, , ) = _computeAllocation(p.committed, hop, effectiveCap);
        }

        if (p.refundClaimed) {
            refundUsdc = p.refund;
        } else {
            uint256 effectiveCap = uint256(p.invitesReceived) * hopConfigs[hop].capUsdc;
            (, , refundUsdc) = _computeAllocation(p.committed, hop, effectiveCap);
        }

        return (allocArm, refundUsdc, p.armClaimed);
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

    /// @notice Get remaining launch team invite budget
    function getLaunchTeamBudgetRemaining() external view returns (uint8 hop1Remaining, uint8 hop2Remaining) {
        hop1Remaining = LAUNCH_TEAM_HOP1_BUDGET - launchTeamHop1Used;
        hop2Remaining = LAUNCH_TEAM_HOP2_BUDGET - launchTeamHop2Used;
    }

    /// @notice Get total number of (address, hop) nodes (not unique addresses)
    function getParticipantCount() external view returns (uint256) {
        return participantNodes.length;
    }

    // ============ Internal ============

    /// @dev Enforces that seeds can only be added before the invite period ends (requires ARM loaded).
    function _requireArmLoadedAndPreInviteEnd() internal view {
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(armLoaded, "ArmadaCrowdfund: ARM not loaded");
        require(
            block.timestamp < launchTeamInviteEnd,
            "ArmadaCrowdfund: seeds only before invite period ends"
        );
    }

    /// @dev Compute hop-level allocations and store results in finalCeilings/finalDemands.
    ///      Extracted from finalize() to avoid stack-too-deep.
    function _computeHopAllocations(uint256 saleSize_) internal returns (
        uint256 totalAllocUsdc_,
        uint256 totalAllocArm_
    ) {
        uint256 hop2Floor = (saleSize_ * HOP2_FLOOR_BPS) / 10000;
        uint256 available = saleSize_ - hop2Floor;

        // Hop-0/hop-1 base ceilings (BPS of available pool)
        uint256 hop0Ceiling = (available * hopConfigs[0].ceilingBps) / 10000;
        uint256 hop1Ceiling = (available * hopConfigs[1].ceilingBps) / 10000;

        // --- Hop-0: allocate from available pool ---
        // Uses cappedCommitted (set by _computeCappedDemand) — over-cap deposits excluded
        uint256 demand = hopStats[0].cappedCommitted;
        uint256 alloc = demand <= hop0Ceiling ? demand : hop0Ceiling;
        uint256 leftover = hop0Ceiling - alloc;
        uint256 remainingAvailable = available - alloc;

        finalCeilings[0] = hop0Ceiling;
        finalDemands[0] = demand;
        totalAllocUsdc_ = alloc;
        totalAllocArm_ = (alloc * 1e18) / ARM_PRICE;

        // --- Hop-1: allocate from remaining available, ceiling boosted by hop-0 leftover ---
        demand = hopStats[1].cappedCommitted;
        uint256 hop1EffCeiling = hop1Ceiling + leftover;
        if (hop1EffCeiling > remainingAvailable) {
            hop1EffCeiling = remainingAvailable;
        }
        alloc = demand <= hop1EffCeiling ? demand : hop1EffCeiling;
        leftover = hop1EffCeiling - alloc;

        finalCeilings[1] = hop1EffCeiling;
        finalDemands[1] = demand;
        totalAllocUsdc_ += alloc;
        totalAllocArm_ += (alloc * 1e18) / ARM_PRICE;

        // --- Hop-2: allocate from floor + hop-1 leftover (no BPS ceiling) ---
        demand = hopStats[2].cappedCommitted;
        uint256 hop2EffCeiling = hop2Floor + leftover;
        alloc = demand <= hop2EffCeiling ? demand : hop2EffCeiling;

        finalCeilings[2] = hop2EffCeiling;
        finalDemands[2] = demand;
        totalAllocUsdc_ += alloc;
        totalAllocArm_ += (alloc * 1e18) / ARM_PRICE;
    }

    /// @dev Compute allocation for a participant from stored hop-level ceilings/demands.
    ///      Uses capped committed amount (min of raw committed and effectiveCap) for
    ///      allocation math. Over-cap excess is refunded in full.
    function _computeAllocation(uint256 committed, uint8 hop, uint256 effectiveCap) internal view returns (
        uint256 allocArm,
        uint256 allocUsdc,
        uint256 refundUsdc
    ) {
        if (committed == 0) return (0, 0, 0);

        uint256 cappedCommitted = committed < effectiveCap ? committed : effectiveCap;

        if (finalDemands[hop] <= finalCeilings[hop]) {
            // Under-subscribed: full allocation of capped amount
            allocUsdc = cappedCommitted;
        } else {
            // Over-subscribed: pro-rata of capped amount
            allocUsdc = (cappedCommitted * finalCeilings[hop]) / finalDemands[hop];
        }
        allocArm = (allocUsdc * 1e18) / ARM_PRICE;
        // Refund = raw committed minus allocated (includes over-cap excess + pro-rata excess)
        refundUsdc = committed - allocUsdc;
    }

    /// @dev Iterate all participant nodes and compute capped demand per hop and globally.
    ///      Sets hopStats[h].cappedCommitted and cappedDemand. Matches spec finalization
    ///      pseudocode step 1-2: cap each (address, hop) at invitesReceived * capUsdc.
    function _computeCappedDemand() internal {
        uint256 globalCapped = 0;
        // Reset per-hop capped totals
        for (uint8 h = 0; h < NUM_HOPS; h++) {
            hopStats[h].cappedCommitted = 0;
        }

        uint256 len = participantNodes.length;
        for (uint256 i = 0; i < len; i++) {
            ParticipantNode storage node = participantNodes[i];
            Participant storage p = participants[node.addr][node.hop];
            if (p.committed == 0) continue;

            uint256 effectiveCap = uint256(p.invitesReceived) * hopConfigs[node.hop].capUsdc;
            uint256 capped = p.committed < effectiveCap ? p.committed : effectiveCap;
            hopStats[node.hop].cappedCommitted += capped;
            globalCapped += capped;
        }

        cappedDemand = globalCapped;
    }
}
