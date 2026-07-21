// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../storage/PrivacyPoolStorage.sol";
import "../interfaces/ITransactModule.sol";
import "../interfaces/IMerkleModule.sol";
import "../interfaces/IVerifierModule.sol";
import "../types/CCTPTypes.sol";
import "../CCTPBindingLib.sol";
import "../../cctp/ICCTPV2.sol";
import "../../railgun/logic/Poseidon.sol";
import "../../governance/IShieldPauseController.sol";

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

    /**
     * @notice Execute private transactions (transfers and/or local unshields)
     * @dev Validates proofs, nullifies inputs, creates new commitments.
     *      For local unshields, transfers tokens to recipient.
     *
     * @param _transactions Array of transactions to process
     */
    function transact(Transaction[] calldata _transactions) external override onlyDelegatecall {
        require(_transactions.length > 0, "TransactModule: No transactions");

        // Post-wind-down SC emergency pause: block ALL operations including unshields.
        // This is the only scenario where unshields can be paused — a single 24h
        // non-renewable window to protect users from adapter issues after wind-down.
        _requireNotEmergencyPaused();

        // In withdraw-only mode (post-wind-down), block pure private transfers.
        // Unshield transactions are allowed — users must always be able to exit.
        _requireNotWithdrawOnly(_transactions);

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
     * @param uniqueNonce Opaque per-tx marker echoed into the CCTP hookData so off-chain wallets can
     *        match the destination delivery to this specific unshield (issue #287). Not fund-relevant.
     * @return nonce CCTP message nonce for tracking
     * @dev The CCTP destinationCaller is pinned to remoteHookRouters[destinationDomain] (not
     *      caller-supplied), so the burn can only be delivered through the destination chain's
     *      CCTPHookRouter — a caller cannot leave it bytes32(0) and let a third party strand the funds.
     */
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        uint256 maxFee,
        bytes32 uniqueNonce
    ) external override onlyDelegatecall returns (uint64 nonce) {
        // Post-wind-down SC emergency pause: block ALL operations including unshields.
        _requireNotEmergencyPaused();

        // Validate inputs
        _validateAtomicUnshieldInputs(_transaction, destinationDomain, finalRecipient, maxFee);

        // Validate and process the transaction (nullify, accumulate commitments)
        _processAtomicUnshieldTransaction(_transaction);

        // Execute the CCTP burn and return nonce
        nonce = _executeCCTPBurn(_transaction, destinationDomain, finalRecipient, maxFee, uniqueNonce);
    }

    /**
     * @notice Validate inputs for atomic cross-chain unshield
     */
    function _validateAtomicUnshieldInputs(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        uint256 maxFee
    ) internal view {
        require(destinationDomain != localDomain, "TransactModule: Use local unshield");
        require(finalRecipient != address(0), "TransactModule: Invalid recipient");
        require(
            _transaction.boundParams.unshield != UnshieldType.NONE,
            "TransactModule: Must include unshield"
        );
        require(remotePools[destinationDomain] != bytes32(0), "TransactModule: Unknown destination");
        require(
            remoteHookRouters[destinationDomain] != bytes32(0),
            "TransactModule: Hook router not configured"
        );

        // Bind the CCTP destination (recipient + domain + fee) to the proof. These are plaintext
        // arguments the SNARK does not otherwise cover; without this a relayer/front-runner could
        // resubmit the victim's identical proof with finalRecipient = attacker and steal every
        // cross-chain exit (issue #364, generalized to the full tuple in #378). boundParams.adaptParams
        // IS committed by the circuit, so the prover sets it to CCTPBindingLib.encode(...) and we reject
        // any mismatch here. This also blocks hijacking a local unshield (adaptParams == 0) through this
        // path. No circuit change; destinationCaller is already pinned on-chain per #64.
        require(
            _transaction.boundParams.adaptContract == address(0),
            "TransactModule: unexpected adaptContract"
        );
        require(
            CCTPBindingLib.verify(
                _transaction.boundParams.adaptParams,
                finalRecipient,
                destinationDomain,
                maxFee
            ),
            "TransactModule: destination not bound to proof"
        );

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
        uint256 maxFee,
        bytes32 uniqueNonce
    ) internal returns (uint64 nonce) {
        // Unshield is free per spec — the full preimage value is bridged. The Unshield event's fee
        // field is emitted as 0 to keep its 4-field shape for downstream log parsers.
        uint120 base = _transaction.unshieldPreimage.value;

        // Validate maxFee does not exceed the bridged amount
        require(maxFee <= base, "TransactModule: maxFee exceeds base");

        // Encode CCTP payload
        bytes memory hookData = CCTPPayloadLib.encodeUnshield(
            UnshieldData({ recipient: finalRecipient, uniqueNonce: uniqueNonce })
        );

        // Burn via CCTP. Reset the allowance to zero before setting it — OZ 4.9 safeApprove reverts
        // on a non-zero→non-zero change, so a residual TokenMessenger allowance would otherwise brick
        // later burns. Matches the defensive pattern in PrivacyPoolClient and the gasless-shield wrappers.
        IERC20(usdc).safeApprove(tokenMessenger, 0);
        IERC20(usdc).safeApprove(tokenMessenger, base);

        // destinationCaller is pinned to the destination chain's hook router (validated non-zero in
        // _validateAtomicUnshieldInputs) so the message can only be delivered via its CCTPHookRouter.
        // Finality: STANDARD by default, FAST if enabled (inlined to keep the stack shallow).
        ITokenMessengerV2(tokenMessenger).depositForBurnWithHook(
            base,
            destinationDomain,
            remotePools[destinationDomain],
            usdc,
            remoteHookRouters[destinationDomain],
            maxFee,
            defaultFinalityThreshold > 0 ? defaultFinalityThreshold : CCTPFinality.STANDARD,
            hookData
        );
        nonce = 0; // CCTP V2 depositForBurnWithHook does not return nonce

        // Emit events
        emit CrossChainUnshieldInitiated(destinationDomain, finalRecipient, base, nonce);
        emit Unshield(finalRecipient, _transaction.unshieldPreimage.token, base, 0);

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

        // Verify SNARK proof. During this module's delegatecall, address(this) is the PrivacyPool
        // router, so this external staticcall dispatches to the router's own verify() — the
        // authoritative implementation — not to the VerifierModule contract.
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

        // Never unshield to the pool itself. An xchain-unshield proof unshields to the pool (its USDC is
        // burned via CCTP in atomicCrossChainUnshield, which does not call this function). Blocking
        // recipient == pool here stops a griefing replay: submitting that same proof through the plain
        // transact() path would otherwise send USDC pool->pool and destroy the note with funds stranded
        // (issue #364 cross-path replay). No legitimate unshield targets the pool address.
        require(recipient != address(this), "TransactModule: unshield to pool");

        // Unshield is free per spec — the full preimage value is paid out. The trailing
        // 0 in the Unshield event preserves the 4-field shape for downstream log parsers.
        token.safeTransfer(recipient, _note.value);
        emit Unshield(recipient, _note.token, _note.value, 0);
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

    /**
     * @notice Reverts during the post-wind-down SC emergency pause (24h, non-renewable).
     *         This is the only scenario where unshields can be paused — protecting users
     *         from adapter issues discovered after wind-down.
     *         No-op if no pause contract is set or if emergency pause is not active.
     */
    function _requireNotEmergencyPaused() internal view {
        if (shieldPauseContract == address(0)) return;
        require(
            !IShieldPauseController(shieldPauseContract).emergencyPaused(),
            "TransactModule: emergency paused"
        );
    }

    /**
     * @notice Reverts if pool is in withdraw-only mode and any transaction is a pure transfer.
     *         After wind-down, only unshields are allowed per spec §Wind-Down → Sequence step 3.
     *         No-op if no pause contract is set or if withdraw-only mode is not active.
     */
    function _requireNotWithdrawOnly(Transaction[] calldata _transactions) internal view {
        if (shieldPauseContract == address(0)) return;
        if (!IShieldPauseController(shieldPauseContract).withdrawOnlyMode()) return;

        for (uint256 i = 0; i < _transactions.length; i++) {
            require(
                _transactions[i].boundParams.unshield != UnshieldType.NONE,
                "TransactModule: withdraw only"
            );
        }
    }
}
