// ABOUTME: Tests that PrivacyPool module external functions revert when called directly
// ABOUTME: (not via delegatecall from the PrivacyPool router).

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/privacy-pool/storage/PrivacyPoolStorage.sol";

/// @title OnlyDelegatecallTest — Verify modules reject direct calls
/// @dev Each module function guarded with onlyDelegatecall should revert
///      with "PrivacyPoolStorage: Direct call not allowed" when called directly.
contract OnlyDelegatecallTest is Test {
    ShieldModule shieldModule;
    TransactModule transactModule;
    MerkleModule merkleModule;
    VerifierModule verifierModule;

    string constant EXPECTED_REVERT = "PrivacyPoolStorage: Direct call not allowed";

    function setUp() public {
        shieldModule = new ShieldModule();
        transactModule = new TransactModule();
        merkleModule = new MerkleModule();
        verifierModule = new VerifierModule();
    }

    // ═══════════════════════════════════════════════════════════════════
    // ShieldModule
    // ═══════════════════════════════════════════════════════════════════

    function test_shieldModule_shield_revertsOnDirectCall() public {
        ShieldRequest[] memory requests = new ShieldRequest[](0);
        vm.expectRevert(bytes(EXPECTED_REVERT));
        shieldModule.shield(requests);
    }

    function test_shieldModule_processIncomingShield_revertsOnDirectCall() public {
        ShieldData memory data = ShieldData({
            npk: bytes32(0),
            value: 100,
            encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
            shieldKey: bytes32(0)
        });
        vm.expectRevert(bytes(EXPECTED_REVERT));
        shieldModule.processIncomingShield(100, data);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TransactModule
    // ═══════════════════════════════════════════════════════════════════

    function test_transactModule_transact_revertsOnDirectCall() public {
        Transaction[] memory txns = new Transaction[](0);
        vm.expectRevert(bytes(EXPECTED_REVERT));
        transactModule.transact(txns);
    }

    function test_transactModule_atomicCrossChainUnshield_revertsOnDirectCall() public {
        // Build a minimal Transaction struct (will revert before validation)
        bytes32[] memory nullifiers = new bytes32[](0);
        bytes32[] memory commitments = new bytes32[](0);
        CommitmentCiphertext[] memory ciphertext = new CommitmentCiphertext[](0);

        BoundParams memory boundParams = BoundParams({
            treeNumber: 0,
            minGasPrice: 0,
            unshield: UnshieldType.NORMAL,
            chainID: 0,
            adaptContract: address(0),
            adaptParams: bytes32(0),
            commitmentCiphertext: ciphertext
        });

        SnarkProof memory proof = SnarkProof({
            a: G1Point(0, 0),
            b: G2Point([uint256(0), 0], [uint256(0), 0]),
            c: G1Point(0, 0)
        });

        CommitmentPreimage memory unshieldPreimage = CommitmentPreimage({
            npk: bytes32(0),
            token: TokenData({
                tokenType: TokenType.ERC20,
                tokenAddress: address(0),
                tokenSubID: 0
            }),
            value: 0
        });

        Transaction memory txn = Transaction({
            proof: proof,
            merkleRoot: bytes32(0),
            nullifiers: nullifiers,
            commitments: commitments,
            boundParams: boundParams,
            unshieldPreimage: unshieldPreimage
        });

        vm.expectRevert(bytes(EXPECTED_REVERT));
        transactModule.atomicCrossChainUnshield(txn, 1, address(1), bytes32(0), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // MerkleModule
    // ═══════════════════════════════════════════════════════════════════

    function test_merkleModule_initializeMerkle_revertsOnDirectCall() public {
        vm.expectRevert(bytes(EXPECTED_REVERT));
        merkleModule.initializeMerkle();
    }

    function test_merkleModule_insertLeaves_revertsOnDirectCall() public {
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = bytes32(uint256(1));
        vm.expectRevert(bytes(EXPECTED_REVERT));
        merkleModule.insertLeaves(leaves);
    }

    function test_merkleModule_getInsertionTreeNumberAndStartingIndex_revertsOnDirectCall() public {
        vm.expectRevert(bytes(EXPECTED_REVERT));
        merkleModule.getInsertionTreeNumberAndStartingIndex(1);
    }

    // ═══════════════════════════════════════════════════════════════════
    // VerifierModule
    // ═══════════════════════════════════════════════════════════════════

    function test_verifierModule_setVerificationKey_revertsOnDirectCall() public {
        VerifyingKey memory key;
        vm.expectRevert(bytes(EXPECTED_REVERT));
        verifierModule.setVerificationKey(1, 1, key);
    }

    function test_verifierModule_verify_revertsOnDirectCall() public {
        bytes32[] memory nullifiers = new bytes32[](0);
        bytes32[] memory commitments = new bytes32[](0);
        CommitmentCiphertext[] memory ciphertext = new CommitmentCiphertext[](0);

        BoundParams memory boundParams = BoundParams({
            treeNumber: 0,
            minGasPrice: 0,
            unshield: UnshieldType.NONE,
            chainID: 0,
            adaptContract: address(0),
            adaptParams: bytes32(0),
            commitmentCiphertext: ciphertext
        });

        SnarkProof memory proof = SnarkProof({
            a: G1Point(0, 0),
            b: G2Point([uint256(0), 0], [uint256(0), 0]),
            c: G1Point(0, 0)
        });

        CommitmentPreimage memory unshieldPreimage = CommitmentPreimage({
            npk: bytes32(0),
            token: TokenData({
                tokenType: TokenType.ERC20,
                tokenAddress: address(0),
                tokenSubID: 0
            }),
            value: 0
        });

        Transaction memory txn = Transaction({
            proof: proof,
            merkleRoot: bytes32(0),
            nullifiers: nullifiers,
            commitments: commitments,
            boundParams: boundParams,
            unshieldPreimage: unshieldPreimage
        });

        vm.expectRevert(bytes(EXPECTED_REVERT));
        verifierModule.verify(txn);
    }

    function test_verifierModule_setTestingMode_revertsOnDirectCall() public {
        vm.expectRevert(bytes(EXPECTED_REVERT));
        verifierModule.setTestingMode(true);
    }
}
