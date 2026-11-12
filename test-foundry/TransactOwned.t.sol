// ABOUTME: Foundry tests for the contract-owned spend path (transactOwned/verifyOwned)
// ABOUTME: and the disclosed-preimage registry (preimageOf), per armada-lean Pool.lean.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/test/PrivacyPoolProofBypass.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/privacy-pool/types/PoolTypes.sol";
import "../contracts/privacy-pool/types/PoseidonLibs.sol";
import "../contracts/cctp/MockUSDCV2.sol";
import "../contracts/cctp/MockCCTPV2.sol";
import "./helpers/PoseidonLinker.sol";

/// @title TransactOwnedTest — contract-owned spend path and the disclosed-preimage registry
/// @dev Two independent mechanisms, both exercised here:
///      1. The owned circuit (armada-circuits src/operations/TransactOwned.circom) derives
///         each input note's public key as Poseidon(ownerField, random) and its nullifier as
///         Poseidon(ownerField, leafIndex), with npk and transcriptHash as circuit outputs
///         instead of an EdDSA signature.
///      2. The disclosed-preimage registry (armada-lean ArmadaLean/Pool.lean `records`,
///         `recordsMatch`/`recordsComplete`; `PoolOwned.lean` `preimageOf`/`recordStep`):
///         calldata-level preimage disclosure, independent of the circuit, available on
///         both `transact` (any sublist, `recordsMatch`) and `transactOwned` (every output,
///         `recordsComplete`).
///      Most tests run with proof verification bypassed via PrivacyPoolProofBypass (#633),
///      to isolate the Solidity-level rules the circuit cannot express. A dedicated test
///      leaves verification on to pin the owned-npk length check, which runs before any
///      proof is read.
contract TransactOwnedTest is Test, PoseidonLinker {
    PrivacyPool public pool;
    ShieldModule public shieldModule;
    TransactModule public transactModule;
    MerkleModule public merkleModule;
    VerifierModule public verifierModule;
    MockUSDCV2 public usdc;
    MockTokenMessengerV2 public tokenMessenger;
    MockMessageTransmitterV2 public messageTransmitter;

    address public owner;
    address public treasury;
    address public noteOwner = address(0xB0B);
    address public stranger = address(0xBAD);
    uint120 constant VALUE = 1000;

    function setUp() public {
        _linkRealPoseidon();
        owner = address(this);
        treasury = address(0xFEE);

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        messageTransmitter = new MockMessageTransmitterV2(0, owner);
        tokenMessenger = new MockTokenMessengerV2(address(messageTransmitter), address(usdc), 0);
        messageTransmitter.setTokenMessenger(address(tokenMessenger));

        shieldModule = new ShieldModule();
        transactModule = new TransactModule();
        merkleModule = new MerkleModule();
        verifierModule = new VerifierModule();

        pool = new PrivacyPoolProofBypass(); // test-only: proofs are not generated here
        pool.initialize(
            address(shieldModule),
            address(transactModule),
            address(merkleModule),
            address(verifierModule),
            address(tokenMessenger),
            address(messageTransmitter),
            address(usdc),
            0,
            owner,
            payable(treasury)
        );
        // Bypasses only the SNARK proof (PrivacyPoolProofBypass, #633); every other check
        // (merkle root, caller authorization, publicOutputs hashing) runs for real.
        PrivacyPoolProofBypass(address(pool)).setSkipProofVerification(true);
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    function _token() internal view returns (TokenData memory) {
        return TokenData({tokenType: TokenType.ERC20, tokenAddress: address(usdc), tokenSubID: 0});
    }

    /// @notice Mirrors TransactModule._hashCommitment for an ERC20 note.
    function _commitment(CommitmentPreimage memory n) internal pure returns (bytes32) {
        bytes32 tokenID = bytes32(uint256(uint160(n.token.tokenAddress)));
        return PoseidonT4.poseidon([n.npk, tokenID, bytes32(uint256(n.value))]);
    }

    function _emptyCiphertext(uint256 count) internal pure returns (CommitmentCiphertext[] memory ct) {
        ct = new CommitmentCiphertext[](count);
        for (uint256 i = 0; i < count; i++) {
            ct[i] = CommitmentCiphertext({
                ciphertext: [bytes32(0), bytes32(0), bytes32(0), bytes32(0)],
                blindedSenderViewingKey: bytes32(0),
                blindedReceiverViewingKey: bytes32(0),
                annotationData: "",
                memo: ""
            });
        }
    }

    function _zeroProof() internal pure returns (SnarkProof memory) {
        return SnarkProof({a: G1Point(0, 0), b: G2Point([uint256(0), 0], [uint256(0), 0]), c: G1Point(0, 0)});
    }

    function _zeroPreimage() internal view returns (CommitmentPreimage memory) {
        return CommitmentPreimage({npk: bytes32(0), token: _token(), value: 0});
    }

    /// @notice An all-zero preimage: the "not disclosed" sentinel `_isZeroPreimage`
    ///         checks for (zero npk, zero token address, zero tokenSubID, zero value).
    function _undisclosed() internal pure returns (CommitmentPreimage memory) {
        return CommitmentPreimage({
            npk: bytes32(0),
            token: TokenData({tokenType: TokenType.ERC20, tokenAddress: address(0), tokenSubID: 0}),
            value: 0
        });
    }

    /// @notice Build a transaction over `commitments`/`declaredOutputs` (one entry per
    ///         commitment; a zero entry means "not disclosed"). `npkCount` sizes
    ///         `ownedNpk`; owned-path tests pass `nullifiers.length`.
    function _buildTxn(
        UnshieldType unshieldType,
        bytes32 ownerField,
        bytes32[] memory commitments,
        CommitmentPreimage[] memory declaredOutputs,
        uint256 ciphertextCount,
        uint256 npkCount
    ) internal view returns (Transaction memory) {
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = keccak256(abi.encode(commitments[0], "nullifier"));

        bytes32[] memory ownedNpk = new bytes32[](npkCount);

        return Transaction({
            proof: _zeroProof(),
            merkleRoot: pool.merkleRoot(),
            nullifiers: nullifiers,
            commitments: commitments,
            boundParams: BoundParams({
                treeNumber: 0,
                minGasPrice: 0,
                unshield: unshieldType,
                chainID: uint64(block.chainid),
                adaptContract: address(0),
                adaptParams: bytes32(0),
                commitmentCiphertext: _emptyCiphertext(ciphertextCount),
                ownerField: ownerField,
                publicOutputs: declaredOutputs
            }),
            unshieldPreimage: _zeroPreimage(),
            ownedNpk: ownedNpk,
            ownedTranscriptHash: bytes32(0)
        });
    }

    function _single(Transaction memory t) internal pure returns (Transaction[] memory arr) {
        arr = new Transaction[](1);
        arr[0] = t;
    }

    function _single(bytes32 v) internal pure returns (bytes32[] memory arr) {
        arr = new bytes32[](1);
        arr[0] = v;
    }

    function _single(CommitmentPreimage memory v) internal pure returns (CommitmentPreimage[] memory arr) {
        arr = new CommitmentPreimage[](1);
        arr[0] = v;
    }

    // ── owned-circuit tests ──────────────────────────────────────────────────

    /// @notice transactOwned from the correct owner, with a valid (bypassed) proof,
    ///         succeeds and inserts the new commitment.
    function test_transactOwned_fromOwner_succeeds() public {
        bytes32 ownerField = bytes32(uint256(uint160(noteOwner)));
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x3333)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        Transaction memory t =
            _buildTxn(UnshieldType.NONE, ownerField, _single(commitment), _single(preimage), 1, 1);
        vm.prank(noteOwner);
        pool.transactOwned(_single(t));

        assertEq(pool.nextLeafIndex(), 1, "commitment inserted");
    }

    /// @notice transactOwned called by any address other than the proof's owner reverts.
    function test_transactOwned_wrongOwner_reverts() public {
        bytes32 ownerField = bytes32(uint256(uint160(noteOwner)));
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x3333)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        Transaction memory t =
            _buildTxn(UnshieldType.NONE, ownerField, _single(commitment), _single(preimage), 1, 1);
        vm.prank(stranger);
        vm.expectRevert("TransactModule: Caller not owner");
        pool.transactOwned(_single(t));
    }

    /// @notice transactOwned with any unshield reverts: the owned circuit carries no
    ///         signature witness, so nothing authorizes paying an arbitrary address.
    function test_transactOwned_withUnshield_reverts() public {
        bytes32 ownerField = bytes32(uint256(uint160(noteOwner)));
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x3333)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        Transaction memory t =
            _buildTxn(UnshieldType.NORMAL, ownerField, _single(commitment), _single(preimage), 1, 1);
        vm.prank(noteOwner);
        vm.expectRevert("TransactModule: Unshield not allowed");
        pool.transactOwned(_single(t));
    }

    /// @notice transactOwned with a ciphertext/commitment length mismatch reverts.
    function test_transactOwned_ciphertextLengthMismatch_reverts() public {
        bytes32 ownerField = bytes32(uint256(uint160(noteOwner)));
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x3333)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        Transaction memory t =
            _buildTxn(UnshieldType.NONE, ownerField, _single(commitment), _single(preimage), 0, 1);
        vm.prank(noteOwner);
        vm.expectRevert("TransactModule: Invalid Ciphertext Length");
        pool.transactOwned(_single(t));
    }

    /// @notice A plain transact that carries a non-zero ownerField reverts. The plain
    ///         circuit (armada-circuits src/main/main_1x2.circom:6) has no ownerField
    ///         public input, so a plain proof never binds it and the plain path never
    ///         reads it. A caller must not imply an owner the proof did not constrain;
    ///         owned spends use transactOwned.
    function test_transact_ownerFieldSet_reverts() public {
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x1111)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        bytes32 ownerField = bytes32(uint256(uint160(stranger)));
        Transaction memory t =
            _buildTxn(UnshieldType.NONE, ownerField, _single(commitment), new CommitmentPreimage[](0), 1, 0);
        vm.expectRevert("TransactModule: Owner field set on plain transact");
        pool.transact(_single(t));
    }

    /// @notice Changing ownerField makes the owned spend fail. ownerField is the owned
    ///         circuit's public owner input (TransactOwned.circom) and transactOwned
    ///         also checks msg.sender against it. A transaction whose ownerField names a
    ///         different address than the caller reverts, so ownerField cannot be swapped.
    function test_transactOwned_differentOwnerField_reverts() public {
        bytes32 ownerField = bytes32(uint256(uint160(stranger)));
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x3333)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        Transaction memory t =
            _buildTxn(UnshieldType.NONE, ownerField, _single(commitment), _single(preimage), 1, 1);
        vm.prank(noteOwner);
        vm.expectRevert("TransactModule: Caller not owner");
        pool.transactOwned(_single(t));
    }

    /// @notice A non-canonical ownerField (2^160 or more) reverts rather than aliasing
    ///         a real caller's low 160 bits. The owned circuit does not range-check
    ///         ownerField (armada-lean ArmadaLean/TransactOwned.lean types the owner as
    ///         a 160-bit Address, ruling 2026-11-08); the contract comparison must be
    ///         exact equality, not a truncating address cast, or a value at
    ///         noteOwner + 2^160 would wrongly authorize `noteOwner`.
    function test_transactOwned_nonCanonicalOwnerField_reverts() public {
        bytes32 ownerField = bytes32(uint256(uint160(noteOwner)) + 2 ** 160);
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x3333)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        Transaction memory t =
            _buildTxn(UnshieldType.NONE, ownerField, _single(commitment), _single(preimage), 1, 1);
        vm.prank(noteOwner);
        vm.expectRevert("TransactModule: Caller not owner");
        pool.transactOwned(_single(t));
    }

    /// @notice verifyOwned checks `ownedNpk.length == nullifiers.length` before it reads
    ///         the verifying key or the proof, so a mismatched length reverts
    ///         deterministically even without a registered key or a real proof. Runs
    ///         with proof verification NOT bypassed, since the bypass short-circuits
    ///         before this check.
    function test_verifyOwned_npkLengthMismatch_reverts() public {
        PrivacyPoolProofBypass(address(pool)).setSkipProofVerification(false);

        bytes32 ownerField = bytes32(uint256(uint160(noteOwner)));
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x3333)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        // One nullifier, but zero owned-npk entries: length mismatch.
        Transaction memory t =
            _buildTxn(UnshieldType.NONE, ownerField, _single(commitment), _single(preimage), 1, 0);
        vm.prank(noteOwner);
        vm.expectRevert("PrivacyPool: Invalid owned npk length");
        pool.transactOwned(_single(t));
    }

    // ── disclosed-preimage registry tests (armada-lean Pool.lean records) ──────

    /// @notice A transact with one disclosed output records its preimage, readable by
    ///         any caller with the correct token and value (`recordStep`).
    function test_transact_disclosedOutput_recordsPreimage() public {
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x1111)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        Transaction memory t = _buildTxn(UnshieldType.NONE, bytes32(0), _single(commitment), _single(preimage), 1, 0);
        pool.transact(_single(t));

        (bytes32 npk, TokenData memory token, uint120 value) = pool.preimageOf(commitment);
        assertEq(npk, bytes32(uint256(0x1111)), "preimage npk recorded");
        assertEq(token.tokenAddress, address(usdc), "preimage token recorded");
        assertEq(uint256(value), uint256(VALUE), "preimage value recorded");
    }

    /// @notice A transact whose plaintext output does not hash to its commitment reverts,
    ///         so the registry can never record an unverified preimage (`recordsMatch`
    ///         requires `hashCommitment cp.2 = cp.1`).
    function test_transact_wrongPreimage_reverts() public {
        CommitmentPreimage memory honest =
            CommitmentPreimage({npk: bytes32(uint256(0x1111)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(honest);

        // Supply a DIFFERENT preimage than the one the commitment hashes.
        CommitmentPreimage memory tampered =
            CommitmentPreimage({npk: bytes32(uint256(0x2222)), token: _token(), value: VALUE});

        Transaction memory t = _buildTxn(UnshieldType.NONE, bytes32(0), _single(commitment), _single(tampered), 1, 0);
        vm.expectRevert("TransactModule: Invalid Public Output");
        pool.transact(_single(t));
    }

    /// @notice A plain transact may disclose any sublist of its outputs (`recordsMatch`):
    ///         with two outputs, disclosing only the first and leaving the second
    ///         encrypted (an all-zero preimage entry) still succeeds.
    function test_transact_sublistDisclosure_passes() public {
        CommitmentPreimage memory disclosed =
            CommitmentPreimage({npk: bytes32(uint256(0x1111)), token: _token(), value: 1});
        CommitmentPreimage memory undisclosed =
            CommitmentPreimage({npk: bytes32(uint256(0x2222)), token: _token(), value: VALUE - 1});

        bytes32[] memory commitments = new bytes32[](2);
        commitments[0] = _commitment(disclosed);
        commitments[1] = _commitment(undisclosed);

        CommitmentPreimage[] memory declared = new CommitmentPreimage[](2);
        declared[0] = disclosed;
        declared[1] = _undisclosed(); // not disclosed

        Transaction memory t = _buildTxn(UnshieldType.NONE, bytes32(0), commitments, declared, 2, 0);
        pool.transact(_single(t));

        (bytes32 npk,, uint120 value) = pool.preimageOf(commitments[0]);
        assertEq(npk, bytes32(uint256(0x1111)), "disclosed entry recorded");
        assertEq(uint256(value), 1, "disclosed value recorded");

        (bytes32 undisclosedNpk,,) = pool.preimageOf(commitments[1]);
        assertEq(undisclosedNpk, bytes32(0), "undisclosed entry never recorded");
    }

    /// @notice A transactOwned with one disclosed output records its preimage.
    function test_transactOwned_fromOwner_recordsPreimage() public {
        bytes32 ownerField = bytes32(uint256(uint160(noteOwner)));
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x3333)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        Transaction memory t =
            _buildTxn(UnshieldType.NONE, ownerField, _single(commitment), _single(preimage), 1, 1);
        vm.prank(noteOwner);
        pool.transactOwned(_single(t));

        (,, uint120 value) = pool.preimageOf(commitment);
        assertEq(uint256(value), uint256(VALUE), "owned preimage recorded");
    }

    /// @notice A transactOwned whose plaintext output does not hash to its commitment
    ///         reverts, so the registry can never record an unverified preimage on the
    ///         owned path either.
    function test_transactOwned_wrongPreimage_reverts() public {
        bytes32 ownerField = bytes32(uint256(uint160(noteOwner)));
        CommitmentPreimage memory honest =
            CommitmentPreimage({npk: bytes32(uint256(0x3333)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(honest);

        CommitmentPreimage memory tampered =
            CommitmentPreimage({npk: bytes32(uint256(0x4444)), token: _token(), value: VALUE});

        Transaction memory t =
            _buildTxn(UnshieldType.NONE, ownerField, _single(commitment), _single(tampered), 1, 1);
        vm.prank(noteOwner);
        vm.expectRevert("TransactModule: Invalid Public Output");
        pool.transactOwned(_single(t));
    }

    /// @notice An owned transaction with a missing record (an undisclosed output)
    ///         reverts: `recordsComplete` requires every output disclosed, unlike
    ///         plain transact's `recordsMatch` sublist.
    function test_transactOwned_missingRecord_reverts() public {
        bytes32 ownerField = bytes32(uint256(uint160(noteOwner)));
        CommitmentPreimage memory preimage =
            CommitmentPreimage({npk: bytes32(uint256(0x3333)), token: _token(), value: VALUE});
        bytes32 commitment = _commitment(preimage);

        // One output, left undisclosed (all-zero entry): recordsComplete requires it.
        Transaction memory t =
            _buildTxn(UnshieldType.NONE, ownerField, _single(commitment), _single(_undisclosed()), 1, 1);
        vm.prank(noteOwner);
        vm.expectRevert("TransactModule: Missing public output");
        pool.transactOwned(_single(t));
    }
}
