// SPDX-License-Identifier: MIT
// ABOUTME: Transact logic module for the privacy pool (private transfers, local
// ABOUTME: unshields, atomic cross-chain unshields). Executes exclusively via
// ABOUTME: delegatecall from the PrivacyPool router, so all state lives in the
// ABOUTME: router's storage (see PrivacyPoolStorage).
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../storage/PrivacyPoolStorage.sol";
import "../interfaces/ITransactModule.sol";
import "../interfaces/IMerkleModule.sol";
import "../interfaces/IVerifierModule.sol";
import "../types/CCTPTypes.sol";
import "../../cctp/ICCTPV2.sol";
import "../types/PoseidonLibs.sol";
import "../../governance/IShieldPauseController.sol";

/// @title TransactModule
/// @notice Entry-point logic for spending pool notes (behavior spec section 8).
/// @dev Three flows are covered:
///        1. Private transfer — `transact` with no unshield output; new notes only.
///        2. Local unshield — `transact` with a NORMAL or REDIRECT unshield; the payout
///           is a plain ERC20 transfer to the address encoded in the note (deviation D-4:
///           no recipient callback hook).
///        3. Atomic cross-chain unshield — `atomicCrossChainUnshield`; the payout is
///           burned via CCTP and minted to the final recipient on the client chain.
///      All flows validate the proof through the router's own `verify` (spec section 9.3),
///      mark nullifiers before any value moves, and record `lastEventBlock` for wallet
///      sync. Unshields are always free (deviation D-2).
contract TransactModule is PrivacyPoolStorage, ITransactModule {
    using SafeERC20 for IERC20;

    /// @notice Executes a batch of private transactions (transfers and/or local unshields).
    /// @dev Ordering is pinned by spec section 8.1: validate and nullify every transaction
    ///      FIRST, pay out unshields only after all nullifiers are marked, then insert the
    ///      accumulated commitments as one tree batch. The `Transact` event carries the
    ///      PRE-insertion tree position (spec OQ-1). An emergency pause blocks everything;
    ///      withdraw-only mode blocks pure transfers while letting unshields through.
    /// @param _transactions Transactions to process, in order. The batch is atomic.
    function transact(Transaction[] calldata _transactions) external override onlyDelegatecall {
        require(_transactions.length > 0, "TransactModule: No transactions");

        // Emergency pause blocks ALL operations including unshields — the only scenario
        // in which unshields can be paused.
        _requireNotEmergencyPaused();

        // Withdraw-only mode blocks pure private transfers; unshield transactions are
        // always allowed so users can exit.
        _requireNotWithdrawOnly(_transactions);

        // Total new commitments across the batch, excluding unshield outputs
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

            // Announce the new notes for wallet sync
            emit Transact(insertionTreeNumber, insertionStartIndex, commitmentHashes, ciphertext);

            // Append the leaves to the tree via the router's self-call gate
            IMerkleModule(address(this)).insertLeaves(commitmentHashes);
        }

        // Record the liveness marker for wallet sync
        lastEventBlock = block.number;
    }

    /// @notice Atomically unshields value to another chain in a single user call.
    /// @dev Validates and nullifies on this chain, then burns USDC through CCTP with a
    ///      hook payload naming the final recipient; the client-side pool forwards the
    ///      minted USDC to that recipient. No withdraw-only restriction applies here —
    ///      unshields are allowed in every mode except the emergency pause. Any non-unshield
    ///      commitments in the transaction stay on this chain and are inserted into the tree.
    /// @param _transaction Transaction carrying the unshield proof.
    /// @param destinationDomain CCTP domain of the destination chain.
    /// @param finalRecipient Address that ultimately receives the USDC on the destination chain.
    /// @param destinationCaller Address allowed to call `receiveMessage` on the destination
    ///        chain (bytes32); zero allows any relayer.
    /// @param maxFee Maximum CCTP relayer fee, in the burned token's units.
    /// @return nonce Always 0 — the CCTP V2 burn call returns no nonce.
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        bytes32 destinationCaller,
        uint256 maxFee
    ) external override onlyDelegatecall returns (uint64 nonce) {
        // Emergency pause blocks ALL operations including unshields.
        _requireNotEmergencyPaused();

        // Validate inputs
        _validateAtomicUnshieldInputs(_transaction, destinationDomain, finalRecipient);

        // Validate and process the transaction (nullify, accumulate commitments)
        _processAtomicUnshieldTransaction(_transaction);

        // Execute the CCTP burn and return nonce
        nonce = _executeCCTPBurn(_transaction, destinationDomain, finalRecipient, destinationCaller, maxFee);
    }

    /// @notice Validates the routing inputs of an atomic cross-chain unshield.
    /// @dev Check order is pinned by spec section 8.2: not the local domain, non-zero
    ///      recipient, unshield output present, destination registered, then the full
    ///      transaction validation. The unshield note's token is deliberately NOT checked
    ///      against USDC — the burn always burns `usdc` (spec OQ-9).
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

    /// @notice Nullifies the transaction's inputs and inserts any non-unshield commitments.
    /// @dev With no new commitments the nullifiers are still marked and `Nullified` is
    ///      still emitted, but there is no `Transact` event and no tree insertion.
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

    /// @notice Burns the unshielded amount via CCTP and emits the payout events.
    /// @dev Approves the token messenger for exactly this burn (per-call approval), picks
    ///      the configured finality threshold (standard when unset), and always reports
    ///      `nonce = 0` because the CCTP V2 burn call returns no nonce.
    function _executeCCTPBurn(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        bytes32 destinationCaller,
        uint256 maxFee
    ) internal returns (uint64 nonce) {
        // Unshields are free: the full preimage value is bridged. `fee` stays zero only so
        // the `Unshield` event keeps its 4-field shape for downstream log parsers.
        uint120 base = _transaction.unshieldPreimage.value;
        uint120 fee = 0;

        // The relayer fee is carved out of the bridged amount, so it cannot exceed it
        require(maxFee <= base, "TransactModule: maxFee exceeds base");

        // Encode the hook payload the client-side pool will decode
        bytes memory hookData = CCTPPayloadLib.encodeUnshield(
            UnshieldData({ recipient: finalRecipient })
        );

        // Burn via CCTP
        IERC20(usdc).safeApprove(tokenMessenger, base);

        // Configured finality threshold, defaulting to standard finality
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
        nonce = 0; // CCTP V2 depositForBurnWithHook does not return a nonce

        // Emit events
        emit CrossChainUnshieldInitiated(destinationDomain, finalRecipient, base, nonce);
        emit Unshield(finalRecipient, _transaction.unshieldPreimage.token, base, fee);

        // Record the liveness marker for wallet sync
        lastEventBlock = block.number;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL VALIDATION
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Runs the pinned validation sequence for one transaction (spec section 8.3).
    /// @dev Check order is consensus-relevant: gas floor, adapt-contract binding, chain ID,
    ///      merkle root membership, ciphertext/commitment length consistency, unshield
    ///      output hash, and finally the SNARK proof via the router's `verify`. For a
    ///      REDIRECT unshield the output hash is recomputed with the submitting caller's
    ///      address in place of the note's npk, binding the transaction to its submitter
    ///      (the payout itself still goes to the address encoded in the preimage).
    /// @param _transaction The transaction to validate.
    /// @return valid Whether the transaction passed all checks.
    /// @return reason The failure reason when invalid (callers prefix the module name).
    function _validateTransaction(
        Transaction calldata _transaction
    ) internal view returns (bool valid, string memory reason) {
        // Gas floor for legacy-fee transactions
        if (tx.gasprice < _transaction.boundParams.minGasPrice) {
            return (false, "Gas price too low");
        }

        // An adapt contract may only be bound by the adapt contract itself
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

        // The merkle root must be a known root of the referenced tree
        if (!rootHistory[_transaction.boundParams.treeNumber][_transaction.merkleRoot]) {
            return (false, "Invalid Merkle Root");
        }

        // Validate unshield if present
        if (_transaction.boundParams.unshield != UnshieldType.NONE) {
            // The unshield output is excluded from the ciphertext array
            if (_transaction.boundParams.commitmentCiphertext.length != _transaction.commitments.length - 1) {
                return (false, "Invalid Ciphertext Length");
            }

            // Verify unshield preimage hash
            bytes32 hash;
            if (_transaction.boundParams.unshield == UnshieldType.REDIRECT) {
                // Redirect: bind the output hash to the submitting caller
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
            // No unshield: every commitment carries a ciphertext
            if (_transaction.boundParams.commitmentCiphertext.length != _transaction.commitments.length) {
                return (false, "Invalid Ciphertext Length");
            }
        }

        // Verify the SNARK proof through the router's own verification entry point
        if (!IVerifierModule(address(this)).verify(_transaction)) {
            return (false, "Invalid Proof");
        }

        return (true, "");
    }

    /// @notice Marks a transaction's nullifiers as spent and copies its non-unshield
    ///         commitments into the batch accumulators.
    /// @dev Nullifiers are scoped to the transaction's bound tree number; reusing one
    ///      reverts. `Nullified` is emitted even for an empty nullifier array.
    /// @param _transaction The transaction to process.
    /// @param _commitments Commitment-hash accumulator.
    /// @param _startOffset Current write offset into the accumulators.
    /// @param _ciphertext Ciphertext accumulator.
    /// @return The write offset after this transaction's entries.
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

    /// @notice Pays out a local unshield (spec section 8.5).
    /// @dev Plain ERC20 transfer to the address encoded in the note's npk; no callback is
    ///      attempted on contract recipients (deviation D-4). Unshields are free, so the
    ///      event's fee field is hard-coded to zero (deviation D-2).
    /// @param _note The unshield output note, with the recipient encoded in `npk`.
    function _transferTokenOut(CommitmentPreimage calldata _note) internal {
        require(_note.token.tokenType == TokenType.ERC20, "TransactModule: Only ERC20 supported");

        IERC20 token = IERC20(_note.token.tokenAddress);

        // Get recipient from npk (address encoded as bytes32)
        address recipient = address(uint160(uint256(_note.npk)));

        // Pay the full preimage value; the trailing zero keeps the 4-field event shape.
        token.safeTransfer(recipient, _note.value);
        emit Unshield(recipient, _note.token, _note.value, 0);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Sums the new-commitment counts across a batch, excluding unshield outputs
    ///         (the ciphertext count, not the commitment count — spec section 8.1 step 4).
    function _sumCommitments(Transaction[] calldata _transactions) internal pure returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < _transactions.length; i++) {
            total += _transactions[i].boundParams.commitmentCiphertext.length;
        }
        return total;
    }

    /// @notice Computes the commitment leaf hash (spec section 2.2).
    function _hashCommitment(CommitmentPreimage memory _note) internal pure returns (bytes32) {
        return PoseidonT4.poseidon([
            _note.npk,
            _getTokenID(_note.token),
            bytes32(uint256(_note.value))
        ]);
    }

    /// @notice Derives the field-element token identifier (spec section 2.2).
    /// @dev ERC20 tokens are identified by their address, zero-extended. Other token
    ///      types hash the full token data into the field (currently unreachable — both
    ///      token in/out paths require ERC20).
    function _getTokenID(TokenData memory _tokenData) internal pure returns (bytes32) {
        if (_tokenData.tokenType == TokenType.ERC20) {
            return bytes32(uint256(uint160(_tokenData.tokenAddress)));
        }
        return bytes32(uint256(keccak256(abi.encode(_tokenData))) % SNARK_SCALAR_FIELD);
    }

    /// @notice Reverts while the emergency pause is active. No-op if no pause contract is
    ///         set or the emergency window is not open. This is the only check that can
    ///         block unshields.
    function _requireNotEmergencyPaused() internal view {
        if (shieldPauseContract == address(0)) return;
        require(
            !IShieldPauseController(shieldPauseContract).emergencyPaused(),
            "TransactModule: emergency paused"
        );
    }

    /// @notice Reverts if the pool is in withdraw-only mode and any transaction in the
    ///         batch is a pure transfer (no unshield output). No-op if no pause contract
    ///         is set or withdraw-only mode is inactive.
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
