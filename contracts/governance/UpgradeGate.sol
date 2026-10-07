// SPDX-License-Identifier: MIT
// ABOUTME: Launch Team co-sign for governance proposals that upgrade contracts or authorize ARM delegators.
// ABOUTME: The governor refuses to execute such a proposal unless the Launch Team approved that exact proposal.
pragma solidity ^0.8.17;

/// @title UpgradeGate — Launch Team approval for permanent-takeover governance actions
/// @notice A proposal containing any gated action (`upgradeTo`, `upgradeToAndCall` on any target,
///         or `addAuthorizedDelegator`) can only execute if the Launch Team has approved that exact
///         proposal. Governance alone cannot execute it, and the Launch Team alone cannot create it.
///         All other proposals pass through untouched.
/// @dev Approvals bind `keccak256(abi.encode(proposalId, targets, values, calldatas))`. Proposal
///      ids are unique and the governor executes each proposal at most once, so an approval can
///      never be reused by a later proposal — even one with identical actions (e.g. re-proposing
///      an older, since-replaced implementation). The gate serves exactly one governor.
///      The gated selector list is fixed in code and the team address can only be changed by the
///      team itself, so governance cannot weaken or redirect the gate. Not upgradeable.
contract UpgradeGate {
    // ============ Gated Selectors ============

    bytes4 internal constant UPGRADE_TO_SELECTOR = bytes4(keccak256("upgradeTo(address)"));
    bytes4 internal constant UPGRADE_TO_AND_CALL_SELECTOR = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
    bytes4 internal constant ADD_AUTHORIZED_DELEGATOR_SELECTOR = bytes4(keccak256("addAuthorizedDelegator(address)"));

    // ============ State ============

    /// @notice The Launch Team multisig whose approval gated proposals require.
    address public launchTeam;

    /// @notice Nominated successor team; becomes `launchTeam` only when it accepts.
    address public pendingLaunchTeam;

    /// @notice Approved proposal hashes (see proposalHash).
    mapping(bytes32 => bool) public approved;

    // ============ Events ============

    event ProposalApproved(uint256 indexed proposalId, bytes32 proposalHash);
    event ProposalApprovalRevoked(uint256 indexed proposalId, bytes32 proposalHash);
    event LaunchTeamTransferStarted(address indexed currentTeam, address indexed pendingTeam);
    event LaunchTeamTransferred(address indexed previousTeam, address indexed newTeam);

    // ============ Errors ============

    error Gate_ZeroAddress();
    error Gate_NotLaunchTeam();
    error Gate_NotPendingLaunchTeam();
    error Gate_NotApproved(uint256 proposalId);

    // ============ Constructor ============

    /// @param _launchTeam The Launch Team multisig (2-of-3 Safe in production).
    constructor(address _launchTeam) {
        if (_launchTeam == address(0)) revert Gate_ZeroAddress();
        launchTeam = _launchTeam;
    }

    modifier onlyLaunchTeam() {
        if (msg.sender != launchTeam) revert Gate_NotLaunchTeam();
        _;
    }

    // ============ Approval ============

    /// @notice Approve one proposal exactly as it was proposed. Takes the full action list (rather
    ///         than a hash) so signers review the actual targets and calldata they approve.
    function approve(
        uint256 proposalId,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas
    ) external onlyLaunchTeam {
        bytes32 h = proposalHash(proposalId, targets, values, calldatas);
        approved[h] = true;
        emit ProposalApproved(proposalId, h);
    }

    /// @notice Withdraw an approval. Effective for any proposal not yet executed.
    function revoke(
        uint256 proposalId,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas
    ) external onlyLaunchTeam {
        bytes32 h = proposalHash(proposalId, targets, values, calldatas);
        approved[h] = false;
        emit ProposalApprovalRevoked(proposalId, h);
    }

    // ============ Governor Hook ============

    /// @notice Revert unless the proposal has no gated action or the Launch Team approved it.
    ///         Called by the governor immediately before execution.
    function check(
        uint256 proposalId,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas
    ) external view {
        if (!requiresApproval(calldatas)) return;
        if (!approved[proposalHash(proposalId, targets, values, calldatas)]) {
            revert Gate_NotApproved(proposalId);
        }
    }

    // ============ Views ============

    /// @notice Whether a selector is one of the gated permanent-takeover calls.
    function isGated(bytes4 selector) public pure returns (bool) {
        return selector == UPGRADE_TO_SELECTOR
            || selector == UPGRADE_TO_AND_CALL_SELECTOR
            || selector == ADD_AUTHORIZED_DELEGATOR_SELECTOR;
    }

    /// @notice Whether any action in the proposal is gated. Calldata shorter than a selector
    ///         (e.g. a plain ETH transfer) carries no call and is never gated.
    function requiresApproval(bytes[] calldata calldatas) public pure returns (bool) {
        for (uint256 i = 0; i < calldatas.length; i++) {
            if (calldatas[i].length >= 4 && isGated(bytes4(calldatas[i][:4]))) return true;
        }
        return false;
    }

    /// @notice Whether this exact proposal is currently approved.
    function isApproved(
        uint256 proposalId,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas
    ) external view returns (bool) {
        return approved[proposalHash(proposalId, targets, values, calldatas)];
    }

    /// @notice The hash an approval binds: proposal id plus every action, in order.
    function proposalHash(
        uint256 proposalId,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(proposalId, targets, values, calldatas));
    }

    // ============ Team Rotation ============

    /// @notice Nominate a successor team. Takes effect only when the nominee calls
    ///         acceptLaunchTeam, so a mistyped address cannot strand the gate. Nominating
    ///         again (including the current team) replaces any pending nomination.
    function transferLaunchTeam(address newTeam) external onlyLaunchTeam {
        if (newTeam == address(0)) revert Gate_ZeroAddress();
        pendingLaunchTeam = newTeam;
        emit LaunchTeamTransferStarted(launchTeam, newTeam);
    }

    /// @notice Complete a handover. Only the nominated team can accept.
    function acceptLaunchTeam() external {
        if (msg.sender != pendingLaunchTeam) revert Gate_NotPendingLaunchTeam();
        address previous = launchTeam;
        launchTeam = msg.sender;
        pendingLaunchTeam = address(0);
        emit LaunchTeamTransferred(previous, msg.sender);
    }
}
