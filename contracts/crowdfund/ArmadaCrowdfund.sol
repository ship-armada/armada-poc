// ABOUTME: Word-of-mouth whitelist crowdfund with hop-based allocation.
// ABOUTME: Implements a hop-2 reserve with two-way rollover, a fixed sale size, a launch-team payment, and pro-rata refunds.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "@openzeppelin/contracts/utils/Multicall.sol";
import "./IArmadaCrowdfund.sol";

/// @notice Minimal ArmadaToken interface for atomic delegation on claim.
interface IArmadaTokenCrowdfund {
    function delegateOnBehalf(address delegator, address delegatee) external;
    function transferAndDelegate(address to, uint256 amount, address delegatee) external;
}

/// @title ArmadaCrowdfund — Word-of-mouth whitelist crowdfund with hop-based allocation
/// @notice Implements the full crowdfund lifecycle: seed management, invitation chains,
///         USDC commitment escrow, deterministic allocation with pro-rata scaling and rollover,
///         elastic expansion, and refund mechanism.
contract ArmadaCrowdfund is ReentrancyGuard, EIP712, Multicall {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    uint256 public constant BASE_SALE = 1_800_000 * 1e6;       // $1.8M USDC
    uint256 public constant MAX_SALE  = 1_800_000 * 1e6;       // $1.8M USDC (equal to BASE_SALE: no expansion)
    uint256 public constant MIN_SALE  =   250_000 * 1e6;       // $250k USDC
    uint256 public constant ARM_PRICE = 1e6;                    // $1.00 per ARM in USDC
    // Equal to BASE_SALE and MAX_SALE, so the sale size is $1.8M whatever the demand.
    uint256 public constant ELASTIC_TRIGGER = 1_800_000 * 1e6;
    uint8 public constant NUM_HOPS = 3;

    /// @dev ALLOCATION DESIGN NOTE. Allocation is computed against `saleSize` (BASE_SALE, or MAX_SALE
    ///      after expansion; both are $1.8M, so expansion has no effect). Hop-2 (invited contributors)
    ///      has first priority for HOP2_RESERVE_USDC; hop-0 (known contributors) gets up to the rest of
    ///      the sale, so its earmark is saleSize - HOP2_RESERVE_USDC ($1.5M) plus any reserve hop-2
    ///      leaves unused; capacity hop-0 leaves unused rolls back to hop-2 (see _computeHopAllocations):
    ///        hop-2 reserved = min(demand2, reserve)
    ///        hop-0          = min(demand0, saleSize - hop-2 reserved)
    ///        hop-1          = min(demand1, what remains)   (team inviter wallet, $0 cap: demand 0)
    ///        hop-2          = hop-2 reserved + min(demand2 - hop-2 reserved, what remains)
    ///      Total allocation is min(capped demand, saleSize). A hop is pro-rated only when total capped
    ///      demand exceeds saleSize.
    uint256 public constant HOP2_RESERVE_USDC = 300_000 * 1e6;  // $300k first-priority capacity for hop-2

    /// @notice Paid to the launch team (the `launchTeam` Safe) from the proceeds of a successful sale;
    ///         the rest goes to the treasury. No payment on a cancelled or refund-mode sale. Must not
    ///         exceed MIN_SALE, so a minimum sale always covers it.
    uint256 public constant TEAM_PAYMENT_USDC = 250_000 * 1e6;  // $250k

    /// @notice Per-slot effective USDC caps at each hop. Multiplied by `invitesReceived`
    ///         to derive an address's effective slot allowance at that hop.
    ///         Hop-0: known contributors. Hop-1: team-owned inviter wallets only; a $0 cap means
    ///         they never receive an allocation and any commit is refunded in full. Hop-2: invited
    ///         contributors (launch-team placements and team-wallet invite links).
    uint256 public constant HOP0_CAP_USDC = 100_000 * 1e6;
    uint256 public constant HOP1_CAP_USDC = 0;
    uint256 public constant HOP2_CAP_USDC = 10_000 * 1e6;

    /// @notice Per-hop outgoing-invite stacking caps (per `invitesReceived`). Only hop-1 (the team
    ///         inviter wallet) can invite, so every participant invite lands at hop-2.
    uint8 public constant HOP0_MAX_INVITES = 0;
    uint8 public constant HOP1_MAX_INVITES = 100;
    uint8 public constant HOP2_MAX_INVITES = 0;

    /// @notice Per-hop incoming-invite stacking caps (max edges that scale a node). Hop-0 and hop-1
    ///         take one slot per address; hop-2 stacks up to 20 slots ($10k each, $200k).
    uint16 public constant HOP0_MAX_INVITES_RECEIVED = 1;
    uint16 public constant HOP1_MAX_INVITES_RECEIVED = 1;
    uint16 public constant HOP2_MAX_INVITES_RECEIVED = 20;

    uint256 public constant WINDOW_DURATION = 5 days;
    // The launch-team invite window spans the full commitment window. launchTeamInvite/addSeed use a
    // strict `< launchTeamInviteEnd` check, so the launch team is closed out at exactly windowEnd while
    // participant invite/commit (`<= windowEnd`) remain open for that final second.
    uint256 public constant LAUNCH_TEAM_INVITE_PERIOD = WINDOW_DURATION;
    // Hard cap on the total window (windowStart to windowEnd) including any extendWindow calls.
    // Bounds how long participant USDC can stay locked before finalize becomes callable.
    uint256 public constant MAX_WINDOW_DURATION = 15 days;
    uint256 public constant CLAIM_DEADLINE_DURATION = 1095 days; // 3 years
    uint256 public constant MIN_COMMIT = 100 * 1e6;              // $100 USDC minimum per commit
    // Per-hop invite stacking caps are stored in hopConfigs[].maxInvitesReceived (1, 1, 20)
    uint16 public constant MAX_SEEDS = 500;                      // max number of seeds (hop-0 participants)
    uint8 public constant LAUNCH_TEAM_HOP1_BUDGET = 1;           // launch team direct hop-1 placements (the team inviter wallet)
    uint16 public constant LAUNCH_TEAM_HOP2_BUDGET = 500;        // launch team direct hop-2 invite slots
    // Hard cap on total participant nodes. finalize() iterates every node in one tx at ~8,200 gas/node
    // (cold); this bound keeps it under the 16,777,216 (2^24, EIP-7825) per-tx gas cap. 1,800 nodes
    // ≈ 15.2M gas (~9% margin). Enforced in _initParticipant. See the DESIGN NOTE on _iterateCappedDemand.
    uint256 public constant MAX_FINALIZE_NODES = 1800;

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
    // Pack 6-byte run into one slot (audit-68): Phase (1) + uint8 (1) + uint16 (2) + 2×bool (2) = 6 bytes.
    Phase public phase;
    uint8 public launchTeamHop1Used;     // launch-team invite budget tracking (hop-1)
    uint16 public launchTeamHop2Used;    // launch-team invite budget tracking (hop-2)
    bool public armLoaded;               // ARM pre-load verification
    bool public refundMode;              // true when finalize() entered refund mode (proceeds < MIN_SALE)

    // Timing. windowStart is fixed in the constructor. windowEnd and launchTeamInviteEnd are set
    // in the constructor and can only move later, together, via extendWindow (capped at
    // windowStart + MAX_WINDOW_DURATION).
    uint256 public immutable windowStart;
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
    uint256 public totalAllocatedArm;    // ARM (18 dec) — aggregate from hop-level computation
    uint256 public totalAllocatedUsdc;   // USDC (6 dec) — hop-level upper bound
    uint256[3] public finalCeilings;     // each hop's final USDC allocation (stored at finalization)
    uint256[3] public finalDemands;      // hop demands (stored at finalization)
    // Lazy evaluation accumulators (tracked during claims)
    uint256 public totalArmTransferred;  // exact sum of ARM transferred via claim()

    // Claim deadline — set at finalization, after which unclaimed ARM is sweepable
    uint256 public claimDeadline;

    /// @notice Timestamp when finalize() was called. Set on every finalization path
    ///         — success, capped-demand-below-MIN_SALE refund, and post-allocation
    ///         refund. Consumers that need to distinguish a successful sale from a
    ///         refundMode finalization must check `phase == Phase.Finalized && !refundMode`
    ///         in addition to `finalizedAt > 0`. Used by ArmadaGovernor to anchor the
    ///         10-day governance quiet period (which starts on any finalization,
    ///         including refundMode).
    uint256 public finalizedAt;

    // EIP-712 invite nonce tracking — used/revoked nonces per inviter
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    // Per-address claim tracking (lazy settlement — allocation computed at claim time)
    mapping(address => bool) public claimed;

    // ============ Events ============

    event SeedAdded(address indexed seed);
    event Invited(address indexed inviter, address indexed invitee, uint8 indexed hop, uint256 nonce);
    event LaunchTeamInvited(address indexed invitee, uint8 hop);
    event Committed(address indexed participant, uint8 indexed hop, uint256 amount);
    event Finalized(
        uint256 saleSize,
        uint256 allocatedArm,
        uint256 netProceeds,
        bool refundMode,
        uint256 cappedDemand,
        uint256 totalCommitted
    );
    event Cancelled(address indexed caller, uint256 timestamp);
    event LaunchTeamPaid(address indexed recipient, uint256 amount);
    event WindowExtended(uint256 previousEnd, uint256 newEnd);
    event RefundClaimed(address indexed participant, uint256 usdcAmount);
    event UnallocatedArmWithdrawn(address indexed treasury, uint256 amount);
    event ArmLoaded(address indexed caller, uint256 balance, uint256 required);
    event InviteNonceRevoked(address indexed inviter, uint256 nonce);
    event Allocated(address indexed participant, uint256 armTransferred, uint256 refundUsdc, address delegate);
    event AllocatedHop(address indexed participant, uint8 indexed hop, uint256 acceptedUsdc);

    // ============ Modifiers ============

    modifier onlyLaunchTeam() {
        require(msg.sender == launchTeam, "ArmadaCrowdfund: not launch team");
        _;
    }

    // ============ Constructor ============

    /// @param _openTimestamp When the active window (WINDOW_DURATION, extendable) begins (must be >= block.timestamp)
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

        // ceilingBps is not used by the allocation (see ALLOCATION DESIGN NOTE); it stays 0 and is kept
        // so the hopConfigs() getter keeps its shape for off-chain readers.
        hopConfigs[0] = HopConfig({ ceilingBps: 0, capUsdc: HOP0_CAP_USDC, maxInvites: HOP0_MAX_INVITES, maxInvitesReceived: HOP0_MAX_INVITES_RECEIVED });
        hopConfigs[1] = HopConfig({ ceilingBps: 0, capUsdc: HOP1_CAP_USDC, maxInvites: HOP1_MAX_INVITES, maxInvitesReceived: HOP1_MAX_INVITES_RECEIVED });
        hopConfigs[2] = HopConfig({ ceilingBps: 0, capUsdc: HOP2_CAP_USDC, maxInvites: HOP2_MAX_INVITES, maxInvitesReceived: HOP2_MAX_INVITES_RECEIVED });
    }

    // ============ Seed Management ============

    /// @notice Add seed addresses (hop 0). Allowed during the launch-team window (requires ARM loaded).
    function addSeeds(address[] calldata seeds) external onlyLaunchTeam {
        _requireArmLoadedAndPreInviteEnd();
        for (uint256 i = 0; i < seeds.length; i++) {
            _addSeed(seeds[i]);
        }
    }

    /// @notice Add a single seed address (hop 0). Allowed during the launch-team window (requires ARM loaded).
    function addSeed(address seed) external onlyLaunchTeam {
        _requireArmLoadedAndPreInviteEnd();
        _addSeed(seed);
    }

    function _addSeed(address seed) internal {
        require(seed != address(0), "ArmadaCrowdfund: zero address");
        require(seed != launchTeam, "ArmadaCrowdfund: launchTeam cannot be a seed");
        require(hopStats[0].whitelistCount < MAX_SEEDS, "ArmadaCrowdfund: seed cap reached");
        require(!participants[seed][0].isWhitelisted, "ArmadaCrowdfund: already whitelisted");

        _initParticipant(seed, 0, address(0));

        emit SeedAdded(seed);
    }

    /// @dev Initialize a new participant node at the given hop.
    function _initParticipant(address participant, uint8 hop, address inviter_) private {
        // Bound total nodes so one-shot finalize() stays under the 16,777,216 (2^24, EIP-7825)
        // per-tx gas cap. Single choke point for all node creation (seeds + every invite path).
        require(participantNodes.length < MAX_FINALIZE_NODES, "ArmadaCrowdfund: node cap reached");
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
        emit ArmLoaded(msg.sender, balance, requiredArm);
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
        require(msg.sender != launchTeam, "ArmadaCrowdfund: launchTeam cannot invite via regular path");
        require(invitee != launchTeam, "ArmadaCrowdfund: launchTeam cannot be invitee");

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

    /// @notice Launch team issues a direct invite at hop-1 or hop-2 during its invite window
    ///         (which spans the full commitment window).
    ///         The launch team is a sentinel with predeclared invite budgets — it is not
    ///         a participant and cannot commit USDC.
    /// @param invitee Address to invite
    /// @param fromHop Source hop level (0 = invite to hop-1, 1 = invite to hop-2)
    function launchTeamInvite(address invitee, uint8 fromHop) external {
        require(msg.sender == launchTeam, "ArmadaCrowdfund: not launch team");
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(armLoaded, "ArmadaCrowdfund: ARM not loaded");
        // Revert string kept stable (despite the window spanning the full sale) because
        // off-chain tooling (admin UI error mapping) matches on it.
        require(
            block.timestamp >= windowStart && block.timestamp < launchTeamInviteEnd,
            "ArmadaCrowdfund: outside week-1 window"
        );
        require(fromHop == 0 || fromHop == 1, "ArmadaCrowdfund: invalid hop for launch team");
        require(invitee != address(0), "ArmadaCrowdfund: zero address");
        require(invitee != launchTeam, "ArmadaCrowdfund: launchTeam cannot be invitee");

        uint8 inviteeHop = fromHop + 1;

        if (fromHop == 0) {
            require(launchTeamHop1Used < LAUNCH_TEAM_HOP1_BUDGET, "ArmadaCrowdfund: hop-1 budget exhausted");
            launchTeamHop1Used++;
        } else {
            require(launchTeamHop2Used < LAUNCH_TEAM_HOP2_BUDGET, "ArmadaCrowdfund: hop-2 budget exhausted");
            launchTeamHop2Used++;
        }

        _registerOrStackInvite(invitee, inviteeHop, msg.sender);

        emit Invited(launchTeam, invitee, inviteeHop, 0);
        emit LaunchTeamInvited(invitee, inviteeHop);
    }

    // ============ Window Extension ============

    /// @notice Launch team extends the commitment window. Moves windowEnd and launchTeamInviteEnd
    ///         together, so commits, participant invites and launch-team whitelisting all stay open
    ///         until the new end. Can be called repeatedly, each time to a later end.
    /// @dev Only callable while the window is still open (block.timestamp <= windowEnd). Once
    ///      windowEnd has passed, anyone may finalize, so allowing an extension then would let the
    ///      launch team reopen a closed sale. The total window is capped at MAX_WINDOW_DURATION
    ///      from windowStart.
    /// @param newEnd New windowEnd timestamp. Must be later than the current windowEnd and no later
    ///        than windowStart + MAX_WINDOW_DURATION.
    function extendWindow(uint256 newEnd) external onlyLaunchTeam {
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        // Cache windowEnd: read three times below.
        uint256 previousEnd = windowEnd;
        require(block.timestamp <= previousEnd, "ArmadaCrowdfund: window ended");
        require(newEnd > previousEnd, "ArmadaCrowdfund: must extend window");
        require(newEnd <= windowStart + MAX_WINDOW_DURATION, "ArmadaCrowdfund: exceeds max window");

        windowEnd = newEnd;
        // The launch-team window spans the full commitment window (see LAUNCH_TEAM_INVITE_PERIOD).
        launchTeamInviteEnd = newEnd;

        emit WindowExtended(previousEnd, newEnd);
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
        emit Cancelled(msg.sender, block.timestamp);
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
        // _computeCappedDemand returns the values it just wrote so we don't
        // SLOAD cappedDemand or hopStats[*].cappedCommitted right back (audit-75).
        (uint256 capped, uint256[3] memory perHopCapped) = _computeCappedDemand();

        // If capped demand is below minimum raise, enter refund mode immediately.
        // No allocations to compute — all participants get full USDC refunds.
        if (capped < MIN_SALE) {
            refundMode = true;
            phase = Phase.Finalized;
            finalizedAt = block.timestamp;
            emit Finalized(0, 0, 0, true, capped, totalCommitted);
            return;
        }

        // Step 1: Elastic expansion (based on capped demand). Compute into a local
        // and store once, avoiding re-SLOADs of saleSize in the steps below (audit-76).
        uint256 saleSize_ = capped >= ELASTIC_TRIGGER ? MAX_SALE : BASE_SALE;
        saleSize = saleSize_;

        // Step 2: Per-hop allocation (see ALLOCATION DESIGN NOTE): hop-2's reserve first, hop-0
        // up to the rest of the sale, unused hop-0 capacity rolling back to hop-2.

        // _computeHopAllocations sets finalCeilings/finalDemands needed by _computeAllocation
        // and returns the hop-level USDC total for the refundMode check below, plus whether any
        // hop is pro-rated (the only case with rounding dust).
        // perHopCapped is passed in to avoid re-SLOADing hopStats[h].cappedCommitted (audit-75).
        (uint256 totalAllocUsdc_, bool anyProRated) = _computeHopAllocations(saleSize_, perHopCapped);

        // Post-allocation minimum raise check: if net proceeds (allocated USDC) fall
        // below MIN_SALE, enter refundMode. Participants get full USDC refunds via
        // claimRefund(); no ARM is distributed. Allocated USDC equals
        // min(capped demand, saleSize), so this cannot trigger once the capped-demand
        // check above has passed; it remains as a guard.
        if (totalAllocUsdc_ < MIN_SALE) {
            refundMode = true;
            phase = Phase.Finalized;
            finalizedAt = block.timestamp;
            emit Finalized(saleSize_, 0, 0, true, capped, totalCommitted);
            return;
        }

        // Step 3: Store aggregate hop-level results. Per-participant allocations
        // are computed lazily at claim() time (user-borne gas).
        // Compute totalAllocatedArm into a local first to avoid re-SLOAD in the
        // Finalized emit at the end of the function (audit-76).
        uint256 allocatedArm = (totalAllocUsdc_ * 1e18) / ARM_PRICE;
        totalAllocatedUsdc = totalAllocUsdc_;
        totalAllocatedArm = allocatedArm;
        claimDeadline = block.timestamp + CLAIM_DEADLINE_DURATION;
        phase = Phase.Finalized;
        finalizedAt = block.timestamp;

        // Pay the launch team and push the rest of the net proceeds to the treasury. When a hop is
        // pro-rated, retain a rounding buffer so the contract never runs short on refund payouts:
        // lazy per-participant floor divisions can sum to slightly less than totalAllocatedUsdc,
        // making the aggregate refund slightly larger. Without pro-rating there is no floor
        // division and no dust, so nothing is held back and a minimum sale splits exactly.
        //
        // Buffer = participantNodes.length (one USDC unit per participantNode entry).
        //
        // Tight upper bound on dust:
        //   For each oversubscribed hop with N committers, per-participant alloc =
        //   floor(cappedCommitted_i * finalCeilings[h] / finalDemands[h]). The exact
        //   rational sum across the hop's committers equals finalCeilings[h]; each
        //   floor loses < 1 unit, so actual_sum > finalCeilings[h] - N. Hop dust < N.
        //   Under-subscribed hops do no floor division, dust = 0.
        //   Total dust < (committers across all oversubscribed hops) ≤ participantNodes.length.
        //   participantNodes.length is one entry per (address, hop) registration, which
        //   is robust to any future refactor that allows multi-hop commits per address —
        //   each (address, hop) tuple corresponds to at most one floor-division call.
        //
        // Invariant note: the spec requires netProceeds + sum(refunds) == totalCommitted
        // as a settlement-completion identity. When a hop is pro-rated, the rounding buffer
        // means the treasury receives slightly less than totalAllocatedUsdc - teamPayment, with
        // the difference (at most participantNodes.length USDC units) stranded in the contract
        // as unrecoverable dust. The identity still holds at the contract level:
        // teamPayment + treasuryReceived + contractDust + sum(refunds) == totalCommitted.
        uint256 roundingBuffer = anyProRated ? participantNodes.length : 0;
        uint256 distributable = totalAllocUsdc_ > roundingBuffer
            ? totalAllocUsdc_ - roundingBuffer
            : 0;
        // TEAM_PAYMENT_USDC <= MIN_SALE <= totalAllocUsdc_, and a buffer exists only when a hop is
        // pro-rated (total = saleSize), so distributable always covers the payment; the min() keeps
        // finalize from reverting even if that ever stopped holding.
        uint256 teamPayment = distributable < TEAM_PAYMENT_USDC ? distributable : TEAM_PAYMENT_USDC;
        usdc.safeTransfer(launchTeam, teamPayment);
        usdc.safeTransfer(treasury, distributable - teamPayment);
        emit LaunchTeamPaid(launchTeam, teamPayment);

        emit Finalized(saleSize_, allocatedArm, totalAllocUsdc_, false, capped, totalCommitted);
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
        uint256 totalAllocArm;
        uint256 totalRefundUsdc;
        for (uint8 h = 0; h < NUM_HOPS; h++) {
            Participant storage p = participants[msg.sender][h];
            // Cache p.committed: read again below in _computeAllocation (audit-76).
            uint256 committed = p.committed;
            if (committed == 0) continue;

            (uint256 allocArm, uint256 allocUsdc, uint256 hopRefund) = _computeAllocation(committed, h, _effectiveCap(p, h));
            totalAllocArm += allocArm;
            totalRefundUsdc += hopRefund;

            if (allocUsdc > 0) emit AllocatedHop(msg.sender, h, allocUsdc);
        }

        // ARM: only transfer if within claim deadline
        uint256 armTransferred;
        if (block.timestamp <= claimDeadline && totalAllocArm > 0) {
            require(delegate != address(0), "ArmadaCrowdfund: delegate required");
            armTransferred = totalAllocArm;
            totalArmTransferred += armTransferred;
            // Combined transfer + delegateOnBehalf — atomic by construction, one CALL.
            IArmadaTokenCrowdfund(address(armToken)).transferAndDelegate(msg.sender, armTransferred, delegate);
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
        // Cache phase: read twice in the require check (audit-76).
        Phase ph = phase;
        require(
            ph == Phase.Finalized || ph == Phase.Canceled,
            "ArmadaCrowdfund: not finalized or canceled"
        );

        uint256 armBalance = armToken.balanceOf(address(this));
        uint256 stillOwed = armStillOwed();
        uint256 sweepable = armBalance - stillOwed;
        require(sweepable > 0, "ArmadaCrowdfund: nothing to sweep");

        armToken.safeTransfer(treasury, sweepable);

        emit UnallocatedArmWithdrawn(treasury, sweepable);
    }

    /// @notice ARM still owed to participants (allocated minus already transferred).
    /// @dev Pre-finalize / Cancel / refundMode / post-claim-deadline all return 0 —
    ///      no participant has a live ARM claim against the contract in those states.
    ///      Used by ArmadaRedemption.circulatingSupply to count entitled-unclaimed
    ///      ARM as circulating: subtract `balance - armStillOwed()` (the unsold
    ///      portion still in this contract that will be swept to treasury), not the
    ///      full balance.
    function armStillOwed() public view returns (uint256 owed) {
        // Named return defaults to 0 — fall-through covers Active/Canceled,
        // refundMode, and post-claim-deadline (audit-64).
        if (phase == Phase.Finalized && !refundMode && block.timestamp <= claimDeadline) {
            owed = totalAllocatedArm - totalArmTransferred;
        }
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
    ///         In refundMode the deterministic answer is (0 ARM, sum of committed USDC).
    function computeAllocation(address addr) public view returns (
        uint256 armAmount,
        uint256 refundUsdc
    ) {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        bool refundModeCache = refundMode;

        for (uint8 h = 0; h < NUM_HOPS; h++) {
            Participant storage p = participants[addr][h];
            // Cache p.committed: read again in _computeAllocation (audit-76).
            uint256 committed = p.committed;
            if (committed == 0) continue;

            if (refundModeCache) {
                refundUsdc += committed;
                continue;
            }
            (uint256 allocArm, , uint256 hopRefund) = _computeAllocation(committed, h, _effectiveCap(p, h));
            armAmount += allocArm;
            refundUsdc += hopRefund;
        }
    }

    /// @notice Compute allocation at a specific hop (only after finalization).
    ///         In refundMode the deterministic answer is (0 ARM, p.committed).
    function computeAllocationAtHop(address addr, uint8 hop) external view returns (
        uint256 armAmount,
        uint256 refundUsdc
    ) {
        require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
        Participant storage p = participants[addr][hop];

        if (refundMode) {
            return (0, p.committed);
        }
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
    function getLaunchTeamBudgetRemaining() external view returns (uint16 hop1Remaining, uint16 hop2Remaining) {
        hop1Remaining = LAUNCH_TEAM_HOP1_BUDGET - launchTeamHop1Used;
        hop2Remaining = LAUNCH_TEAM_HOP2_BUDGET - launchTeamHop2Used;
    }

    /// @notice Get total number of (address, hop) nodes (not unique addresses)
    function getParticipantCount() external view returns (uint256) {
        return participantNodes.length;
    }

    // ============ Internal ============

    /// @dev Enforces that seeds can only be added during the launch-team window (requires ARM loaded).
    function _requireArmLoadedAndPreInviteEnd() internal view {
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(armLoaded, "ArmadaCrowdfund: ARM not loaded");
        // Revert string kept stable (despite the window spanning the full sale) because
        // off-chain tooling (admin UI error mapping) matches on it.
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
        bool hasCommitment;
        for (uint8 h = 0; h < NUM_HOPS; h++) {
            if (participants[msg.sender][h].committed > 0) {
                hasCommitment = true;
                break;
            }
        }
        require(hasCommitment, "ArmadaCrowdfund: no commitment");
    }

    /// @dev Enforces the active commit window (phase, ARM loaded, windowStart..windowEnd inclusive).
    function _requireActiveCommitWindow() internal view {
        require(phase == Phase.Active, "ArmadaCrowdfund: not active");
        require(armLoaded, "ArmadaCrowdfund: ARM not loaded");
        require(
            block.timestamp >= windowStart && block.timestamp <= windowEnd,
            "ArmadaCrowdfund: not active window"
        );
    }

    /// @dev Compute hop-level allocations and store results in finalCeilings/finalDemands.
    ///      Extracted from finalize() to avoid stack-too-deep. Takes the per-hop
    ///      capped totals as a parameter so it doesn't have to re-SLOAD
    ///      hopStats[h].cappedCommitted that _computeCappedDemand just wrote (audit-75).
    ///      finalCeilings[h] is the hop's final allocation: _computeAllocation fills a participant
    ///      in full when demand <= ceiling and pro-rates by ceiling / demand otherwise.
    ///      Returns the total allocated USDC and whether any hop is pro-rated (demand > allocation).
    function _computeHopAllocations(uint256 saleSize_, uint256[3] memory perHopCapped)
        internal
        returns (uint256 totalAllocUsdc_, bool anyProRated)
    {
        // --- Hop-2 reserve: first priority, up to HOP2_RESERVE_USDC (never more than the sale) ---
        uint256 reserve = HOP2_RESERVE_USDC < saleSize_ ? HOP2_RESERVE_USDC : saleSize_;
        uint256 demand2 = perHopCapped[2];
        uint256 alloc2 = demand2 < reserve ? demand2 : reserve;
        uint256 remaining = saleSize_ - alloc2;

        // --- Hop-0: up to the rest of the sale (its earmark plus any unused hop-2 reserve) ---
        // Uses cappedCommitted (set by _computeCappedDemand) — over-cap deposits excluded
        uint256 demand = perHopCapped[0];
        uint256 alloc = demand < remaining ? demand : remaining;
        remaining -= alloc;
        finalCeilings[0] = alloc;
        finalDemands[0] = demand;
        totalAllocUsdc_ = alloc;
        anyProRated = demand > alloc;

        // --- Hop-1: from what remains (the team inviter wallet has a $0 cap, so demand is 0) ---
        demand = perHopCapped[1];
        alloc = demand < remaining ? demand : remaining;
        remaining -= alloc;
        finalCeilings[1] = alloc;
        finalDemands[1] = demand;
        totalAllocUsdc_ += alloc;
        anyProRated = anyProRated || demand > alloc;

        // --- Hop-2: its reserve plus any capacity hop-0 and hop-1 left unused ---
        uint256 extra2 = demand2 - alloc2;
        alloc2 += extra2 < remaining ? extra2 : remaining;
        finalCeilings[2] = alloc2;
        finalDemands[2] = demand2;
        totalAllocUsdc_ += alloc2;
        anyProRated = anyProRated || demand2 > alloc2;
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

        // Cache hop-indexed slots — each is read in the branch below (audit-76).
        uint256 demand = finalDemands[hop];
        uint256 ceiling = finalCeilings[hop];
        if (demand <= ceiling) {
            // Under-subscribed: full allocation of capped amount
            allocUsdc = cappedCommitted;
        } else {
            // Over-subscribed: pro-rata of capped amount
            allocUsdc = (cappedCommitted * ceiling) / demand;
        }
        allocArm = (allocUsdc * 1e18) / ARM_PRICE;
        // Refund = raw committed minus allocated (includes over-cap excess + pro-rata excess)
        refundUsdc = committed - allocUsdc;
    }

    /// @dev Pure iteration: compute capped demand per hop and globally without writing state.
    ///      DESIGN NOTE: This iterates the full participantNodes array — O(n) where n is total
    ///      participants across all hops. The array is bounded by invite chain limits:
    ///      MAX_SEEDS (500) at hop-0, the launch-team budgets, and HOPx_MAX_INVITES at each hop.
    ///      With the current constants (hop-0 and hop-2 cannot invite; 1 launch-team hop-1 team
    ///      wallet x 100 invites; 500 launch-team hop-2 placements; stacking adds slots, not nodes)
    ///      the structural maximum is 1,101 nodes. MAX_FINALIZE_NODES remains the hard bound for any
    ///      configuration.
    ///      Cold-storage cost is ~8,200 gas/node (measured; test-foundry/CrowdfundFinalizeGasCold.t.sol);
    ///      an invited-but-uncommitted node still costs ~4,950 gas (2 cold SLOADs before the skip),
    ///      so cost scales with whitelist count, not commit count. A single Ethereum transaction is
    ///      capped at 16,777,216 gas (2^24, EIP-7825); a node count above ~2,000 would make one-shot
    ///      finalize() unsubmittable. Total node count is therefore capped at MAX_FINALIZE_NODES
    ///      (enforced in _initParticipant): 1,800 nodes ≈ 15.2M gas, ~9% under the cap. The current
    ///      1,101-node structural maximum is well under that (re-measured in CrowdfundFinalizeGasCold).
    ///      NOTE: an earlier profile (test-foundry/CrowdfundFinalizeGas.t.sol) reported ~2,220 gas
    ///      per iteration / ~4.2M at max, but it measured WARM slots and understates a real
    ///      cold-first-touch transaction by ~3.6x; do not rely on it.
    function _iterateCappedDemand() internal view returns (
        uint256 globalCapped,
        uint256[3] memory perHopCapped
    ) {
        uint256 len = participantNodes.length;
        for (uint256 i = 0; i < len; i++) {
            ParticipantNode storage node = participantNodes[i];
            // Cache storage-pointer fields once per iteration (audit-76).
            address addr = node.addr;
            uint8 hop = node.hop;
            Participant storage p = participants[addr][hop];
            uint256 committed = p.committed;
            if (committed == 0) continue;

            uint256 cap = _effectiveCap(p, hop);
            uint256 capped = committed < cap ? committed : cap;
            perHopCapped[hop] += capped;
            globalCapped += capped;
        }
    }

    /// @dev Compute capped demand and write results to hopStats and cappedDemand.
    ///      Matches spec finalization pseudocode step 1-2. Also returns the
    ///      computed values so callers don't have to SLOAD them right back
    ///      (audit-75); state writes preserved for external readers.
    function _computeCappedDemand() internal returns (uint256 globalCapped, uint256[3] memory perHopCapped) {
        (globalCapped, perHopCapped) = _iterateCappedDemand();
        for (uint8 h = 0; h < NUM_HOPS; h++) {
            hopStats[h].cappedCommitted = perHopCapped[h];
        }
        cappedDemand = globalCapped;
    }

}
