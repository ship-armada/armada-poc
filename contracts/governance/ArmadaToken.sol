// SPDX-License-Identifier: MIT
// ABOUTME: ARM governance token with ERC20Votes for on-chain delegation and voting checkpoints.
// ABOUTME: Transfer-restricted until wind-down; treasury address blocked from delegation.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";

/// @title ArmadaToken — ARM governance token with delegation and transfer restrictions
/// @notice ERC20Votes provides Compound-style delegation and voting power checkpoints.
///         Tokens have zero voting power until delegated. Transfer-restricted until wind-down
///         enables free transfers via setTransferable(true).
contract ArmadaToken is ERC20Votes {
    uint256 public constant INITIAL_SUPPLY = 1_000 * 1e18; // 1K ARM (mini-Sepolia)

    // ============ Immutable References ============

    address public immutable timelock;
    address public immutable tokenDeployer;

    // ============ Transfer Restriction State ============

    /// @notice When false, only whitelisted senders can transfer. Starts false.
    bool public transferable;

    /// @notice Addresses exempt from transfer restrictions (add-only, no removal).
    mapping(address => bool) public transferWhitelist;
    bool public whitelistInitialized;

    /// @notice The wind-down contract is the only address that can call setTransferable.
    address public windDownContract;
    bool public windDownContractSet;

    // ============ Delegation Restriction State ============

    /// @notice Addresses blocked from delegating (e.g. treasury). Their ARM never enters
    ///         the voting power denominator.
    mapping(address => bool) public noDelegation;
    bool public noDelegationSet;

    // ============ Authorized Delegator State ============

    /// @notice Contracts authorized to call delegateOnBehalf (e.g. RevenueLock, Crowdfund).
    mapping(address => bool) public authorizedDelegator;
    bool public authorizedDelegatorsInitialized;

    // ============ Events ============

    event WhitelistAdded(address indexed account);
    event WhitelistRemoved(address indexed account);
    event WhitelistInitialized(address[] accounts);
    event TransferableSet(bool transferable);
    event WindDownContractSet(address indexed windDownContract);
    event NoDelegationInitialized(address[] accounts);
    event AuthorizedDelegatorsInitialized(address[] delegators);
    event AuthorizedDelegatorAdded(address indexed delegator);

    // ============ Constructor ============

    /// @param initialHolder Address that receives the entire initial supply
    /// @param _timelock TimelockController address (for governance-gated addToWhitelist)
    constructor(
        address initialHolder,
        address _timelock
    ) ERC20("Armada", "ARM") ERC20Permit("Armada") {
        require(initialHolder != address(0), "ArmadaToken: zero initialHolder");
        require(_timelock != address(0), "ArmadaToken: zero timelock");
        timelock = _timelock;
        tokenDeployer = msg.sender;
        _mint(initialHolder, INITIAL_SUPPLY);
    }

    // ============ One-Time Setup (deployer-only, pre-renounce) ============

    /// @notice Set initial whitelist addresses. Callable once by deployer.
    ///         Matches the setExcludedAddresses pattern in ArmadaGovernor.
    function initWhitelist(address[] calldata accounts) external {
        require(msg.sender == tokenDeployer, "ArmadaToken: not deployer");
        require(!whitelistInitialized, "ArmadaToken: whitelist already initialized");
        whitelistInitialized = true;
        for (uint256 i = 0; i < accounts.length; i++) {
            require(accounts[i] != address(0), "ArmadaToken: zero address");
            transferWhitelist[accounts[i]] = true;
        }
        emit WhitelistInitialized(accounts);
    }

    /// @notice Set the wind-down contract address. Callable once by deployer.
    function setWindDownContract(address _windDownContract) external {
        require(msg.sender == tokenDeployer, "ArmadaToken: not deployer");
        require(!windDownContractSet, "ArmadaToken: wind-down already set");
        require(_windDownContract != address(0), "ArmadaToken: zero address");
        windDownContractSet = true;
        windDownContract = _windDownContract;
        emit WindDownContractSet(_windDownContract);
    }

    /// @notice Set addresses blocked from delegation (e.g. treasury). Callable once by deployer.
    ///         Follows the same one-time array pattern as initWhitelist and initAuthorizedDelegators.
    function initNoDelegation(address[] calldata accounts) external {
        require(msg.sender == tokenDeployer, "ArmadaToken: not deployer");
        require(!noDelegationSet, "ArmadaToken: noDelegation already set");
        noDelegationSet = true;
        for (uint256 i = 0; i < accounts.length; i++) {
            require(accounts[i] != address(0), "ArmadaToken: zero address");
            noDelegation[accounts[i]] = true;
        }
        emit NoDelegationInitialized(accounts);
    }

    /// @notice Set contracts authorized to call delegateOnBehalf. Callable once by deployer.
    ///         Follows the same one-time pattern as initWhitelist.
    function initAuthorizedDelegators(address[] calldata delegators) external {
        require(msg.sender == tokenDeployer, "ArmadaToken: not deployer");
        require(!authorizedDelegatorsInitialized, "ArmadaToken: delegators already initialized");
        authorizedDelegatorsInitialized = true;
        for (uint256 i = 0; i < delegators.length; i++) {
            require(delegators[i] != address(0), "ArmadaToken: zero address");
            authorizedDelegator[delegators[i]] = true;
        }
        emit AuthorizedDelegatorsInitialized(delegators);
    }

    // ============ Governance Functions ============

    /// @notice Add an address to the transfer whitelist. Timelock-only, add-only (no removal).
    function addToWhitelist(address account) external {
        require(msg.sender == timelock, "ArmadaToken: not timelock");
        require(account != address(0), "ArmadaToken: zero address");
        transferWhitelist[account] = true;
        emit WhitelistAdded(account);
    }

    /// @notice Authorize a contract to call delegateOnBehalf. Timelock-only, add-only (no removal).
    ///         Mirrors the addToWhitelist pattern to allow governance to authorize new delegators
    ///         (e.g. follow-on RevenueLock cohorts or replacement Crowdfund instances) after
    ///         deployment without requiring token redeployment.
    function addAuthorizedDelegator(address delegator) external {
        require(msg.sender == timelock, "ArmadaToken: not timelock");
        require(delegator != address(0), "ArmadaToken: zero address");
        authorizedDelegator[delegator] = true;
        emit AuthorizedDelegatorAdded(delegator);
    }

    /// @notice Remove the deployer from the transfer whitelist. Deployer-only, callable once.
    ///         The deployer is whitelisted during deployment to distribute ARM tokens.
    ///         After distribution completes and the deployer holds 0 ARM, this removes the
    ///         residual whitelist entry to eliminate the deployer as a transfer-capable address.
    function removeDeployerFromWhitelist() external {
        require(msg.sender == tokenDeployer, "ArmadaToken: not deployer");
        require(transferWhitelist[tokenDeployer], "ArmadaToken: deployer not whitelisted");
        transferWhitelist[tokenDeployer] = false;
        emit WhitelistRemoved(tokenDeployer);
    }

    /// @notice Enable unrestricted transfers. Callable by the wind-down contract
    ///         or the governor executor (timelock) via governance proposal.
    ///         One-way: transfers cannot be re-restricted once enabled.
    function setTransferable(bool _transferable) external {
        require(
            msg.sender == windDownContract || msg.sender == timelock,
            "ArmadaToken: not authorized"
        );
        require(_transferable, "ArmadaToken: can only enable transfers");
        require(!transferable, "ArmadaToken: transfers already enabled");
        transferable = true;
        emit TransferableSet(true);
    }

    /// @notice Delegate voting power on behalf of another address. Only callable by
    ///         authorized contracts (e.g. RevenueLock, Crowdfund) for atomic transfer+delegation.
    /// @param delegator The address whose voting power is being delegated
    /// @param delegatee The address to receive the voting power
    function delegateOnBehalf(address delegator, address delegatee) external {
        require(authorizedDelegator[msg.sender], "ArmadaToken: not authorized delegator");
        _delegate(delegator, delegatee);
    }

    // ============ Transfer Restriction ============

    /// @dev Restrict transfers when transferable is false: only whitelisted senders
    ///      or mints (from == address(0)) are allowed.
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override {
        super._beforeTokenTransfer(from, to, amount);
        if (!transferable) {
            require(
                from == address(0) ||
                transferWhitelist[from],
                "ArmadaToken: transfers restricted"
            );
        }
    }

    // ============ Delegation Restriction ============

    /// @dev Block delegation for addresses in the noDelegation set (e.g. treasury).
    ///      Overrides the internal _delegate which is called by both delegate() and delegateBySig().
    function _delegate(address delegator, address delegatee) internal override {
        require(!noDelegation[delegator], "ArmadaToken: delegation blocked");
        super._delegate(delegator, delegatee);
    }
}
