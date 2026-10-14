// ABOUTME: Unit tests for the Groth16 verifier (Snark library) against a real Armada proof fixture:
// ABOUTME: valid proofs verify (library and router); altered proofs, inputs and bound params are rejected (#604).
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/types/SnarkTypes.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/cctp/MockUSDCV2.sol";
import "../contracts/cctp/MockCCTPV2.sol";
import "./helpers/PoseidonLinker.sol";

/// @dev Exposes the library's internal functions so reverts surface to vm.expectRevert.
contract SnarkHarness {
    function verify(VerifyingKey memory vk, SnarkProof memory proof, uint256[] memory inputs)
        external
        view
        returns (bool)
    {
        return Snark.verify(vk, proof, inputs);
    }

    function negate(G1Point memory point) external pure returns (G1Point memory) {
        return Snark.negate(point);
    }
}

/// @title SnarkVerifierTest
/// @dev The fixture (test-foundry/fixtures/snark/armada-transfer-1x2.json) is a real 1x2 private
///      transfer proved with the pinned Armada circuits release, with the verifying key read back
///      from a deployed pool and the public inputs assembled as PrivacyPool.verify does. It was
///      checked on-chain (testing mode off) when captured by scripts/capture/capture-snark-fixture.ts.
contract SnarkVerifierTest is Test {
    uint256 internal constant PRIME_Q =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    SnarkHarness internal harness;
    /// @dev abi.encode(VerifyingKey, SnarkProof, uint256[]) from the fixture. Kept encoded because
    ///      a struct holding a dynamic array (VerifyingKey.ic) cannot be copied to storage.
    bytes internal fixture;

    function setUp() public {
        harness = new SnarkHarness();
        string memory json = vm.readFile("test-foundry/fixtures/snark/armada-transfer-1x2.json");
        fixture = vm.parseJsonBytes(json, ".encoded");
    }

    /// @dev Fresh, independent copies of the fixture's key, proof and public inputs.
    function _load() internal view returns (VerifyingKey memory, SnarkProof memory, uint256[] memory) {
        return abi.decode(fixture, (VerifyingKey, SnarkProof, uint256[]));
    }

    // ══════════════════════════════════════════════════════════════════════
    // Valid proof
    // ══════════════════════════════════════════════════════════════════════

    /// @dev WHY: the baseline — a real proof from the deployed circuits verifies. This pins the G2
    ///      limb order and pairing packing used by the stored keys, the SDK's proof formatting and
    ///      `pairing()`; if any of them disagreed, no real proof would verify.
    function test_realProofVerifies() public view {
        (VerifyingKey memory vk, SnarkProof memory proof, uint256[] memory inputs) = _load();
        assertEq(inputs.length, 5, "1x2 has 5 public inputs");
        assertTrue(harness.verify(vk, proof, inputs), "real proof rejected");
    }

    // ══════════════════════════════════════════════════════════════════════
    // Forged or altered proofs are rejected
    // ══════════════════════════════════════════════════════════════════════

    /// @dev WHY: every public input (merkle root, bound-params hash, nullifiers, commitments) must be
    ///      bound by the proof. Changing any one to another field element must not verify.
    function testFuzz_mutatedPublicInputRejected(uint256 indexSeed, uint256 delta) public view {
        (VerifyingKey memory vk, SnarkProof memory proof, uint256[] memory inputs) = _load();
        uint256[] memory mutated = inputs;
        uint256 i = bound(indexSeed, 0, mutated.length - 1);
        delta = bound(delta, 1, SNARK_SCALAR_FIELD - 1);
        mutated[i] = addmod(mutated[i], delta, SNARK_SCALAR_FIELD);
        assertFalse(harness.verify(vk, proof, mutated), "mutated public input verified");
    }

    /// @dev WHY: a different valid curve point in place of the proof's C must not verify.
    function test_replacedProofPointRejected() public view {
        (VerifyingKey memory vk, SnarkProof memory proof, uint256[] memory inputs) = _load();
        SnarkProof memory forged = proof;
        forged.c = G1Point(1, 2); // the BN254 G1 generator
        assertFalse(harness.verify(vk, forged, inputs), "proof with replaced C verified");
    }

    /// @dev WHY: swapping the proof's A and C (both valid points) must not verify.
    function test_swappedProofPointsRejected() public view {
        (VerifyingKey memory vk, SnarkProof memory proof, uint256[] memory inputs) = _load();
        SnarkProof memory forged = proof;
        (forged.a, forged.c) = (proof.c, proof.a);
        assertFalse(harness.verify(vk, forged, inputs), "proof with swapped A/C verified");
    }

    /// @dev WHY: a proof is only valid under the key it was made for; the same proof under a key
    ///      with a different alpha1 must not verify.
    function test_proofRejectedUnderAlteredKey() public view {
        (VerifyingKey memory vk, SnarkProof memory proof, uint256[] memory inputs) = _load();
        VerifyingKey memory altered = vk;
        altered.alpha1 = G1Point(1, 2);
        assertFalse(harness.verify(altered, proof, inputs), "proof verified under altered key");
    }

    /// @dev WHY: an off-curve A is caught by `negate` instead of reaching the precompile.
    function test_offCurveProofPointReverts() public {
        (VerifyingKey memory vk, SnarkProof memory proof, uint256[] memory inputs) = _load();
        SnarkProof memory forged = proof;
        forged.a.y = addmod(forged.a.y, 1, PRIME_Q);
        vm.expectRevert("Snark: Point not on curve");
        harness.verify(vk, forged, inputs);
    }

    /// @dev WHY: G2 coordinates with their limbs swapped are not a valid G2 point; the pairing
    ///      precompile rejects it and the verifier must revert rather than return true.
    function test_swappedG2LimbsRevert() public {
        (VerifyingKey memory vk, SnarkProof memory proof, uint256[] memory inputs) = _load();
        SnarkProof memory forged = proof;
        (forged.b.x[0], forged.b.x[1]) = (proof.b.x[1], proof.b.x[0]);
        (forged.b.y[0], forged.b.y[1]) = (proof.b.y[1], proof.b.y[0]);
        vm.expectRevert("Snark: pairing precompile failed");
        harness.verify(vk, forged, inputs);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Malformed inputs
    // ══════════════════════════════════════════════════════════════════════

    /// @dev WHY: a public input at or above the scalar field would alias a smaller value inside the
    ///      circuit; non-canonical inputs must be rejected outright.
    function test_inputAtFieldOrderReverts() public {
        (VerifyingKey memory vk, SnarkProof memory proof, uint256[] memory inputs) = _load();
        uint256[] memory bad = inputs;
        bad[0] = SNARK_SCALAR_FIELD;
        vm.expectRevert("Snark: Input > SNARK_SCALAR_FIELD");
        harness.verify(vk, proof, bad);
    }

    /// @dev WHY: the key's IC array fixes the number of public inputs; a mismatch must revert,
    ///      not silently verify against a truncated or padded input set.
    function test_icLengthMismatchReverts() public {
        (VerifyingKey memory vk, SnarkProof memory proof, uint256[] memory inputs) = _load();
        uint256[] memory short_ = new uint256[](inputs.length - 1);
        for (uint256 i = 0; i < short_.length; i++) short_[i] = inputs[i];
        vm.expectRevert("Snark: IC length does not match input count");
        harness.verify(vk, proof, short_);

        uint256[] memory long_ = new uint256[](inputs.length + 1);
        for (uint256 i = 0; i < inputs.length; i++) long_[i] = inputs[i];
        vm.expectRevert("Snark: IC length does not match input count");
        harness.verify(vk, proof, long_);
    }

    // ══════════════════════════════════════════════════════════════════════
    // negate()
    // ══════════════════════════════════════════════════════════════════════

    /// @dev WHY: negation of a valid point is (x, q - y).
    function test_negateValidPoint() public view {
        G1Point memory n = harness.negate(G1Point(1, 2));
        assertEq(n.x, 1);
        assertEq(n.y, PRIME_Q - 2);
    }

    /// @dev WHY: the point at infinity is encoded as (0, 0) and negates to itself.
    function test_negatePointAtInfinity() public view {
        G1Point memory n = harness.negate(G1Point(0, 0));
        assertEq(n.x, 0);
        assertEq(n.y, 0);
    }

    function test_negateOffCurveReverts() public {
        vm.expectRevert("Snark: Point not on curve");
        harness.negate(G1Point(1, 3));
    }

    /// @dev WHY: coordinates must be canonical base-field elements; x + q would otherwise alias x.
    function test_negateOutsideBaseFieldReverts() public {
        vm.expectRevert("Snark: Point outside base field");
        harness.negate(G1Point(1 + PRIME_Q, 2));
        vm.expectRevert("Snark: Point outside base field");
        harness.negate(G1Point(1, 2 + PRIME_Q));
    }
}

/// @title PrivacyPoolVerifyRealProofTest
/// @dev Runs the fixture's full proved transaction through a real PrivacyPool router with testing
///      mode off: covers verifying-key storage (setVerificationKey) and the router's public-input
///      assembly (merkle root, bound-params hash, nullifiers, commitments), not just the library.
contract PrivacyPoolVerifyRealProofTest is Test, PoseidonLinker {
    PrivacyPool internal pool;
    bytes internal encodedTransaction;

    function setUp() public {
        _linkRealPoseidon(); // pool initialisation builds the Merkle tree
        string memory json = vm.readFile("test-foundry/fixtures/snark/armada-transfer-1x2.json");
        (VerifyingKey memory vk, , ) =
            abi.decode(vm.parseJsonBytes(json, ".encoded"), (VerifyingKey, SnarkProof, uint256[]));
        encodedTransaction = vm.parseJsonBytes(json, ".encodedTransaction");

        MockUSDCV2 usdc = new MockUSDCV2("Mock USDC", "USDC");
        MockMessageTransmitterV2 transmitter = new MockMessageTransmitterV2(0, address(this));
        MockTokenMessengerV2 messenger = new MockTokenMessengerV2(address(transmitter), address(usdc), 0);
        pool = new PrivacyPool();
        pool.initialize(
            address(new ShieldModule()),
            address(new TransactModule()),
            address(new MerkleModule()),
            address(new VerifierModule()),
            address(messenger),
            address(transmitter),
            address(usdc),
            0,
            address(this),
            payable(address(0xFEE))
        );
        pool.setVerificationKey(1, 2, vk);
        assertFalse(pool.testingMode(), "testing mode must be off");
    }

    function _tx() internal view returns (Transaction memory) {
        return abi.decode(encodedTransaction, (Transaction));
    }

    /// @dev WHY: the real proved transaction verifies through the router, so key storage and
    ///      public-input assembly agree with the circuits.
    function test_routerVerifiesRealTransaction() public view {
        assertTrue(pool.verify(_tx()), "real transaction rejected by the router");
    }

    /// @dev WHY: the bound params (adapt params, chain ID, ciphertext, unshield type, ...) reach the
    ///      proof only through their hash; changing any of them must break verification.
    function test_routerRejectsAlteredBoundParams() public view {
        Transaction memory t = _tx();
        t.boundParams.adaptParams = bytes32(uint256(1));
        assertFalse(pool.verify(t), "altered adaptParams verified");

        t = _tx();
        t.boundParams.chainID = t.boundParams.chainID + 1;
        assertFalse(pool.verify(t), "altered chainID verified");
    }

    /// @dev WHY: nullifiers, commitments and the merkle root are public inputs of the proof.
    function test_routerRejectsAlteredNullifierCommitmentOrRoot() public view {
        Transaction memory t = _tx();
        t.nullifiers[0] = bytes32(uint256(t.nullifiers[0]) ^ 1);
        assertFalse(pool.verify(t), "altered nullifier verified");

        t = _tx();
        t.commitments[1] = bytes32(uint256(t.commitments[1]) ^ 1);
        assertFalse(pool.verify(t), "altered commitment verified");

        t = _tx();
        t.merkleRoot = bytes32(uint256(t.merkleRoot) ^ 1);
        assertFalse(pool.verify(t), "altered merkle root verified");
    }

    /// @dev WHY: a shape with no registered key must revert, not verify against an empty key.
    function test_routerRevertsForUnregisteredShape() public {
        Transaction memory t = _tx();
        bytes32[] memory three = new bytes32[](3);
        three[0] = t.commitments[0];
        three[1] = t.commitments[1];
        three[2] = t.commitments[1];
        t.commitments = three;
        vm.expectRevert("PrivacyPool: Verification key not set");
        pool.verify(t);
    }
}
