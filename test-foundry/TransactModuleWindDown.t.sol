// ABOUTME: Foundry tests for TransactModule withdraw-only mode (issue #112).
// ABOUTME: Verifies that private transfers are blocked after wind-down while unshields remain available.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/governance/ShieldPauseController.sol";
import "../contracts/cctp/MockUSDCV2.sol";
import "../contracts/cctp/MockCCTPV2.sol";

/// @notice Minimal mock that satisfies IArmadaGovernorSC (securityCouncil() view)
contract MockGovernorSC {
    address public securityCouncil;
    constructor(address _sc) { securityCouncil = _sc; }
}

/// @title TransactModuleWindDownTest — Withdraw-only mode blocks private transfers
/// @dev Tests that after wind-down activation, transact() reverts for pure transfers
///      but allows unshields. Covers spec §Wind-Down → Sequence step 3.
contract TransactModuleWindDownTest is Test {
    PrivacyPool public pool;
    ShieldModule public shieldModule;
    TransactModule public transactModule;
    MerkleModule public merkleModule;
    VerifierModule public verifierModule;
    MockUSDCV2 public usdc;
    MockTokenMessengerV2 public tokenMessenger;
    MockMessageTransmitterV2 public messageTransmitter;
    ShieldPauseController public pauseController;
    MockGovernorSC public mockGovernor;

    address public owner;
    address public treasury;
    address public securityCouncil = address(0x5C5C);
    address public windDownContract = address(0xD0D0);

    function setUp() public {
        owner = address(this);
        treasury = address(0xFEE);

        // Deploy USDC + CCTP mocks
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        messageTransmitter = new MockMessageTransmitterV2(0, owner);
        tokenMessenger = new MockTokenMessengerV2(address(messageTransmitter), address(usdc), 0);
        messageTransmitter.setTokenMessenger(address(tokenMessenger));

        // Deploy modules
        shieldModule = new ShieldModule();
        transactModule = new TransactModule();
        merkleModule = new MerkleModule();
        verifierModule = new VerifierModule();

        // Deploy and initialize pool
        pool = new PrivacyPool();
        pool.initialize(
            address(shieldModule),
            address(transactModule),
            address(merkleModule),
            address(verifierModule),
            address(tokenMessenger),
            address(messageTransmitter),
            address(usdc),
            0, // localDomain
            owner,
            payable(treasury)
        );
        pool.setTestingMode(true);

        // Deploy ShieldPauseController
        mockGovernor = new MockGovernorSC(securityCouncil);
        pauseController = new ShieldPauseController(address(mockGovernor), owner);

        // Wire wind-down contract to pause controller
        pauseController.setWindDownContract(windDownContract);

        // Wire pause controller to pool
        pool.setShieldPauseContract(address(pauseController));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Build a minimal Transaction with the specified UnshieldType
    function _buildMinimalTransaction(UnshieldType unshieldType) internal view returns (Transaction memory) {
        CommitmentCiphertext[] memory ciphertext;

        if (unshieldType == UnshieldType.NONE) {
            // Pure transfer: 1 commitment, 1 ciphertext
            ciphertext = new CommitmentCiphertext[](1);
            ciphertext[0] = CommitmentCiphertext({
                ciphertext: [bytes32(0), bytes32(0), bytes32(0), bytes32(0)],
                blindedSenderViewingKey: bytes32(0),
                blindedReceiverViewingKey: bytes32(0),
                annotationData: "",
                memo: ""
            });
        } else {
            // Unshield: 0 ciphertext (unshield output excluded from ciphertext)
            ciphertext = new CommitmentCiphertext[](0);
        }

        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = bytes32(uint256(0x1234));

        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = bytes32(uint256(0x5678));

        return Transaction({
            proof: SnarkProof({
                a: G1Point(0, 0),
                b: G2Point([uint256(0), uint256(0)], [uint256(0), uint256(0)]),
                c: G1Point(0, 0)
            }),
            merkleRoot: bytes32(0),
            nullifiers: nullifiers,
            commitments: commitments,
            boundParams: BoundParams({
                treeNumber: 0,
                minGasPrice: 0,
                unshield: unshieldType,
                chainID: uint64(block.chainid),
                adaptContract: address(0),
                adaptParams: bytes32(0),
                commitmentCiphertext: ciphertext
            }),
            unshieldPreimage: CommitmentPreimage({
                npk: bytes32(uint256(uint160(address(0xBEEF)))),
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: address(usdc),
                    tokenSubID: 0
                }),
                value: 1000
            })
        });
    }

    function _activateWindDown() internal {
        vm.prank(windDownContract);
        pauseController.setWindDownActive();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TESTS: Pure transfer blocked in withdraw-only mode
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Pure private transfer reverts after wind-down (withdraw-only mode)
    function test_pureTransfer_reverts_withdrawOnlyMode() public {
        _activateWindDown();

        Transaction[] memory txs = new Transaction[](1);
        txs[0] = _buildMinimalTransaction(UnshieldType.NONE);

        vm.expectRevert("TransactModule: withdraw only");
        pool.transact(txs);
    }

    /// @notice Mixed batch (transfer + unshield) reverts after wind-down
    function test_mixedBatch_reverts_withdrawOnlyMode() public {
        _activateWindDown();

        Transaction[] memory txs = new Transaction[](2);
        txs[0] = _buildMinimalTransaction(UnshieldType.NORMAL); // unshield
        txs[1] = _buildMinimalTransaction(UnshieldType.NONE);   // pure transfer

        // Use a different nullifier to avoid double-spend revert
        txs[1].nullifiers[0] = bytes32(uint256(0x9999));
        txs[1].commitments[0] = bytes32(uint256(0xAAAA));

        vm.expectRevert("TransactModule: withdraw only");
        pool.transact(txs);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TESTS: Unshields allowed in withdraw-only mode
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Unshield transaction does NOT revert with "withdraw only" after wind-down.
    ///         It may revert for other reasons (invalid merkle root, etc.) — that's fine.
    function test_unshield_bypasses_withdrawOnlyGuard() public {
        _activateWindDown();

        Transaction[] memory txs = new Transaction[](1);
        txs[0] = _buildMinimalTransaction(UnshieldType.NORMAL);

        try pool.transact(txs) {
            // If it succeeds, that's fine — guard didn't block it
        } catch Error(string memory reason) {
            // If it reverted, ensure it's NOT the withdraw-only guard
            assertTrue(
                keccak256(bytes(reason)) != keccak256(bytes("TransactModule: withdraw only")),
                "Unshield should not be blocked by withdraw-only mode"
            );
        }
    }

    /// @notice atomicCrossChainUnshield does NOT revert with "withdraw only" after wind-down.
    function test_atomicCrossChainUnshield_bypasses_withdrawOnlyGuard() public {
        _activateWindDown();

        // Register a remote pool so destination validation passes
        pool.setRemotePool(1, bytes32(uint256(uint160(address(0xBE0BE0)))));

        Transaction memory tx0 = _buildMinimalTransaction(UnshieldType.NORMAL);

        try pool.atomicCrossChainUnshield(tx0, 1, address(0xBEEF), bytes32(0), 0) {
            // Success — guard didn't block
        } catch Error(string memory reason) {
            assertTrue(
                keccak256(bytes(reason)) != keccak256(bytes("TransactModule: withdraw only")),
                "Cross-chain unshield should not be blocked by withdraw-only mode"
            );
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TESTS: Pre-wind-down (no guard)
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Pure transfer is NOT blocked by withdraw-only guard when wind-down is inactive.
    ///         May revert for other reasons (invalid merkle root, etc.)
    function test_pureTransfer_allowed_preWindDown() public {
        // Do NOT activate wind-down

        Transaction[] memory txs = new Transaction[](1);
        txs[0] = _buildMinimalTransaction(UnshieldType.NONE);

        try pool.transact(txs) {
            // Success — guard didn't block
        } catch Error(string memory reason) {
            assertTrue(
                keccak256(bytes(reason)) != keccak256(bytes("TransactModule: withdraw only")),
                "Pre-wind-down transfer should not trigger withdraw-only guard"
            );
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TESTS: SC pause does NOT activate withdraw-only mode
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice SC pause blocks shields but does NOT block private transfers.
    ///         withdraw-only mode is a wind-down-only behavior per spec.
    function test_scPause_doesNotBlockTransfers() public {
        // SC pauses shields (not wind-down)
        vm.prank(securityCouncil);
        pauseController.pauseShields();

        // Shields should be paused
        assertTrue(pauseController.shieldsPaused(), "Shields should be paused");
        // But withdraw-only should NOT be active
        assertFalse(pauseController.withdrawOnlyMode(), "SC pause should not activate withdraw-only");

        Transaction[] memory txs = new Transaction[](1);
        txs[0] = _buildMinimalTransaction(UnshieldType.NONE);

        try pool.transact(txs) {
            // Success — guard didn't block
        } catch Error(string memory reason) {
            assertTrue(
                keccak256(bytes(reason)) != keccak256(bytes("TransactModule: withdraw only")),
                "SC pause should not trigger withdraw-only guard on transfers"
            );
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TESTS: No pause controller set (graceful no-op)
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice If shieldPauseContract is address(0), withdraw-only guard is a no-op
    function test_noPauseController_transfersAllowed() public {
        // Remove pause controller
        pool.setShieldPauseContract(address(0));

        Transaction[] memory txs = new Transaction[](1);
        txs[0] = _buildMinimalTransaction(UnshieldType.NONE);

        try pool.transact(txs) {
            // Success
        } catch Error(string memory reason) {
            assertTrue(
                keccak256(bytes(reason)) != keccak256(bytes("TransactModule: withdraw only")),
                "No pause controller should not trigger withdraw-only guard"
            );
        }
    }
}
