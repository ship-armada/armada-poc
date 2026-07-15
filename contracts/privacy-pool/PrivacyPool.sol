// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./storage/PrivacyPoolStorage.sol";
import "./interfaces/IPrivacyPool.sol";
import "./interfaces/IShieldModule.sol";
import "./interfaces/ITransactModule.sol";
import "./interfaces/IMerkleModule.sol";
import "./interfaces/IVerifierModule.sol";
import "./types/CCTPTypes.sol";
import "../cctp/ICCTPV2.sol";
import "../railgun/logic/Snark.sol";

/**
 * @title PrivacyPool
 * @notice Main entry point for privacy pool operations on the Hub chain
 * @dev Routes user calls to modules via delegatecall.
 *      Implements IMessageHandlerV2 to receive CCTP messages from Client chains.
 *
 *      Architecture:
 *      - This contract holds all state (via PrivacyPoolStorage)
 *      - Modules contain logic and are called via delegatecall
 *      - CCTP messages are received and routed to appropriate modules
 *
 *      Modules:
 *      - ShieldModule: Local shields and incoming cross-chain shields
 *      - TransactModule: Private transfers and unshields (local + cross-chain)
 *      - MerkleModule: Merkle tree operations
 *      - VerifierModule: SNARK proof verification
 */
contract PrivacyPool is PrivacyPoolStorage, IPrivacyPool {
    using SafeERC20 for IERC20;

    /// @notice Maximum settable shield fee in basis points (10%), matching ArmadaFeeModule.MAX_BPS.
    /// @dev Bounds setShieldFee so a single mis-proposal cannot brick shields by consuming all deposited value.
    uint256 public constant MAX_SHIELD_FEE_BPS = 1000;

    /// @notice The address that deployed this contract; the only address permitted to call initialize().
    /// @dev initialize() runs in a separate tx after deployment and sets owner/treasury/modules. Gating it
    ///      to the deployer prevents a front-runner from initializing the pool with malicious params on a
    ///      public chain before the deployer's own init lands (issue #368).
    address private immutable deployer;

    constructor() {
        deployer = msg.sender;
    }

    /// @notice Reentrancy guard for the router's state-changing entry points.
    /// @dev Hardening (no known exploit today — nullifiers are marked before transfers, event indices
    ///      computed after, and the shield balance check self-reverts on a nested same-token shield);
    ///      guards against a malicious token's transfer hook re-entering a guarded entry, and future-
    ///      proofs against ordering changes (#369). 0-based so a fresh slot needs no init. Module
    ///      self-calls (e.g. IMerkleModule(address(this)).insertLeaves) are unguarded and don't trip it.
    modifier nonReentrant() {
        require(_reentrancyStatus == 0, "PrivacyPool: reentrant call");
        _reentrancyStatus = 1;
        _;
        _reentrancyStatus = 0;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Initialize the PrivacyPool contract
     * @param _shieldModule Address of ShieldModule implementation
     * @param _transactModule Address of TransactModule implementation
     * @param _merkleModule Address of MerkleModule implementation
     * @param _verifierModule Address of VerifierModule implementation
     * @param _tokenMessenger CCTP TokenMessenger address
     * @param _messageTransmitter CCTP MessageTransmitter address
     * @param _usdc USDC token address
     * @param _localDomain This chain's CCTP domain ID
     * @param _owner Contract owner
     * @param _treasury Address to receive protocol fees (immutable after init)
     */
    function initialize(
        address _shieldModule,
        address _transactModule,
        address _merkleModule,
        address _verifierModule,
        address _tokenMessenger,
        address _messageTransmitter,
        address _usdc,
        uint32 _localDomain,
        address _owner,
        address payable _treasury
    ) external override {
        require(msg.sender == deployer, "PrivacyPool: Only deployer");
        require(!initialized, "PrivacyPool: Already initialized");
        require(_shieldModule != address(0), "PrivacyPool: zero shieldModule");
        require(_transactModule != address(0), "PrivacyPool: zero transactModule");
        require(_merkleModule != address(0), "PrivacyPool: zero merkleModule");
        require(_verifierModule != address(0), "PrivacyPool: zero verifierModule");
        require(_tokenMessenger != address(0), "PrivacyPool: zero tokenMessenger");
        require(_messageTransmitter != address(0), "PrivacyPool: zero messageTransmitter");
        require(_usdc != address(0), "PrivacyPool: zero usdc");
        require(_owner != address(0), "PrivacyPool: zero owner");
        require(_treasury != address(0), "PrivacyPool: zero treasury");

        // Set module addresses
        shieldModule = _shieldModule;
        transactModule = _transactModule;
        merkleModule = _merkleModule;
        verifierModule = _verifierModule;

        // Set CCTP configuration
        tokenMessenger = _tokenMessenger;
        messageTransmitter = _messageTransmitter;
        usdc = _usdc;
        localDomain = _localDomain;

        // Set owner
        owner = _owner;

        // Set treasury (immutable after initialization)
        treasury = _treasury;

        // Initialize merkle tree via delegatecall
        _delegatecall(merkleModule, abi.encodeCall(IMerkleModule.initializeMerkle, ()));

        initialized = true;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // USER-FACING OPERATIONS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Shield tokens into the privacy pool (local, same chain)
     * @param _shieldRequests Array of shield requests
     * @param integrator Integrator address for fee split (address(0) for no integrator)
     */
    function shield(ShieldRequest[] calldata _shieldRequests, address integrator) external override nonReentrant {
        _delegatecall(shieldModule, abi.encodeCall(IShieldModule.shield, (_shieldRequests, integrator)));
    }

    /**
     * @notice Execute private transactions (transfers and/or unshields)
     * @param _transactions Array of transactions to process
     */
    function transact(Transaction[] calldata _transactions) external override nonReentrant {
        _delegatecall(transactModule, abi.encodeCall(ITransactModule.transact, (_transactions)));
    }

    /**
     * @notice Atomic cross-chain unshield to a client chain
     * @param _transaction Transaction with unshield proof
     * @param destinationDomain Target client chain's CCTP domain
     * @param finalRecipient Address to receive USDC on client chain
     * @param maxFee Maximum CCTP relayer fee in USDC raw units (deducted from burn amount at protocol level, 0 = no fee)
     * @param uniqueNonce Opaque per-tx marker echoed into the CCTP hookData for off-chain delivery
     *        matching (issue #287). Not fund-relevant.
     * @return nonce CCTP message nonce
     * @dev The CCTP destinationCaller is pinned at the contract level to remoteHookRouters[destinationDomain]
     *      (see setRemoteHookRouter) — it is not caller-supplied, so a burn can only be delivered through
     *      the destination chain's CCTPHookRouter.
     */
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        uint256 maxFee,
        bytes32 uniqueNonce
    ) external override nonReentrant returns (uint64) {
        bytes memory result = _delegatecall(
            transactModule,
            abi.encodeCall(
                ITransactModule.atomicCrossChainUnshield,
                (_transaction, destinationDomain, finalRecipient, maxFee, uniqueNonce)
            )
        );
        return abi.decode(result, (uint64));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CCTP V2 MESSAGE HANDLER
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Handle finalized CCTP message (cross-chain shields from Clients)
     * @dev Called by CCTPHookRouter (or TokenMessenger in mock mode) after CCTP message
     *      is received and tokens minted. USDC has already been minted to this contract.
     *
     *      Message format: BurnMessageV2 (see ICCTPV2.sol for byte layout)
     *      - amount: Gross amount before fee deduction
     *      - feeExecuted: Fee deducted (actualMint = amount - feeExecuted)
     *      - hookData: Our CCTPPayload with shield data
     *
     * @param sender Sender address on source chain (as bytes32, typically remote TokenMessenger)
     * @param finalityThresholdExecuted The finality threshold that was met (>=2000 for finalized)
     * @param messageBody BurnMessageV2 encoded message containing hookData
     * @return success Always returns true on success (reverts on failure)
     */
    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external override returns (bool) {
        require(msg.sender == hookRouter || msg.sender == tokenMessenger, "PrivacyPool: Unauthorized caller");
        require(finalityThresholdExecuted >= CCTPFinality.STANDARD, "PrivacyPool: Insufficient finality");
        (sender); // envelope sender is the source TokenMessenger; source pool is authenticated in _handleCCTPMessage

        return _handleCCTPMessage(sourceDomain, messageBody);
    }

    /**
     * @notice Handle unfinalized CCTP message (fast finality / "confirmed" level)
     * @dev Called by CCTPHookRouter when finalityThresholdExecuted < STANDARD (2000).
     *      Circle bears the reorg risk for fast transfers via off-chain insurance.
     *      Always accepted — users choose fast vs standard finality per-transaction.
     *
     * @param sender Sender address on source chain (as bytes32)
     * @param finalityThresholdExecuted The finality threshold that was met (e.g. 1000 for FAST)
     * @param messageBody BurnMessageV2 encoded message containing hookData
     * @return success Always returns true on success (reverts on failure)
     */
    function handleReceiveUnfinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external override returns (bool) {
        require(msg.sender == hookRouter || msg.sender == tokenMessenger, "PrivacyPool: Unauthorized caller");
        require(finalityThresholdExecuted >= CCTPFinality.FAST, "PrivacyPool: Finality below minimum");
        (sender); // envelope sender is the source TokenMessenger; source pool is authenticated in _handleCCTPMessage

        return _handleCCTPMessage(sourceDomain, messageBody);
    }

    /**
     * @notice Shared CCTP message processing logic for both finalized and unfinalized paths
     * @param sourceDomain CCTP domain the message originated from (from the MessageV2 envelope)
     * @param messageBody BurnMessageV2 encoded message containing hookData
     * @return success Always returns true on success (reverts on failure)
     */
    function _handleCCTPMessage(uint32 sourceDomain, bytes calldata messageBody) internal returns (bool) {
        // Decode the BurnMessageV2 to get amount, feeExecuted, and hookData
        (
            uint256 grossAmount,
            uint256 feeExecuted,
            bytes memory hookData
        ) = BurnMessageV2.decodeForHook(messageBody);

        // Calculate actual amount received (gross - fee)
        // In local mock, feeExecuted may equal maxFee. On real CCTP, fee is set by attestation service.
        uint256 actualAmount = grossAmount - feeExecuted;

        // Decode our CCTP payload
        CCTPPayload memory payload = CCTPPayloadLib.decode(hookData);

        // Route based on message type
        if (payload.messageType == MessageType.SHIELD) {
            // Authenticate the source pool: the burn message's messageSender is the address that
            // called depositForBurn on the source chain (i.e. the remote PrivacyPoolClient), which
            // must match the configured remote pool for this domain. The handler's envelope `sender`
            // is the source TokenMessenger, not the pool, so it cannot be used here. This is a
            // defense-in-depth backstop on top of CCTP's attestation and rejects shields from
            // unconfigured domains or arbitrary source contracts.
            bytes32 sourcePool = remotePools[sourceDomain];
            require(sourcePool != bytes32(0), "PrivacyPool: unconfigured source domain");
            require(
                BurnMessageV2.getMessageSender(messageBody) == sourcePool,
                "PrivacyPool: untrusted source pool"
            );

            // Cross-chain shield from Client
            ShieldData memory shieldData = CCTPPayloadLib.decodeShieldData(payload.data);

            _delegatecall(
                shieldModule,
                abi.encodeCall(IShieldModule.processIncomingShield, (actualAmount, shieldData))
            );
        } else {
            // Hub should not receive UNSHIELD messages (only Clients receive those)
            revert("PrivacyPool: Invalid message type");
        }

        return true;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Set the address of a remote PrivacyPool/Client
     * @param domain CCTP domain ID of the remote chain
     * @param poolAddress Address of the remote contract (as bytes32)
     */
    function setRemotePool(uint32 domain, bytes32 poolAddress) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        remotePools[domain] = poolAddress;
        emit RemotePoolSet(domain, poolAddress);
    }

    /**
     * @notice Set the CCTP hook router on a remote (destination) domain
     * @dev Pinned as the CCTP destinationCaller for outbound unshield burns to that domain, so the
     *      message can only be delivered through that chain's CCTPHookRouter (which fires the mint hook).
     * @param domain CCTP domain ID of the remote chain
     * @param routerAddress Address of the remote CCTPHookRouter (as bytes32)
     */
    function setRemoteHookRouter(uint32 domain, bytes32 routerAddress) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        remoteHookRouters[domain] = routerAddress;
        emit RemoteHookRouterSet(domain, routerAddress);
    }

    /**
     * @notice Add tokens to the shield blocklist (governance kill-switch for a compromised/incompatible token).
     * @dev Faithful port of Railgun's TokenBlocklist: blocked tokens cannot be SHIELDED, but existing notes
     *      remain transferable and UNSHIELDABLE so holders can always exit. Non-exhaustive by nature. Idempotent.
     *      USDC (the pool's core asset) can never be blocked — doing so would make in-flight cross-chain shields
     *      undeliverable (burned on the client, unmintable on the hub) and strand funds. (#369)
     * @param _tokens Token addresses to block
     */
    function addToBlocklist(address[] calldata _tokens) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        for (uint256 i = 0; i < _tokens.length; i++) {
            require(_tokens[i] != usdc, "PrivacyPool: cannot block USDC");
            if (!tokenBlocklist[_tokens[i]]) {
                tokenBlocklist[_tokens[i]] = true;
                emit AddToBlocklist(_tokens[i]);
            }
        }
    }

    /**
     * @notice Remove tokens from the shield blocklist. Idempotent.
     * @param _tokens Token addresses to unblock
     */
    function removeFromBlocklist(address[] calldata _tokens) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        for (uint256 i = 0; i < _tokens.length; i++) {
            if (tokenBlocklist[_tokens[i]]) {
                delete tokenBlocklist[_tokens[i]];
                emit RemoveFromBlocklist(_tokens[i]);
            }
        }
    }

    /**
     * @notice Set a verification key for a circuit configuration
     * @param _nullifiers Number of nullifiers
     * @param _commitments Number of commitments
     * @param _key The verification key
     */
    function setVerificationKey(
        uint256 _nullifiers,
        uint256 _commitments,
        VerifyingKey calldata _key
    ) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        _delegatecall(
            verifierModule,
            abi.encodeCall(IVerifierModule.setVerificationKey, (_nullifiers, _commitments, _key))
        );
    }

    /**
     * @notice Set the shield fee in basis points
     * @param _feeBps Fee in basis points (50 = 0.50%)
     */
    function setShieldFee(uint120 _feeBps) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        require(_feeBps <= MAX_SHIELD_FEE_BPS, "PrivacyPool: Fee too high");
        shieldFee = _feeBps;
    }

    /**
     * @notice Enable or disable testing mode
     * @dev POC ONLY - bypasses SNARK verification
     * @param _enabled Whether to enable testing mode
     */
    function setTestingMode(bool _enabled) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        _delegatecall(
            verifierModule,
            abi.encodeCall(IVerifierModule.setTestingMode, (_enabled))
        );
        emit TestingModeSet(_enabled);
    }

    /**
     * @notice Set privileged shield caller (bypasses shield/unshield fees)
     * @param caller Address to configure (e.g. yield adapter)
     * @param privileged True to exempt from fees
     */
    function setPrivilegedShieldCaller(address caller, bool privileged) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        privilegedShieldCallers[caller] = privileged;
    }

    /**
     * @notice Set the CCTP Hook Router address
     * @dev The hook router is authorized to call handleReceiveFinalizedMessage
     *      after atomically calling receiveMessage on the MessageTransmitter
     * @param _hookRouter Address of the CCTPHookRouter contract
     */
    function setHookRouter(address _hookRouter) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        hookRouter = _hookRouter;
    }

    /**
     * @notice Set the default finality threshold for outbound CCTP burns
     * @dev Controls whether cross-chain unshields request fast or standard finality.
     *      STANDARD (2000) = wait for hard finality (~15-19 min), no fee.
     *      FAST (1000) = soft finality (~8-20 sec), 1-1.3 bps fee.
     * @param _threshold Finality threshold (must be FAST or STANDARD)
     */
    function setDefaultFinalityThreshold(uint32 _threshold) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        require(
            _threshold == CCTPFinality.FAST || _threshold == CCTPFinality.STANDARD,
            "PrivacyPool: Invalid threshold"
        );
        defaultFinalityThreshold = _threshold;
        emit DefaultFinalityThresholdSet(_threshold);
    }

    /**
     * @notice Set the shield pause controller contract
     * @param _shieldPauseContract Address of the ShieldPauseController
     */
    function setShieldPauseContract(address _shieldPauseContract) external {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        shieldPauseContract = _shieldPauseContract;
        emit ShieldPauseContractSet(_shieldPauseContract);
    }

    /**
     * @notice Set the fee module address (ArmadaFeeModule proxy)
     * @param _feeModule Address of the fee module (or address(0) to use flat fee fallback)
     */
    function setFeeModule(address _feeModule) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        feeModule = _feeModule;
        emit FeeModuleSet(_feeModule);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS (from IPrivacyPool)
    // ══════════════════════════════════════════════════════════════════════════

    // Note: merkleRoot, treeNumber, nullifiers, rootHistory, remotePools
    // are already public in PrivacyPoolStorage and generate automatic getters

    /**
     * @notice Get a verification key for a specific circuit configuration
     * @param _nullifiers Number of nullifiers
     * @param _commitments Number of commitments
     * @return The verification key
     */
    function getVerificationKey(
        uint256 _nullifiers,
        uint256 _commitments
    ) external view returns (VerifyingKey memory) {
        return verificationKeys[_nullifiers][_commitments];
    }

    /**
     * @notice Verify a transaction's SNARK proof
     * @dev Called by TransactModule during delegatecall via staticcall to this router.
     *      Performs the verification directly using stored verification keys and testingMode.
     * @param _transaction The transaction to verify
     * @return True if proof is valid
     */
    function verify(Transaction calldata _transaction) external view returns (bool) {
        // POC: Bypass verification in testing mode
        if (testingMode) {
            return true;
        }

        uint256 nullifiersLength = _transaction.nullifiers.length;
        uint256 commitmentsLength = _transaction.commitments.length;

        // Retrieve verification key for this circuit configuration
        VerifyingKey memory verifyingKey = verificationKeys[nullifiersLength][commitmentsLength];

        // Check if verifying key is set (alpha1.x == 0 means not set)
        require(verifyingKey.alpha1.x != 0, "PrivacyPool: Verification key not set");

        // Construct public inputs array
        // Format: [merkleRoot, boundParamsHash, nullifiers..., commitments...]
        uint256[] memory inputs = new uint256[](2 + nullifiersLength + commitmentsLength);

        // Input 0: Merkle root
        inputs[0] = uint256(_transaction.merkleRoot);

        // Input 1: Hash of bound parameters
        inputs[1] = uint256(keccak256(abi.encode(_transaction.boundParams))) % SNARK_SCALAR_FIELD;

        // Inputs 2 to 2+nullifiersLength-1: Nullifiers
        for (uint256 i = 0; i < nullifiersLength; i++) {
            inputs[2 + i] = uint256(_transaction.nullifiers[i]);
        }

        // Remaining inputs: Commitments
        for (uint256 i = 0; i < commitmentsLength; i++) {
            inputs[2 + nullifiersLength + i] = uint256(_transaction.commitments[i]);
        }

        // Verify the SNARK proof
        bool validity = Snark.verify(verifyingKey, _transaction.proof, inputs);

        // Always return true in gas estimation transactions
        // This allows relayer fee calculation without computing a proof
        // solhint-disable-next-line avoid-tx-origin
        if (tx.origin == VERIFICATION_BYPASS) {
            return true;
        }

        return validity;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MERKLE MODULE PROXIED FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════

    // These functions are exposed so that other modules (ShieldModule, TransactModule)
    // can call them via address(this) during delegatecall execution.

    /**
     * @notice Get the tree number and starting index for new commitments
     * @dev Modules reach this via IMerkleModule(address(this)), so this router copy — not the
     *      MerkleModule delegatecall version — is what actually resolves. It must apply the same
     *      rollover as MerkleModule.insertLeaves/_newTree: when a batch would overflow the current
     *      tree, insertion rolls to (treeNumber + 1, 0). Omitting that branch makes the emitted
     *      Shield/Transact event report a stale position at a tree boundary, leaving those notes
     *      unlocatable for a spend proof.
     * @param _newCommitments Number of commitments about to be inserted
     * @return treeNum Tree number where commitments will be inserted
     * @return startIndex Starting leaf index within that tree
     */
    function getInsertionTreeNumberAndStartingIndex(
        uint256 _newCommitments
    ) external view returns (uint256 treeNum, uint256 startIndex) {
        if ((nextLeafIndex + _newCommitments) > (2 ** TREE_DEPTH)) {
            return (treeNumber + 1, 0);
        }
        return (treeNumber, nextLeafIndex);
    }

    /**
     * @notice Insert leaves into the merkle tree
     * @param _leafHashes Array of leaf hashes to insert
     */
    function insertLeaves(bytes32[] memory _leafHashes) external {
        require(msg.sender == address(this), "Only self");
        _delegatecall(merkleModule, abi.encodeCall(IMerkleModule.insertLeaves, (_leafHashes)));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Execute a delegatecall to a module
     * @param module The module address to call
     * @param data The encoded function call
     * @return result The return data from the call
     */
    function _delegatecall(address module, bytes memory data) internal returns (bytes memory result) {
        require(module != address(0), "PrivacyPool: Module not set");

        bool success;
        (success, result) = module.delegatecall(data);

        if (!success) {
            // Bubble up the revert reason
            if (result.length > 0) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            } else {
                revert("PrivacyPool: Delegatecall failed");
            }
        }
    }
}
