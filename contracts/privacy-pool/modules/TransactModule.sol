// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../storage/PrivacyPoolStorage.sol";
import "../interfaces/ITransactModule.sol";
import "../interfaces/IMerkleModule.sol";
import "../interfaces/IVerifierModule.sol";
import "../types/CCTPTypes.sol";
import "../../cctp/ICCTPV2.sol";
import "../../railgun/logic/Poseidon.sol";

/**
 * @title TransactModule
 * @notice Handles transact and unshield operations for the privacy pool
 * @dev Called via delegatecall from PrivacyPool router.
 *      Based on Railgun's RailgunSmartWallet.transact() and RailgunLogic.
 *
 *      Supports:
 *      1. Private transfers (transact with no unshield)
 *      2. Local unshields (transact with UnshieldType.NORMAL)
 *      3. Atomic cross-chain unshields (atomicCrossChainUnshield)
 */
contract TransactModule is PrivacyPoolStorage, ITransactModule {
    using SafeERC20 for IERC20;

    /// @notice Basis points denominator (100% = 10000)
    uint120 private constant BASIS_POINTS = 10000;

    /**
     * @notice Execute private transactions (transfers and/or local unshields)
     * @dev Validates proofs, nullifies inputs, creates new commitments.
     *      For local unshields, transfers tokens to recipient.
     *
     * @param _transactions Array of transactions to process
     */
    function transact(Transaction[] calldata _transactions) external override onlyDelegatecall {
        require(_transactions.length > 0, "TransactModule: No transactions");

        // Calculate total commitments (excluding unshield outputs)
        uint256 commitmentsCount = _sumCommitments(_transactions);

        // Create accumulators
        bytes32[] memory commitmentHashes = new bytes32[](commitmentsCount);
        CommitmentCiphertext[] memory ciphertext = new CommitmentCiphertext[](commitmentsCount);
        uint256 commitmentsStartOffset = 0;

        // First pass: validate and nullify all transactions
        for (uint256 i = 0; i < _transactions.length; i++) {
            // Validate transaction
            (bool valid, string memory reason) = _validateTransaction(_transactions[i]);
            require(valid, string(abi.encodePacked("TransactModule: ", reason)));

            // Nullify inputs and accumulate commitments
            commitmentsStartOffset = _accumulateAndNullify(
                _transactions[i],
                commitmentHashes,
                commitmentsStartOffset,
                ciphertext
            );
        }

        // Second pass: process unshields (after all nullifiers are marked)
        for (uint256 i = 0; i < _transactions.length; i++) {
            if (_transactions[i].boundParams.unshield != UnshieldType.NONE) {
                _transferTokenOut(_transactions[i].unshieldPreimage);
            }
        }

        // Insert new commitments into merkle tree
        if (commitmentsCount > 0) {
            (uint256 insertionTreeNumber, uint256 insertionStartIndex) = IMerkleModule(address(this))
                .getInsertionTreeNumberAndStartingIndex(commitmentsCount);

            // Emit Transact event
            emit Transact(insertionTreeNumber, insertionStartIndex, commitmentHashes, ciphertext);

            // Insert into merkle tree
            IMerkleModule(address(this)).insertLeaves(commitmentHashes);
        }

        // Update last event block
        lastEventBlock = block.number;
    }

    /**
     * @notice Atomic cross-chain unshield
     * @dev Validates proof on Hub, nullifies inputs, then burns via CCTP to Client.
     *      Client will receive CCTP message and forward USDC to finalRecipient.
     *
     *      Flow:
     *      1. Validate the unshield proof
     *      2. Nullify spent notes
     *      3. Process any non-unshield commitments (stay on hub)
     *      4. Burn USDC via CCTP with UnshieldData payload
     *      5. Client receives CCTP message and forwards to recipient
     *
     * @param _transaction Transaction with unshield proof
     * @param destinationDomain Client chain's CCTP domain
     * @param finalRecipient Address to receive USDC on client chain
     * @param destinationCaller Address allowed to call receiveMessage on Client (bytes32).
     *        Use bytes32(0) to allow any relayer, or specify a relayer address for MEV protection.
     * @return nonce CCTP message nonce for tracking
     */
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        bytes32 destinationCaller,
        uint256 maxFee
    ) external override onlyDelegatecall returns (uint64 nonce) {
        // Validate inputs
        _validateAtomicUnshieldInputs(_transaction, destinationDomain, finalRecipient);

        // Validate and process the transaction (nullify, accumulate commitments)
        _processAtomicUnshieldTransaction(_transaction);

        // Execute the CCTP burn and return nonce
        nonce = _executeCCTPBurn(_transaction, destinationDomain, finalRecipient, destinationCaller, maxFee);
    }

    /**
     * @notice Validate inputs for atomic cross-chain unshield
     */
    function _validateAtomicUnshieldInputs(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient
    ) internal view {
        require(destinationDomain != localDomain, "TransactModule: Use local unshield");
        require(finalRecipient != address(0), "TransactModule: Invalid recipient");
        require(
            _transaction.boundParams.unshield != UnshieldType.NONE,
            "TransactModule: Must include unshield"
        );
        require(remotePools[destinationDomain] != bytes32(0), "TransactModule: Unknown destination");

        // Validate the transaction proof
        (bool valid, string memory reason) = _validateTransaction(_transaction);
        require(valid, string(abi.encodePacked("TransactModule: ", reason)));
    }

    /**
     * @notice Process transaction for atomic unshield (nullify and accumulate)
     */
    function _processAtomicUnshieldTransaction(Transaction calldata _transaction) internal {
        uint256 commitmentsCount = _transaction.boundParams.commitmentCiphertext.length;

        // Nullify and accumulate
        if (commitmentsCount > 0) {
            bytes32[] memory commitmentHashes = new bytes32[](commitmentsCount);
            CommitmentCiphertext[] memory ciphertext = new CommitmentCiphertext[](commitmentsCount);

            _accumulateAndNullify(_transaction, commitmentHashes, 0, ciphertext);

            // Insert non-unshield commitments into merkle tree
            (uint256 insertionTreeNumber, uint256 insertionStartIndex) = IMerkleModule(address(this))
                .getInsertionTreeNumberAndStartingIndex(commitmentsCount);

            emit Transact(insertionTreeNumber, insertionStartIndex, commitmentHashes, ciphertext);
            IMerkleModule(address(this)).insertLeaves(commitmentHashes);
        } else {
            // Still need to nullify even if no new commitments
            bytes32[] memory empty = new bytes32[](0);
            CommitmentCiphertext[] memory emptyCiphertext = new CommitmentCiphertext[](0);
            _accumulateAndNullify(_transaction, empty, 0, emptyCiphertext);
        }
    }

    /**
     * @notice Execute CCTP burn for atomic unshield
     */
    function _executeCCTPBurn(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        bytes32 destinationCaller,
        uint256 maxFee
    ) internal returns (uint64 nonce) {
        // Calculate unshield amount (after fees)
        uint120 unshieldAmount = _transaction.unshieldPreimage.value;
        (uint120 base, uint120 fee) = _getFee(uint136(unshieldAmount), true, unshieldFee);

        // Validate maxFee does not exceed base amount after protocol fee
        require(maxFee <= base, "TransactModule: maxFee exceeds base");

        // Transfer fee to treasury
        if (fee > 0 && treasury != address(0)) {
            IERC20(usdc).safeTransfer(treasury, fee);
        }

        // Encode CCTP payload
        bytes memory hookData = CCTPPayloadLib.encodeUnshield(
            UnshieldData({ recipient: finalRecipient })
        );

        // Burn via CCTP
        IERC20(usdc).safeApprove(tokenMessenger, base);

        // Use configured finality threshold (STANDARD by default, FAST if enabled)
        uint32 finality = defaultFinalityThreshold > 0
            ? defaultFinalityThreshold
            : CCTPFinality.STANDARD;

        ITokenMessengerV2(tokenMessenger).depositForBurnWithHook(
            base,
            destinationDomain,
            remotePools[destinationDomain],
            usdc,
            destinationCaller,
            maxFee,
            finality,
            hookData
        );
        nonce = 0; // CCTP V2 depositForBurnWithHook does not return nonce

        // Emit events
        emit CrossChainUnshieldInitiated(destinationDomain, finalRecipient, base, nonce);
        emit Unshield(finalRecipient, _transaction.unshieldPreimage.token, base, fee);

        // Update last event block
        lastEventBlock = block.number;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL VALIDATION
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Validate a transaction
     * @param _transaction The transaction to validate
     * @return valid Whether the transaction is valid
     * @return reason Error reason if invalid
     */
    function _validateTransaction(
        Transaction calldata _transaction
    ) internal view returns (bool valid, string memory reason) {
        // Check gas price (for type 0 transactions)
        if (tx.gasprice < _transaction.boundParams.minGasPrice) {
            return (false, "Gas price too low");
        }

        // Check adapt contract
        if (
            _transaction.boundParams.adaptContract != address(0) &&
            _transaction.boundParams.adaptContract != msg.sender
        ) {
            return (false, "Invalid Adapt Contract");
        }

        // Check chain ID
        if (_transaction.boundParams.chainID != block.chainid) {
            return (false, "ChainID mismatch");
        }

        // Check merkle root is valid
        if (!rootHistory[_transaction.boundParams.treeNumber][_transaction.merkleRoot]) {
            return (false, "Invalid Merkle Root");
        }

        // Validate unshield if present
        if (_transaction.boundParams.unshield != UnshieldType.NONE) {
            // Ciphertext length should be commitments - 1 (unshield output not included)
            if (_transaction.boundParams.commitmentCiphertext.length != _transaction.commitments.length - 1) {
                return (false, "Invalid Ciphertext Length");
            }

            // Verify unshield preimage hash
            bytes32 hash;
            if (_transaction.boundParams.unshield == UnshieldType.REDIRECT) {
                // Redirect: sender must match original recipient
                hash = _hashCommitment(CommitmentPreimage({
                    npk: bytes32(uint256(uint160(msg.sender))),
                    token: _transaction.unshieldPreimage.token,
                    value: _transaction.unshieldPreimage.value
                }));
            } else {
                hash = _hashCommitment(_transaction.unshieldPreimage);
            }

            // Hash must match last commitment
            if (hash != _transaction.commitments[_transaction.commitments.length - 1]) {
                return (false, "Invalid Unshield Note");
            }
        } else {
            // No unshield: ciphertext length should match commitments
            if (_transaction.boundParams.commitmentCiphertext.length != _transaction.commitments.length) {
                return (false, "Invalid Ciphertext Length");
            }
        }

        // Verify SNARK proof (via delegatecall to VerifierModule)
        if (!IVerifierModule(address(this)).verify(_transaction)) {
            return (false, "Invalid Proof");
        }

        return (true, "");
    }

    /**
     * @notice Accumulate commitments and nullify nullifiers
     * @param _transaction The transaction to process
     * @param _commitments Commitments accumulator array
     * @param _startOffset Current offset in accumulator
     * @param _ciphertext Ciphertext accumulator array
     * @return New offset after accumulation
     */
    function _accumulateAndNullify(
        Transaction calldata _transaction,
        bytes32[] memory _commitments,
        uint256 _startOffset,
        CommitmentCiphertext[] memory _ciphertext
    ) internal returns (uint256) {
        // Nullify each nullifier
        for (uint256 i = 0; i < _transaction.nullifiers.length; i++) {
            bytes32 nullifier = _transaction.nullifiers[i];
            uint16 treeNum = _transaction.boundParams.treeNumber;

            require(!nullifiers[treeNum][nullifier], "TransactModule: Note already spent");
            nullifiers[treeNum][nullifier] = true;
        }

        // Emit nullified event
        emit Nullified(_transaction.boundParams.treeNumber, _transaction.nullifiers);

        // Accumulate commitments (excluding unshield output)
        uint256 ciphertextLength = _transaction.boundParams.commitmentCiphertext.length;
        for (uint256 i = 0; i < ciphertextLength; i++) {
            _commitments[_startOffset + i] = _transaction.commitments[i];
            _ciphertext[_startOffset + i] = _transaction.boundParams.commitmentCiphertext[i];
        }

        return _startOffset + ciphertextLength;
    }

    /**
     * @notice Transfer tokens out for unshield
     * @param _note The commitment preimage with recipient in npk
     */
    function _transferTokenOut(CommitmentPreimage calldata _note) internal {
        require(_note.token.tokenType == TokenType.ERC20, "TransactModule: Only ERC20 supported");

        IERC20 token = IERC20(_note.token.tokenAddress);

        // Get recipient from npk (address encoded as bytes32)
        address recipient = address(uint160(uint256(_note.npk)));

        // Privileged recipients (e.g. yield adapter) bypass unshield fee
        uint120 base;
        uint120 fee;
        if (privilegedShieldCallers[recipient]) {
            base = _note.value;
            fee = 0;
        } else {
            (base, fee) = _getFee(_note.value, true, unshieldFee);
        }

        // Transfer to recipient
        token.safeTransfer(recipient, base);

        // Transfer fee to treasury
        if (fee > 0 && treasury != address(0)) {
            token.safeTransfer(treasury, fee);
        }

        // Emit unshield event
        emit Unshield(recipient, _note.token, base, fee);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Sum commitments across transactions (excluding unshield outputs)
     */
    function _sumCommitments(Transaction[] calldata _transactions) internal pure returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < _transactions.length; i++) {
            total += _transactions[i].boundParams.commitmentCiphertext.length;
        }
        return total;
    }

    /**
     * @notice Calculate base and fee amounts
     */
    function _getFee(
        uint136 _amount,
        bool _isInclusive,
        uint120 _feeBP
    ) internal pure returns (uint120 base, uint120 fee) {
        if (_feeBP == 0) {
            return (uint120(_amount), 0);
        }

        if (_isInclusive) {
            base = uint120(_amount - (_amount * _feeBP) / BASIS_POINTS);
            fee = uint120(_amount) - base;
        } else {
            base = uint120(_amount);
            fee = uint120((BASIS_POINTS * _amount) / (BASIS_POINTS - _feeBP) - _amount);
        }
    }

    /**
     * @notice Hash a commitment preimage
     */
    function _hashCommitment(CommitmentPreimage memory _note) internal pure returns (bytes32) {
        return PoseidonT4.poseidon([
            _note.npk,
            _getTokenID(_note.token),
            bytes32(uint256(_note.value))
        ]);
    }

    /**
     * @notice Get token ID from token data
     */
    function _getTokenID(TokenData memory _tokenData) internal pure returns (bytes32) {
        if (_tokenData.tokenType == TokenType.ERC20) {
            return bytes32(uint256(uint160(_tokenData.tokenAddress)));
        }
        return bytes32(uint256(keccak256(abi.encode(_tokenData))) % SNARK_SCALAR_FIELD);
    }
}
