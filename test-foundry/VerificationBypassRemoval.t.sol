// ABOUTME: Foundry tests verifying C-1/C-2 audit fix: setTestingMode() removed and
// ABOUTME: VERIFICATION_BYPASS (0xdead tx.origin) is no longer present in the codebase.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";

/// @title VerificationBypassRemovalTest
/// @notice Tests confirming C-1/C-2 audit fixes:
///         - setTestingMode() function removed (testingMode is init-only)
///         - VERIFICATION_BYPASS (tx.origin == 0xdead) removed from verification logic
contract VerificationBypassRemovalTest is Test {
    PrivacyPool pool;
    ShieldModule shieldModule;
    TransactModule transactModule;
    MerkleModule merkleModule;
    VerifierModule verifierModule;

    address deployer = address(0xD1);
    address owner = address(0xD1);
    address mockTokenMessenger = address(0x1111);
    address mockMessageTransmitter = address(0x2222);
    address mockUsdc = address(0x3333);

    /// @notice Deploy pool with testingMode=false (production mode)
    function _deployPool(bool _testingMode) internal returns (PrivacyPool) {
        vm.startPrank(deployer);
        shieldModule = new ShieldModule();
        transactModule = new TransactModule();
        merkleModule = new MerkleModule();
        verifierModule = new VerifierModule();

        PrivacyPool p = new PrivacyPool();
        p.initialize(
            address(shieldModule),
            address(transactModule),
            address(merkleModule),
            address(verifierModule),
            mockTokenMessenger,
            mockMessageTransmitter,
            mockUsdc,
            0, // localDomain
            owner,
            _testingMode
        );
        vm.stopPrank();
        return p;
    }

    function setUp() public {
        pool = _deployPool(false); // production mode
    }

    // ═══════════════════════════════════════════════════════════════════
    // C-1: testingMode is immutable after initialization
    // ═══════════════════════════════════════════════════════════════════

    /// @notice testingMode starts as false when initialized with false
    function test_C1_testingModeFalseAfterInit() public view {
        assertEq(pool.testingMode(), false, "testingMode should be false");
    }

    /// @notice testingMode starts as true when initialized with true
    function test_C1_testingModeTrueWhenInitializedTrue() public {
        PrivacyPool testPool = _deployPool(true);
        assertEq(testPool.testingMode(), true, "testingMode should be true");
    }

    /// @notice setTestingMode function does not exist on PrivacyPool
    /// @dev Low-level call to the old selector should revert (function not found)
    function test_C1_setTestingModeDoesNotExist() public {
        // setTestingMode(bool) selector = keccak256("setTestingMode(bool)")[:4]
        bytes4 selector = bytes4(keccak256("setTestingMode(bool)"));
        bytes memory callData = abi.encodePacked(selector, abi.encode(true));

        vm.prank(owner);
        (bool success, ) = address(pool).call(callData);
        assertFalse(success, "setTestingMode should not exist");
    }

    /// @notice Re-initialization is blocked, so testingMode cannot be changed via initialize()
    function test_C1_cannotReinitializeToChangeTestingMode() public {
        vm.prank(deployer);
        vm.expectRevert("PrivacyPool: Already initialized");
        pool.initialize(
            address(shieldModule),
            address(transactModule),
            address(merkleModule),
            address(verifierModule),
            mockTokenMessenger,
            mockMessageTransmitter,
            mockUsdc,
            0,
            owner,
            true // try to flip testingMode
        );
        // testingMode unchanged
        assertEq(pool.testingMode(), false);
    }

    /// @notice Fuzz: testingMode is always the value passed at initialization
    function testFuzz_C1_testingModeMatchesInitParam(bool _testingMode) public {
        PrivacyPool p = _deployPool(_testingMode);
        assertEq(p.testingMode(), _testingMode, "testingMode should match init param");
    }

    // ═══════════════════════════════════════════════════════════════════
    // C-2: VERIFICATION_BYPASS (0xdead) is removed
    // ═══════════════════════════════════════════════════════════════════

    /// @notice verify() with tx.origin=0xdead does NOT bypass verification
    /// @dev With testingMode=false and no verification key set, verify() should revert
    ///      even when tx.origin is the old bypass address
    function test_C2_deadOriginDoesNotBypassVerification() public {
        address deadAddr = 0x000000000000000000000000000000000000dEaD;

        // Build a minimal transaction
        Transaction memory txn = _buildMinimalTransaction();

        // Call verify() with tx.origin=0xdead — should revert because no VK is set
        // If the bypass were still present, it would return true instead of reverting
        vm.prank(deadAddr, deadAddr); // sets both msg.sender and tx.origin
        vm.expectRevert("PrivacyPool: Verification key not set");
        pool.verify(txn);
    }

    /// @notice Fuzz: arbitrary tx.origin values cannot bypass verification
    function testFuzz_C2_noOriginBypassesVerification(address _origin) public {
        // Skip address(0) — cannot prank from zero
        vm.assume(_origin != address(0));

        Transaction memory txn = _buildMinimalTransaction();

        // Should always revert (no VK set) regardless of tx.origin
        vm.prank(_origin, _origin);
        vm.expectRevert("PrivacyPool: Verification key not set");
        pool.verify(txn);
    }

    /// @notice With testingMode=true, verify() returns true regardless of proof
    function test_C2_testingModeStillWorksAtInit() public {
        PrivacyPool testPool = _deployPool(true);
        Transaction memory txn = _buildMinimalTransaction();

        // In testing mode, verify should return true without needing a VK
        bool result = testPool.verify(txn);
        assertTrue(result, "testingMode=true should bypass verification");
    }

    // ═══════════════════════════════════════════════════════════════════
    // Combined property: production pool rejects invalid proofs
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Production pool (testingMode=false) rejects transactions when no VK is set
    function test_productionPoolRejectsWithoutVK() public {
        Transaction memory txn = _buildMinimalTransaction();

        vm.expectRevert("PrivacyPool: Verification key not set");
        pool.verify(txn);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    function _buildMinimalTransaction() internal pure returns (Transaction memory) {
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = bytes32(uint256(1));

        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = bytes32(uint256(2));

        CommitmentCiphertext[] memory ciphertexts = new CommitmentCiphertext[](0);

        return Transaction({
            proof: SnarkProof({
                a: G1Point({x: 0, y: 0}),
                b: G2Point({x: [uint256(0), 0], y: [uint256(0), 0]}),
                c: G1Point({x: 0, y: 0})
            }),
            merkleRoot: bytes32(uint256(123)),
            nullifiers: nullifiers,
            commitments: commitments,
            boundParams: BoundParams({
                treeNumber: 0,
                minGasPrice: 0,
                unshield: UnshieldType.NONE,
                chainID: 0,
                adaptContract: address(0),
                adaptParams: bytes32(0),
                commitmentCiphertext: ciphertexts
            }),
            unshieldPreimage: CommitmentPreimage({
                npk: bytes32(0),
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: address(0),
                    tokenSubID: 0
                }),
                value: 0
            })
        });
    }
}
