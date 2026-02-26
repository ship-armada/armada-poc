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
        address _owner
    ) external override {
        require(!initialized, "PrivacyPool: Already initialized");
        require(_shieldModule != address(0), "PrivacyPool: zero shieldModule");
        require(_transactModule != address(0), "PrivacyPool: zero transactModule");
        require(_merkleModule != address(0), "PrivacyPool: zero merkleModule");
        require(_verifierModule != address(0), "PrivacyPool: zero verifierModule");
        require(_tokenMessenger != address(0), "PrivacyPool: zero tokenMessenger");
        require(_messageTransmitter != address(0), "PrivacyPool: zero messageTransmitter");
        require(_usdc != address(0), "PrivacyPool: zero usdc");
        require(_owner != address(0), "PrivacyPool: zero owner");

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
     */
    function shield(ShieldRequest[] calldata _shieldRequests) external override {
        _delegatecall(shieldModule, abi.encodeCall(IShieldModule.shield, (_shieldRequests)));
    }

    /**
     * @notice Execute private transactions (transfers and/or unshields)
     * @param _transactions Array of transactions to process
     */
    function transact(Transaction[] calldata _transactions) external override {
        _delegatecall(transactModule, abi.encodeCall(ITransactModule.transact, (_transactions)));
    }

    /**
     * @notice Atomic cross-chain unshield to a client chain
     * @param _transaction Transaction with unshield proof
     * @param destinationDomain Target client chain's CCTP domain
     * @param finalRecipient Address to receive USDC on client chain
     * @param destinationCaller Address allowed to call receiveMessage on Client (bytes32).
     *        Use bytes32(0) to allow any relayer, or specify a relayer address for MEV protection.
     * @param maxFee Maximum CCTP relayer fee in USDC raw units (deducted from burn amount at protocol level, 0 = no fee)
     * @return nonce CCTP message nonce
     */
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        bytes32 destinationCaller,
        uint256 maxFee
    ) external override returns (uint64) {
        bytes memory result = _delegatecall(
            transactModule,
            abi.encodeCall(
                ITransactModule.atomicCrossChainUnshield,
                (_transaction, destinationDomain, finalRecipient, destinationCaller, maxFee)
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
        uint32,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external override returns (bool) {
        require(msg.sender == hookRouter || msg.sender == tokenMessenger, "PrivacyPool: Unauthorized caller");
        require(finalityThresholdExecuted >= CCTPFinality.STANDARD, "PrivacyPool: Insufficient finality");
        (sender); // Silence unused variable warning

        return _handleCCTPMessage(messageBody);
    }

    /**
     * @notice Handle unfinalized CCTP message (fast finality / "confirmed" level)
     * @dev Called by CCTPHookRouter when finalityThresholdExecuted < STANDARD (2000).
     *      Must be explicitly enabled via setFastFinalityEnabled(true).
     *      Circle bears the reorg risk for fast transfers via off-chain insurance.
     *
     * @param sender Sender address on source chain (as bytes32)
     * @param finalityThresholdExecuted The finality threshold that was met (e.g. 1000 for FAST)
     * @param messageBody BurnMessageV2 encoded message containing hookData
     * @return success Always returns true on success (reverts on failure)
     */
    function handleReceiveUnfinalizedMessage(
        uint32,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external override returns (bool) {
        require(msg.sender == hookRouter || msg.sender == tokenMessenger, "PrivacyPool: Unauthorized caller");
        require(fastFinalityEnabled, "PrivacyPool: Fast finality not enabled");
        require(finalityThresholdExecuted >= CCTPFinality.FAST, "PrivacyPool: Finality below minimum");
        (sender); // Silence unused variable warning

        return _handleCCTPMessage(messageBody);
    }

    /**
     * @notice Shared CCTP message processing logic for both finalized and unfinalized paths
     * @param messageBody BurnMessageV2 encoded message containing hookData
     * @return success Always returns true on success (reverts on failure)
     */
    function _handleCCTPMessage(bytes calldata messageBody) internal returns (bool) {
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
        require(_feeBps <= 10000, "PrivacyPool: Fee too high");
        shieldFee = _feeBps;
    }

    /**
     * @notice Set the unshield fee in basis points
     * @param _feeBps Fee in basis points (50 = 0.50%)
     */
    function setUnshieldFee(uint120 _feeBps) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        require(_feeBps <= 10000, "PrivacyPool: Fee too high");
        unshieldFee = _feeBps;
    }

    /**
     * @notice Set the treasury address for fee collection
     * @param _treasury Address to receive protocol fees
     */
    function setTreasury(address payable _treasury) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        require(_treasury != address(0), "PrivacyPool: zero treasury");
        treasury = _treasury;
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
     * @notice Enable or disable acceptance of fast finality CCTP messages
     * @dev When enabled, handleReceiveUnfinalizedMessage() will accept messages
     *      with finalityThresholdExecuted >= FAST (1000). Circle bears the reorg risk.
     * @param _enabled Whether to accept fast finality messages
     */
    function setFastFinalityEnabled(bool _enabled) external override {
        require(msg.sender == owner, "PrivacyPool: Only owner");
        fastFinalityEnabled = _enabled;
        emit FastFinalitySet(_enabled);
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
     * @return treeNum Tree number where commitments will be inserted
     * @return startIndex Starting leaf index within that tree
     */
    function getInsertionTreeNumberAndStartingIndex(
        uint256
    ) external view returns (uint256 treeNum, uint256 startIndex) {
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
