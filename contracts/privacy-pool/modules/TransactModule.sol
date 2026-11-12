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
import "../CCTPBindingLib.sol";
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
    ///      PRE-insertion tree position (rollover-aware, spec §5.5). An emergency pause blocks everything;
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
            commitmentsStartOffset =
                _accumulateAndNullify(_transactions[i], commitmentHashes, commitmentsStartOffset, ciphertext);
            // Record the plaintext preimage of any disclosed output.
            _recordPreimages(_transactions[i]);
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
    /// @param maxFee Maximum CCTP relayer fee, in the burned token's units.
    /// @param uniqueNonce Opaque per-tx marker echoed into the CCTP hookData so off-chain wallets
    ///        can match the destination delivery to this specific unshield (issue #287). Not fund-relevant.
    /// @dev The CCTP destinationCaller is pinned to `remoteHookRouters[destinationDomain]` (not
    ///      caller-supplied), so the burn can only be delivered through the destination chain's
    ///      hook router (issue #64).
    /// @return nonce Always 0 — the CCTP V2 burn call returns no nonce.
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        uint256 maxFee,
        bytes32 uniqueNonce
    ) external override onlyDelegatecall returns (uint64 nonce) {
        // Emergency pause blocks ALL operations including unshields.
        _requireNotEmergencyPaused();

        // Validate inputs
        _validateAtomicUnshieldInputs(_transaction, destinationDomain, finalRecipient, maxFee);

        // Validate and process the transaction (nullify, accumulate commitments)
        _processAtomicUnshieldTransaction(_transaction);

        // Execute the CCTP burn and return nonce
        nonce = _executeCCTPBurn(_transaction, destinationDomain, finalRecipient, maxFee, uniqueNonce);
    }

    /// @notice Validates the routing inputs of an atomic cross-chain unshield.
    /// @dev Check order is pinned by spec section 8.2: not the local domain, non-zero
    ///      recipient, unshield output present, unshield note is USDC, destination
    ///      registered, destination bound, unshield pays the pool, then the full
    ///      transaction validation.
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
        // CCTP only bridges USDC, and the burn below always spends the pool's `usdc` for the
        // note's value, so the note being unshielded must itself be a USDC note (spec OQ-9).
        // The pool stays multi-asset: other tokens still shield, transfer and unshield locally.
        require(
            _transaction.unshieldPreimage.token.tokenType == TokenType.ERC20 &&
                _transaction.unshieldPreimage.token.tokenAddress == usdc,
            "TransactModule: Cross-chain unshield is USDC-only"
        );
        require(remotePools[destinationDomain] != bytes32(0), "TransactModule: Unknown destination");
        require(
            remoteHookRouters[destinationDomain] != bytes32(0),
            "TransactModule: Hook router not configured"
        );

        // Bind the CCTP destination tuple (recipient + domain + fee) to the proof. These are
        // plaintext arguments the SNARK does not otherwise cover; without binding, a relayer or
        // front-runner could resubmit the victim's identical proof with finalRecipient = attacker
        // and steal every cross-chain exit (issue #364, generalized to the full tuple in #378).
        // `boundParams.adaptParams` IS committed by the circuit,
        // so the prover sets it to CCTPBindingLib.encode(...) and we reject any mismatch here. This
        // also blocks hijacking a local unshield (adaptParams == 0) through this path. No circuit
        // change; destinationCaller is pinned on-chain separately.
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

        // A cross-chain unshield always pays out to the pool, which then burns via CCTP. Pinning the
        // npk keeps cross-chain and local-unshield proofs disjoint, which the unshield-to-pool guard in
        // _transferTokenOut (issue #364) relies on: otherwise this proof could also be paid out locally.
        require(
            _transaction.unshieldPreimage.npk == bytes32(uint256(uint160(address(this)))),
            "TransactModule: Cross-chain unshield must pay the pool"
        );

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
    /// @dev Approves the token messenger for exactly this burn (per-call approval, reset to zero
    ///      first because OZ 4.9 safeApprove reverts on a non-zero→non-zero change), pins the
    ///      destinationCaller to the destination chain's hook router (validated non-zero above),
    ///      picks the configured finality threshold (standard when unset), and always reports
    ///      `nonce = 0` because the CCTP V2 burn call returns no nonce.
    function _executeCCTPBurn(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        uint256 maxFee,
        bytes32 uniqueNonce
    ) internal returns (uint64 nonce) {
        // Unshields are free: the full preimage value is bridged. `fee` is emitted as 0 so the
        // `Unshield` event keeps its 4-field shape for downstream log parsers.
        uint120 base = _transaction.unshieldPreimage.value;

        // The relayer fee is carved out of the bridged amount, so it must be strictly below it (the
        // same rule real CCTP V2 depositForBurn enforces)
        require(maxFee < base, "TransactModule: maxFee must be below amount");

        // Encode the hook payload the client-side pool will decode
        bytes memory hookData = CCTPPayloadLib.encodeUnshield(
            UnshieldData({ recipient: finalRecipient, uniqueNonce: uniqueNonce })
        );

        // Burn via CCTP (allowance reset first, then exact per-call approval)
        IERC20(usdc).safeApprove(tokenMessenger, 0);
        IERC20(usdc).safeApprove(tokenMessenger, base);

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
        nonce = 0; // CCTP V2 depositForBurnWithHook does not return a nonce

        // Emit events
        emit CrossChainUnshieldInitiated(destinationDomain, finalRecipient, base, nonce);
        emit Unshield(finalRecipient, _transaction.unshieldPreimage.token, base, 0);

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
    function _validateTransaction(Transaction calldata _transaction)
        internal
        view
        returns (bool valid, string memory reason)
    {
        // Shared context checks: gas floor, adapt contract, chain id, merkle root.
        (bool ctxValid, string memory ctxReason) = _validateCommonContext(_transaction);
        if (!ctxValid) {
            return (false, ctxReason);
        }

        // Validate unshield if present
        if (_transaction.boundParams.unshield != UnshieldType.NONE) {
            // The unshield output is excluded from the ciphertext array
            if (_transaction.boundParams.commitmentCiphertext.length != _transaction.commitments.length - 1) {
                return (false, "Invalid Ciphertext Length");
            }

            // The unshield note must be well-formed. Poseidon reduces its inputs mod the field, so
            // npk and npk + k*q hash identically yet truncate to different payout addresses — only a
            // canonical npk is bound by the hash check below. A zero-value unshield moves nothing.
            if (uint256(_transaction.unshieldPreimage.npk) >= SNARK_SCALAR_FIELD) {
                return (false, "Invalid Unshield NPK");
            }
            if (_transaction.unshieldPreimage.value == 0) {
                return (false, "Invalid Unshield Value");
            }
            // An ERC-20 note's tokenSubID is not hashed, so only the canonical 0 is accepted; any
            // other value would surface unchecked in the Unshield event.
            if (
                _transaction.unshieldPreimage.token.tokenType == TokenType.ERC20 &&
                _transaction.unshieldPreimage.token.tokenSubID != 0
            ) {
                return (false, "Invalid Unshield Token");
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

        // P2a: the plain transact path has no owned proof, so ownerField is not a public
        // input of the plain circuit (armada-circuits src/main/main_1x2.circom:6) and this
        // path never reads it. Reject a non-zero ownerField so a caller cannot imply an
        // owner the proof never bound; contract-owned spends use transactOwned.
        if (_transaction.boundParams.ownerField != bytes32(0)) {
            return (false, "Owner field set on plain transact");
        }

        // Disclosed-preimage records (armada-lean Pool.lean `recordsMatch`):
        // publicOutputs, when present, runs parallel to commitments; each non-zero
        // entry must hash to its commitment, so the registry can never record a
        // preimage the pool did not itself verify. Optional here (any sublist).
        (bool poValid, string memory poReason) = _validatePublicOutputs(_transaction, false);
        if (!poValid) {
            return (false, poReason);
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

        // Never unshield to the pool itself. A cross-chain unshield proof pays out to the pool
        // (its USDC is burned via CCTP on the atomic path, which does not call this function).
        // Blocking recipient == pool here stops the cross-path replay: submitting that same proof
        // through plain transact() would otherwise send USDC pool->pool, burn the note, and strand
        // the funds (issue #364 cross-path replay). No legitimate local unshield targets the pool address.
        require(recipient != address(this), "TransactModule: unshield to pool");

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
    ///         block unshields: the post-wind-down emergency pause, if the wired controller
    ///         enables one (Launch 1's ShieldPauseController has it disabled, #589).
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

    // ══════════════════════════════════════════════════════════════════════════
    // CONTRACT-OWNED TRANSACTIONS
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Execute contract-owned transactions. A contract spends and re-mints its
    ///         own notes with no EdDSA signature; authorization is msg.sender equal to
    ///         the proof's public owner field.
    /// @dev Mirrors `transact`, but every transaction forbids an unshield, the proof is
    ///      checked against the owned verifying-key set (`verifyOwned`), which binds
    ///      `ownerField` and the owned circuit's `npk`/`transcriptHash` outputs
    ///      (armada-circuits src/operations/TransactOwned.circom), and every output is
    ///      disclosed, so its plaintext preimage is recorded (armada-lean Pool.lean
    ///      `recordsComplete`).
    /// @param _transactions Contract-owned transactions to process, in order.
    function transactOwned(Transaction[] calldata _transactions) external override onlyDelegatecall {
        require(_transactions.length > 0, "TransactModule: No transactions");

        _requireNotEmergencyPaused();
        _requireNotWithdrawOnly(_transactions);

        uint256 commitmentsCount = _sumCommitments(_transactions);

        bytes32[] memory commitmentHashes = new bytes32[](commitmentsCount);
        CommitmentCiphertext[] memory ciphertext = new CommitmentCiphertext[](commitmentsCount);
        uint256 commitmentsStartOffset = 0;

        for (uint256 i = 0; i < _transactions.length; i++) {
            (bool valid, string memory reason) = _validateOwnedTransaction(_transactions[i]);
            require(valid, string(abi.encodePacked("TransactModule: ", reason)));

            commitmentsStartOffset =
                _accumulateAndNullify(_transactions[i], commitmentHashes, commitmentsStartOffset, ciphertext);
            _recordPreimages(_transactions[i]);
        }

        if (commitmentsCount > 0) {
            (uint256 insertionTreeNumber, uint256 insertionStartIndex) =
                IMerkleModule(address(this)).getInsertionTreeNumberAndStartingIndex(commitmentsCount);

            emit TransactOwned(insertionTreeNumber, insertionStartIndex, commitmentHashes);

            IMerkleModule(address(this)).insertLeaves(commitmentHashes);
        }

        lastEventBlock = block.number;
    }

    /// @notice The context checks shared by transact and transactOwned.
    function _validateCommonContext(Transaction calldata _transaction)
        internal
        view
        returns (bool valid, string memory reason)
    {
        if (tx.gasprice < _transaction.boundParams.minGasPrice) {
            return (false, "Gas price too low");
        }
        if (
            _transaction.boundParams.adaptContract != address(0) && _transaction.boundParams.adaptContract != msg.sender
        ) {
            return (false, "Invalid Adapt Contract");
        }
        if (_transaction.boundParams.chainID != block.chainid) {
            return (false, "ChainID mismatch");
        }
        if (!rootHistory[_transaction.boundParams.treeNumber][_transaction.merkleRoot]) {
            return (false, "Invalid Merkle Root");
        }
        return (true, "");
    }

    /// @notice Validate a transaction's disclosed-preimage records (armada-lean
    ///         Pool.lean `recordsMatch`/`recordsComplete`).
    /// @dev `publicOutputs` runs parallel to `commitments`. Each non-zero entry must
    ///      hash to its commitment, so `preimageOf` can never record a preimage the
    ///      pool did not itself verify against the proof-bound commitment.
    /// @param _requireAll When true (transactOwned, `recordsComplete`), every
    ///        commitment must carry a non-zero preimage; when false (transact,
    ///        `recordsMatch`), `publicOutputs` is optional and any sublist may be
    ///        disclosed.
    function _validatePublicOutputs(Transaction calldata _transaction, bool _requireAll)
        internal
        pure
        returns (bool valid, string memory reason)
    {
        uint256 outputs = _transaction.boundParams.publicOutputs.length;
        if (outputs == 0) {
            if (_requireAll) {
                return (false, "Missing public outputs");
            }
            return (true, "");
        }
        if (outputs != _transaction.commitments.length) {
            return (false, "Invalid Public Outputs Length");
        }
        for (uint256 i = 0; i < outputs; i++) {
            CommitmentPreimage calldata preimage = _transaction.boundParams.publicOutputs[i];
            if (_isZeroPreimage(preimage)) {
                if (_requireAll) {
                    return (false, "Missing public output");
                }
                continue;
            }
            if (_hashCommitment(preimage) != _transaction.commitments[i]) {
                return (false, "Invalid Public Output");
            }
        }
        return (true, "");
    }

    /// @notice True when a commitment preimage is entirely zero: an output that stays
    ///         encrypted rather than disclosed.
    function _isZeroPreimage(CommitmentPreimage calldata _preimage) internal pure returns (bool) {
        return _preimage.npk == bytes32(0) && _preimage.value == 0 && _preimage.token.tokenAddress == address(0)
            && _preimage.token.tokenSubID == 0;
    }

    /// @notice Records the plaintext preimage of every disclosed output into the
    ///         public registry (armada-lean PoolOwned.lean `recordPreimages`/
    ///         `recordStep`). Called only after validation confirmed each non-zero
    ///         preimage hashes to its commitment, so the registry never lies.
    function _recordPreimages(Transaction calldata _transaction) internal {
        uint256 outputs = _transaction.boundParams.publicOutputs.length;
        for (uint256 i = 0; i < outputs; i++) {
            CommitmentPreimage calldata preimage = _transaction.boundParams.publicOutputs[i];
            if (_isZeroPreimage(preimage)) {
                continue;
            }
            bytes32 commitment = _transaction.commitments[i];
            preimageOf[commitment] = preimage;
            emit PreimageRecorded(commitment);
        }
    }

    /// @notice Validate a contract-owned transaction (mirrors _validateTransaction, but
    ///         forbids an unshield, requires a complete disclosure set, checks the
    ///         caller against ownerField, and verifies against the owned key set).
    function _validateOwnedTransaction(Transaction calldata _transaction)
        internal
        view
        returns (bool valid, string memory reason)
    {
        (bool ctxValid, string memory ctxReason) = _validateCommonContext(_transaction);
        if (!ctxValid) {
            return (false, ctxReason);
        }

        // No unshield on the owned path: the owned circuit carries no signature witness,
        // so nothing authorizes paying out to an arbitrary address.
        if (_transaction.boundParams.unshield != UnshieldType.NONE) {
            return (false, "Unshield not allowed");
        }

        // Every commitment carries a ciphertext entry (no unshield output is excluded).
        if (_transaction.boundParams.commitmentCiphertext.length != _transaction.commitments.length) {
            return (false, "Invalid Ciphertext Length");
        }

        // Every output is disclosed: publicOutputs is mandatory and complete
        // (armada-lean Pool.lean `recordsComplete`).
        (bool poValid, string memory poReason) = _validatePublicOutputs(_transaction, true);
        if (!poValid) {
            return (false, poReason);
        }

        // Authorization: the caller must be the owner the proof's ownerField names.
        // Exact equality, not a truncating address cast (armada-lean TransactOwned.lean
        // types the owner as a 160-bit Address; a value at or above 2^160 is not a
        // canonical address and must not alias a real caller's low 160 bits).
        if (_transaction.boundParams.ownerField != bytes32(uint256(uint160(msg.sender)))) {
            return (false, "Caller not owner");
        }

        // Verify the SNARK proof against the owned verifying-key set.
        if (!IVerifierModule(address(this)).verifyOwned(_transaction)) {
            return (false, "Invalid Proof");
        }

        return (true, "");
    }
}
