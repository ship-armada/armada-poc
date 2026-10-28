// ABOUTME: The production PrivacyPool has no way to skip SNARK verification (#633): no testing mode,
// ABOUTME: and no tx.origin bypass. Proof skipping exists only in the test-only PrivacyPoolProofBypass.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/types/SnarkTypes.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "./helpers/PoseidonLinker.sol";

contract PrivacyPoolNoVerificationBypassTest is Test, PoseidonLinker {
    PrivacyPool internal pool;
    SnarkProof internal realProof;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        _linkRealPoseidon();
        pool = new PrivacyPool();
        pool.initialize(
            address(new ShieldModule()),
            address(new TransactModule()),
            address(new MerkleModule()),
            address(new VerifierModule()),
            address(0x7E55), // tokenMessenger (unused here)
            address(0x7A45), // messageTransmitter (unused here)
            address(0x05DC), // usdc (unused here)
            0,
            address(this),
            payable(address(0xFEE))
        );

        // Register the real 1x2 key from the #604 fixture, and keep its real proof.
        bytes memory fixture = vm.parseJsonBytes(
            vm.readFile("test-foundry/fixtures/snark/armada-transfer-1x2.json"), ".encoded"
        );
        (VerifyingKey memory vk, SnarkProof memory proof,) =
            abi.decode(fixture, (VerifyingKey, SnarkProof, uint256[]));
        pool.setVerificationKey(1, 2, vk);
        realProof = proof;
    }

    /// @dev A 1x2 transaction carrying a real (well-formed) proof whose public inputs do not match.
    function _mismatchedTransaction() internal view returns (Transaction memory txn) {
        txn.proof = realProof;
        txn.merkleRoot = pool.merkleRoot();
        txn.nullifiers = new bytes32[](1);
        txn.nullifiers[0] = bytes32(uint256(1));
        txn.commitments = new bytes32[](2);
        txn.commitments[0] = bytes32(uint256(2));
        txn.commitments[1] = bytes32(uint256(3));
        txn.boundParams.chainID = uint64(block.chainid);
    }

    /// @notice WHY: a proof that doesn't match its public inputs must be rejected. Baseline for the
    ///         bypass tests below: same transaction, ordinary caller.
    function test_mismatchedProofRejected() public view {
        assertFalse(pool.verify(_mismatchedTransaction()), "mismatched proof accepted");
    }

    /// @notice WHY: the removed VERIFICATION_BYPASS accepted any proof when tx.origin == 0xdead. No
    ///         caller identity may skip verification in production bytecode (#633).
    function test_noTxOriginBypass() public {
        Transaction memory txn = _mismatchedTransaction();
        vm.prank(address(this), DEAD);
        assertFalse(pool.verify(txn), "tx.origin 0xdead skipped verification");
    }

    /// @notice WHY: the owner must have no switch that turns verification off. `setTestingMode` was
    ///         that switch (#349/#633); its selector must no longer exist.
    function test_noTestingModeSetter() public {
        (bool ok,) = address(pool).call(abi.encodeWithSelector(bytes4(keccak256("setTestingMode(bool)")), true));
        assertFalse(ok, "setTestingMode still callable");
    }

    /// @notice WHY: `testingMode` survives only as an inert storage slot (layout is shared with the
    ///         modules); its getter is kept for compatibility and must read false.
    function test_testingModeGetterIsInert() public view {
        assertFalse(pool.testingMode(), "testingMode not false");
    }
}
