// ABOUTME: Word-of-mouth whitelist crowdfund with hop-based allocation.
// ABOUTME: Implements overlapping ceilings, hop-2 floor, elastic expansion, and pro-rata refunds.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "./IArmadaCrowdfund.sol";

/// @notice Minimal ArmadaToken interface for atomic delegation on claim.
interface IArmadaTokenCrowdfund {
    function delegateOnBehalf(address delegator, address delegatee) external;
}

/// @title ArmadaCrowdfund — Word-of-mouth whitelist crowdfund with hop-based allocation
/// @notice Implements the full crowdfund lifecycle: seed management, invitation chains,
///         USDC commitment escrow, deterministic allocation with pro-rata scaling and rollover,
///         elastic expansion, and refund mechanism.
contract ArmadaCrowdfund is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    uint256 public constant BASE_SALE = 100 * 1e6;              // $100 USDC (mini-Sepolia)
    uint256 public constant MAX_SALE  = 150 * 1e6;              // $150 USDC (mini-Sepolia)
    uint256 public constant MIN_SALE  = 80 * 1e6;               // $80 USDC (mini-Sepolia)
    uint256 public constant ARM_PRICE = 1e6;                     // $1.00 per ARM in USDC
    uint256 public constant ELASTIC_TRIGGER = 120 * 1e6;         // $120 capped demand triggers expansion (mini-Sepolia)
    uint8 public constant NUM_HOPS = 3;
    uint256 public constant HOP2_FLOOR_BPS = 500;  // 5% of saleSize reserved for hop-2

    uint256 public constant WINDOW_DURATION = 1 days;
    uint256 public constant LAUNCH_TEAM_INVITE_PERIOD = 6 hours;
    uint256 public constant CLAIM_DEADLINE_DURATION = 7 days;    // (mini-Sepolia)
    uint256 public constant MIN_COMMIT = 1 * 1e6;                // $1 USDC minimum per commit (mini-Sepolia)
    // Per-hop invite stacking caps are stored in hopConfigs[].maxInvitesReceived (1, 10, 20)
    uint8 public constant MAX_SEEDS = 5;                         // max number of seeds (mini-Sepolia)
    uint8 public constant LAUNCH_TEAM_HOP1_BUDGET = 5;           // launch team direct hop-1 invite slots (mini-Sepolia)
    uint8 public constant LAUNCH_TEAM_HOP2_BUDGET = 5;           // launch team direct hop-2 invite slots (mini-Sepolia)

    // EIP-712 typehash for off-chain invite signatures
    bytes32 public constant INVITE_TYPEHASH = keccak256(
        "Invite(address inviter,uint8 fromHop,uint256 nonce,uint256 deadline)"
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

    // Timing (set once in constructor, never modified)
    uint256 public immutable windowStart;
    uint256 public immutable windowEnd;
    uint256 public immutable launchTeamInviteEnd;

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
    uint256 public totalAllocatedArm;    // ARM (18 dec) — aggregate from hop-level computation
    uint256 public totalAllocatedUsdc;   // USDC (6 dec) — hop-level upper bound
    uint256[3] public finalCeilings;     // budget-capped hop ceilings (stored at finalization)
    uint256[3] public finalDemands;      // hop demands (stored at finalization)
    // Lazy evaluation accumulators (tracked during claims)
    uint256 public totalArmTransferred;  // exact sum of ARM transferred via claim()

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

    // Per-address claim tracking (lazy settlement — allocation computed at claim time)
    mapping(address => bool) public claimed;

    // ============ Events ============

    event SeedAdded(address indexed seed);
    event Invited(address indexed inviter, address indexed invitee, uint8 hop, uint256 nonce);
    event LaunchTeamInvited(address indexed invitee, uint8 hop);
    event Committed(address indexed participant, uint8 hop, uint256 amount);
    event Finalized(uint256 saleSize, uint256 allocatedArm, uint256 netProceeds, bool refundMode);
    event Cancelled();
    event RefundClaimed(address indexed participant, uint256 usdcAmount);
    event UnallocatedArmWithdrawn(address indexed treasury, uint256 amount);
    event ArmLoaded();
    event InviteNonceRevoked(address indexed inviter, uint256 nonce);
    event Allocated(address indexed participant, uint256 armTransferred, uint256 refundUsdc, address delegate);
    event AllocatedHop(address indexed participant, uint8 indexed hop, uint256 acceptedUsdc);

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
        require(_usdc != address(0), "ArmadaCrowdfund: zero usdc");
        require(_armToken != address(0), "ArmadaCrowdfund: zero armToken");
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

        hopConfigs[0] = HopConfig({ ceilingBps: 7000, capUsdc: 50 * 1e6, maxInvites: 3, maxInvitesReceived: 1 });  // (mini-Sepolia)
        hopConfigs[1] = HopConfig({ ceilingBps: 4500, capUsdc: 20 * 1e6, maxInvites: 2, maxInvitesReceived: 10 }); // (mini-Sepolia)
        hopConfigs[2] = HopConfig({ ceilingBps: 0,    capUsdc: 10 * 1e6, maxInvites: 0, maxInvitesReceived: 20 }); // (mini-Sepolia)
    }

    // ============ Seed Management ============

    /// @notice Add seed addresses (hop 0). Allowed during week 1 only (requires ARM loaded).
    function addSeeds(address[] calldata seeds) external onlyLaunchTeam {
        _requireArmLoadedAndPreInviteEnd();
        for (uint256 i = 0; i < seeds.length; i++) {
            _addSeed(seeds[i]);
        }
    }

    /// @notice Add a single seed address (hop 0). Allowed during week 1 only (requires ARM loaded).
    function addSeed(address seed) external onlyLaunchTeam {
        _requireArmLoadedAndPreInviteEnd();
        _addSeed(seed);
    }

    function _addSeed(address seed) internal {
        require(seed != address(0), "ArmadaCrowdfund: zero address");
        require(hopStats[0].whitelistCount < MAX_SEEDS, "ArmadaCrowdfund: seed cap reached");
        require(!participants[seed][0].isWhitelisted, "ArmadaCrowdfund: already whitelisted");

        _initParticipant(seed, 0, address(0));

        emit SeedAdded(seed);
    }

    /// @dev Initialize a new participant node at the given hop.
    function _initParticipant(address participant, uint8 hop, address inviter_) private {
        participants[participant][hop].isWhitelisted = true;
        participants[participant][hop].invitesReceived = 1;
        participants[participant][hop].invitedBy = inviter_;
        participantNodes.push(ParticipantNode(participant, hop));
        hopStats[hop].whitelistCount++;
    }

    /// @notice Verify the contract holds sufficient ARM for the maximum possible sale.
    ///         Permissionless. Idempotent: no-op if already loaded.
    function loadArm() external {
        if (armLoaded) return;

        uint256 requiredArm = (MAX_SALE * 1e18) / ARM_PRICE;
        uint256 balance = armToken.balanceOf(address(this));
        require(balance >= requiredArm, "ArmadaCrowdfund: insufficient ARM for MAX_SALE");

        armLoaded = true;
        emit ArmLoaded();
    }

    // ============ Invitations ============

    /// @notice Invite an address to participate at (inviterHop + 1).
    ///         Re-inviting an already-whitelisted (invitee, hop) node increments its
    ///         invitesReceived counter, scaling its cap and outgoing invite budget.
    /// @param invitee Address to invite
    /// @param inviterHop Which of the caller's hop-level nodes is doing the inviting
    function invite(address invitee, uint8 inviterHop) external {
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(armLoaded, "ArmadaCrowdfund: ARM not loaded");
        require(block.timestamp <= windowEnd, "ArmadaCrowdfund: window closed");

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
        _registerOrStackInvite(invitee, inviteeHop, msg.sender);

        inviter.invitesSent++;
        emit Invited(msg.sender, invitee, inviteeHop, 0);
    }

    /// @notice Launch team issues a direct invite at hop-1 or hop-2 (week 1 only).
    ///         The launch team is a sentinel with predeclared invite budgets — it is not
    ///         a participant and cannot commit USDC.
    /// @param invitee Address to invite
    /// @param fromHop Source hop level (0 = invite to hop-1, 1 = invite to hop-2)
    function launchTeamInvite(address invitee, uint8 fromHop) external {
        require(msg.sender == launchTeam, "ArmadaCrowdfund: not launch team");
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(
            block.timestamp >= windowStart && block.timestamp < launchTeamInviteEnd,
            "ArmadaCrowdfund: outside week-1 window"
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

        _registerOrStackInvite(invitee, inviteeHop, msg.sender);

        emit LaunchTeamInvited(invitee, inviteeHop);
    }

    // ============ Commitments ============

    /// @notice Commit USDC to the crowdfund at a specific hop level
    /// @param hop Which of the caller's (address, hop) nodes to commit to
    /// @param amount USDC amount to commit (6 decimals)
    function commit(uint8 hop, uint256 amount) external nonReentrant {
        _requireActiveCommitWindow();

        require(msg.sender != launchTeam, "ArmadaCrowdfund: launch team cannot commit");
        require(hop < NUM_HOPS, "ArmadaCrowdfund: invalid hop");
        Participant storage p = participants[msg.sender][hop];
        require(p.isWhitelisted, "ArmadaCrowdfund: not whitelisted");
        require(amount >= MIN_COMMIT, "ArmadaCrowdfund: below minimum commitment");

        // Over-cap deposits are accepted. Excess beyond effective cap is refunded
        // at settlement. Capped demand is computed at finalization time.

        // CEI: update state before external call
        _escrowCommit(p, hop, amount);

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit Committed(msg.sender, hop, amount);
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
    ) external nonReentrant {
        _requireActiveCommitWindow();
        require(nonce > 0, "ArmadaCrowdfund: zero nonce");
        require(block.timestamp <= deadline, "ArmadaCrowdfund: invite expired");
        require(!usedNonces[inviter][nonce], "ArmadaCrowdfund: nonce already used");

        // Verify EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(
            INVITE_TYPEHASH,
            inviter,        // bearer credential: inviter signs their own address
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
        _registerOrStackInvite(msg.sender, inviteeHop, inviter);
        Participant storage inviteeNode = participants[msg.sender][inviteeHop];
        inviterNode.invitesSent++;
        emit Invited(inviter, msg.sender, inviteeHop, nonce);

        // --- USDC escrow ---
        require(msg.sender != launchTeam, "ArmadaCrowdfund: launch team cannot commit");
        require(amount >= MIN_COMMIT, "ArmadaCrowdfund: below minimum commitment");

        _escrowCommit(inviteeNode, inviteeHop, amount);

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit Committed(msg.sender, inviteeHop, amount);
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
        emit Cancelled();
    }

    /// @notice Finalize the crowdfund: compute allocations or enter refund mode.
    ///         Permissionless — anyone may call once the window has ended.
    ///         If capped demand is below MIN_SALE, sets refundMode and returns.
    function finalize() external nonReentrant {
        require(block.timestamp > windowEnd, "ArmadaCrowdfund: window not ended");
        require(phase == Phase.Active, "ArmadaCrowdfund: already finalized");

        // Compute capped demand by iterating all participant nodes. Over-cap
        // deposits are accepted during commit() but only capped amounts count
        // toward minimum raise, expansion trigger, and hop-level allocation.
        _computeCappedDemand();

        // If capped demand is below minimum raise, enter refund mode immediately.
        // No allocations to compute — all participants get full USDC refunds.
        if (cappedDemand < MIN_SALE) {
            refundMode = true;
            phase = Phase.Finalized;
            finalizedAt = block.timestamp;
            emit Finalized(0, 0, 0, true);
            return;
        }

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

        // _computeHopAllocations sets finalCeilings/finalDemands needed by _computeAllocation
        // and returns the hop-level USDC estimate for the refundMode pre-check below.
        uint256 totalAllocUsdc_ = _computeHopAllocations(saleSize);

        // Post-allocation minimum raise check: if net proceeds (allocated USDC) fall
        // below MIN_SALE, enter refundMode. Participants get full USDC refunds via
        // claimRefund(); no ARM is distributed. This can occur at BASE_SALE when hop-0
        // is oversubscribed and later hops don't close the gap to $1M. Cannot occur
        // after expansion (hop-0 ceiling alone exceeds MIN_SALE).
        if (totalAllocUsdc_ < MIN_SALE) {
            refundMode = true;
            phase = Phase.Finalized;
            finalizedAt = block.timestamp;
            emit Finalized(saleSize, 0, 0, true);
            return;
        }

        // Step 3: Store aggregate hop-level results. Per-participant allocations
        // are computed lazily at claim() time (user-borne gas).
        totalAllocatedUsdc = totalAllocUsdc_;
        totalAllocatedArm = (totalAllocUsdc_ * 1e18) / ARM_PRICE;
        claimDeadline = block.timestamp + CLAIM_DEADLINE_DURATION;
        phase = Phase.Finalized;
        finalizedAt = block.timestamp;

        // Push net proceeds to treasury. Retain a rounding buffer so the contract
        // never runs short on refund payouts: lazy per-participant floor divisions
        // can sum to slightly less than totalAllocatedUsdc, making the aggregate
        // refund slightly larger. Buffer = participantNodes.length * NUM_HOPS
        // (max 1 USDC unit per participant per hop). Residual dust stays in contract.
        //
        // Invariant note: the spec requires netProceeds + sum(refunds) == totalCommitted
        // as a settlement-completion identity. The rounding buffer means the treasury
        // receives slightly less than totalAllocatedUsdc, with the difference (at most
        // participantNodes.length * NUM_HOPS USDC units) stranded in the contract as
        // unrecoverable dust. The identity still holds at the contract level:
        // treasuryReceived + contractDust + sum(refunds) == totalCommitted.
        uint256 roundingBuffer = participantNodes.length * NUM_HOPS;
        uint256 proceedsPush = totalAllocUsdc_ > roundingBuffer
            ? totalAllocUsdc_ - roundingBuffer
            : 0;
        usdc.safeTransfer(treasury, proceedsPush);

        emit Finalized(saleSize, totalAllocatedArm, totalAllocUsdc_, false);
    }

    // ============ Claims & Withdrawals ============

    /// @notice Claim ARM allocation and USDC refund after finalization.
    ///         Computes allocation on the fly from hop-level data.
    ///         ARM portion transfers only if within the 3-year claim deadline;
    ///         refund portion always transfers (no expiry).
    /// @param delegate Governance delegate address (required when claiming ARM).
    ///        Voting power is atomically delegated via delegateOnBehalf.
    ///        Reverts if address(0) and claimant is receiving ARM within the claim deadline.
    function claim(address delegate) external nonReentrant {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        require(!refundMode, "ArmadaCrowdfund: sale in refund mode");
        require(!claimed[msg.sender], "ArmadaCrowdfund: already claimed");

        _requireHasCommitment();

        claimed[msg.sender] = true;

        // Compute allocation on the fly
        uint256 totalAllocArm = 0;
        uint256 totalRefundUsdc = 0;
        for (uint8 h = 0; h < NUM_HOPS; h++) {
            Participant storage p = participants[msg.sender][h];
            if (p.committed == 0) continue;

            (uint256 allocArm, uint256 allocUsdc, uint256 hopRefund) = _computeAllocation(p.committed, h, _effectiveCap(p, h));
            totalAllocArm += allocArm;
            totalRefundUsdc += hopRefund;

            if (allocUsdc > 0) emit AllocatedHop(msg.sender, h, allocUsdc);
        }

        // ARM: only transfer if within claim deadline
        uint256 armTransferred = 0;
        if (block.timestamp <= claimDeadline && totalAllocArm > 0) {
            require(delegate != address(0), "ArmadaCrowdfund: delegate required");
            armTransferred = totalAllocArm;
            totalArmTransferred += armTransferred;
            armToken.safeTransfer(msg.sender, armTransferred);
            IArmadaTokenCrowdfund(address(armToken)).delegateOnBehalf(msg.sender, delegate);
        }

        // Refund: always transfer (no expiry)
        if (totalRefundUsdc > 0) {
            usdc.safeTransfer(msg.sender, totalRefundUsdc);
        }

        emit Allocated(msg.sender, armTransferred, totalRefundUsdc, armTransferred > 0 ? delegate : address(0));
    }

    /// @notice Claim USDC refund — failure paths only. Two eligibility paths:
    ///         1. RefundMode — full deposit refund (finalized + refundMode)
    ///         2. Phase.Canceled — full deposit refund (security council cancel)
    ///         Success-path refunds (pro-rata excess) are handled by claim().
    function claimRefund() external nonReentrant {
        require(
            refundMode || phase == Phase.Canceled,
            "ArmadaCrowdfund: refund not available"
        );
        require(!claimed[msg.sender], "ArmadaCrowdfund: already claimed");

        _requireHasCommitment();

        claimed[msg.sender] = true;

        // Full refund: return entire committed amount across all hops
        uint256 totalRefundUsdc;
        for (uint8 h = 0; h < NUM_HOPS; h++) {
            totalRefundUsdc += participants[msg.sender][h].committed;
        }

        if (totalRefundUsdc > 0) {
            usdc.safeTransfer(msg.sender, totalRefundUsdc);
        }

        emit RefundClaimed(msg.sender, totalRefundUsdc);
    }

    /// @notice Sweep unallocated or unclaimed ARM to treasury. Permissionless. Callable
    ///         multiple times — no idempotency flag. Three sweep windows:
    ///         1. Post-finalization: sweeps unsold ARM immediately (MAX_SALE arm - totalAllocatedArm)
    ///         2. Post-claim-deadline: sweeps all remaining ARM (unclaimed participant ARM forfeited)
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
            // Post-3yr: all unclaimed ARM is forfeited
            armStillOwed = 0;
        } else {
            // Pre-3yr: owe the difference between allocated and already transferred
            armStillOwed = totalAllocatedArm - totalArmTransferred;
        }
        uint256 sweepable = armBalance - armStillOwed;
        require(sweepable > 0, "ArmadaCrowdfund: nothing to sweep");

        armToken.safeTransfer(treasury, sweepable);

        emit UnallocatedArmWithdrawn(treasury, sweepable);
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

    /// @notice Compute capped demand on the fly without modifying state.
    ///         Pre-finalization this gives a live estimate; post-finalization it
    ///         matches the stored cappedDemand value.
    function getEstimatedCappedDemand() external view returns (
        uint256 globalCapped,
        uint256[3] memory perHopCapped
    ) {
        return _iterateCappedDemand();
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

    /// @notice Compute aggregate allocation across all hops (only after finalization).
    ///         Purely derived from hop-level data — no stored per-address state.
    function computeAllocation(address addr) public view returns (
        uint256 armAmount,
        uint256 refundUsdc
    ) {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        require(!refundMode, "ArmadaCrowdfund: sale in refund mode");

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            Participant storage p = participants[addr][h];
            if (p.committed == 0) continue;

            (uint256 allocArm, , uint256 hopRefund) = _computeAllocation(p.committed, h, _effectiveCap(p, h));
            armAmount += allocArm;
            refundUsdc += hopRefund;
        }
    }

    /// @notice Compute allocation at a specific hop (only after finalization).
    function computeAllocationAtHop(address addr, uint8 hop) external view returns (
        uint256 armAmount,
        uint256 refundUsdc
    ) {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        require(!refundMode, "ArmadaCrowdfund: sale in refund mode");
        Participant storage p = participants[addr][hop];

        (armAmount, , refundUsdc) = _computeAllocation(p.committed, hop, _effectiveCap(p, hop));
    }

    /// @notice Get effective cap for an address at a hop (invitesReceived * per-slot cap)
    function getEffectiveCap(address addr, uint8 hop) external view returns (uint256) {
        Participant storage p = participants[addr][hop];
        if (!p.isWhitelisted) return 0;
        return _effectiveCap(p, hop);
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

    /// @dev Enforces that seeds can only be added during week 1 (requires ARM loaded).
    function _requireArmLoadedAndPreInviteEnd() internal view {
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(armLoaded, "ArmadaCrowdfund: ARM not loaded");
        require(
            block.timestamp >= windowStart && block.timestamp < launchTeamInviteEnd,
            "ArmadaCrowdfund: outside week-1 window"
        );
    }

    /// @dev Record a USDC commitment: update participant, hop stats, and global total.
    function _escrowCommit(Participant storage p, uint8 hop, uint256 amount) internal {
        bool firstCommit = (p.committed == 0);
        p.committed += amount;
        hopStats[hop].totalCommitted += amount;
        totalCommitted += amount;
        if (firstCommit) {
            hopStats[hop].uniqueCommitters++;
        }
    }

    /// @dev Whitelist a new (invitee, hop) node or stack an additional invite on it.
    function _registerOrStackInvite(address invitee, uint8 inviteeHop, address inviter_) internal {
        Participant storage inviteeNode = participants[invitee][inviteeHop];
        if (!inviteeNode.isWhitelisted) {
            _initParticipant(invitee, inviteeHop, inviter_);
        } else {
            require(
                inviteeNode.invitesReceived < hopConfigs[inviteeHop].maxInvitesReceived,
                "ArmadaCrowdfund: max invites received"
            );
            inviteeNode.invitesReceived++;
        }
    }

    /// @dev Compute the effective commitment cap for a participant at a given hop.
    function _effectiveCap(Participant storage p, uint8 hop) internal view returns (uint256) {
        return uint256(p.invitesReceived) * hopConfigs[hop].capUsdc;
    }

    /// @dev Reverts if msg.sender has zero committed USDC across all hops.
    function _requireHasCommitment() internal view {
        bool hasCommitment = false;
        for (uint8 h = 0; h < NUM_HOPS; h++) {
            if (participants[msg.sender][h].committed > 0) {
                hasCommitment = true;
                break;
            }
        }
        require(hasCommitment, "ArmadaCrowdfund: no commitment");
    }

    /// @dev Enforces the active commit window (phase, ARM loaded, within 3-week window).
    function _requireActiveCommitWindow() internal view {
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(armLoaded, "ArmadaCrowdfund: ARM not loaded");
        require(
            block.timestamp >= windowStart && block.timestamp <= windowEnd,
            "ArmadaCrowdfund: not active window"
        );
    }

    /// @dev Compute hop-level allocations and store results in finalCeilings/finalDemands.
    ///      Extracted from finalize() to avoid stack-too-deep.
    function _computeHopAllocations(uint256 saleSize_) internal returns (uint256 totalAllocUsdc_) {
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

        // --- Hop-2: allocate from floor + hop-1 leftover (no BPS ceiling) ---
        demand = hopStats[2].cappedCommitted;
        uint256 hop2EffCeiling = hop2Floor + leftover;
        alloc = demand <= hop2EffCeiling ? demand : hop2EffCeiling;

        finalCeilings[2] = hop2EffCeiling;
        finalDemands[2] = demand;
        totalAllocUsdc_ += alloc;
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

    /// @dev Pure iteration: compute capped demand per hop and globally without writing state.
    ///      DESIGN NOTE: This iterates the full participantNodes array — O(n) where n is total
    ///      participants across all hops. The array is bounded by invite chain limits:
    ///      MAX_SEEDS (150) at hop-0, with invitesPerPerson limits at each subsequent hop.
    ///      Practical maximum is ~1,500 nodes, costing ~6.3M gas (well within 30M block limit).
    ///      An incremental tracking approach was considered but rejected to avoid
    ///      changing the accounting flow. If invite limits are ever significantly increased,
    ///      this should be revisited.
    function _iterateCappedDemand() internal view returns (
        uint256 globalCapped,
        uint256[3] memory perHopCapped
    ) {
        uint256 len = participantNodes.length;
        for (uint256 i = 0; i < len; i++) {
            ParticipantNode storage node = participantNodes[i];
            Participant storage p = participants[node.addr][node.hop];
            if (p.committed == 0) continue;

            uint256 cap = _effectiveCap(p, node.hop);
            uint256 capped = p.committed < cap ? p.committed : cap;
            perHopCapped[node.hop] += capped;
            globalCapped += capped;
        }
    }

    /// @dev Compute capped demand and write results to hopStats and cappedDemand.
    ///      Matches spec finalization pseudocode step 1-2.
    function _computeCappedDemand() internal {
        (uint256 globalCapped, uint256[3] memory perHopCapped) = _iterateCappedDemand();
        for (uint8 h = 0; h < NUM_HOPS; h++) {
            hopStats[h].cappedCommitted = perHopCapped[h];
        }
        cappedDemand = globalCapped;
    }

}
