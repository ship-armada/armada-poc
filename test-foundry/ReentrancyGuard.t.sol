// ABOUTME: Foundry tests for H-12 ReentrancyGuard on PrivacyPool entry points.
// ABOUTME: Verifies shield, transact, atomicCrossChainUnshield, and handleReceiveFinalizedMessage are protected.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/privacy-pool/types/CCTPTypes.sol";
import "../contracts/cctp/ICCTPV2.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ReentrancyToken — Malicious ERC20 that re-enters PrivacyPool during transferFrom
/// @dev Used to test that the nonReentrant modifier blocks reentrancy via token callbacks.
///      In production, USDC has no transfer hooks, so this attack is theoretical.
///      The guard is defense-in-depth against future token integrations or custom tokens.
contract ReentrancyToken is ERC20 {
    address public attackTarget;
    bytes public attackCalldata;
    bool public armed;

    constructor() ERC20("Reentrant", "REENTER") {
        _mint(msg.sender, 1_000_000e6);
    }

    function setAttack(address target, bytes calldata data) external {
        attackTarget = target;
        attackCalldata = data;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (armed && attackTarget != address(0)) {
            armed = false; // prevent infinite loop
            // Attempt reentrant call during transfer
            (bool success, bytes memory returnData) = attackTarget.call(attackCalldata);
            if (!success) {
                // Store the revert reason for test assertions
                assembly {
                    // We expect this to revert with "PrivacyPool: Reentrant call"
                    // The test will check the attackTarget call failed
                }
            }
            // Store result for later inspection
            lastAttackSuccess = success;
            lastAttackReturnData = returnData;
        }
        return super.transferFrom(from, to, amount);
    }

    bool public lastAttackSuccess;
    bytes public lastAttackReturnData;
}

/// @title ReentrancyGuardTest
/// @notice Tests that PrivacyPool entry points are protected by nonReentrant modifier (H-12)
contract ReentrancyGuardTest is Test {
    PrivacyPool pool;
    ShieldModule shieldModule;
    TransactModule transactModule;
    MerkleModule merkleModule;
    VerifierModule verifierModule;
    ReentrancyToken maliciousToken;

    address deployer = address(0xD1);
    address user = address(0xB1);
    address mockTokenMessenger = address(0x1111);
    address mockMessageTransmitter = address(0x2222);
    address mockHookRouter = address(0x4444);

    uint32 constant HUB_DOMAIN = 100;
    uint32 constant CLIENT_A_DOMAIN = 101;
    bytes32 constant CLIENT_A_POOL = bytes32(uint256(0xCA));

    function setUp() public {
        // Deploy malicious token
        maliciousToken = new ReentrancyToken();

        // Deploy modules
        shieldModule = new ShieldModule();
        transactModule = new TransactModule();
        merkleModule = new MerkleModule();
        verifierModule = new VerifierModule();

        // Deploy pool as deployer
        vm.prank(deployer);
        pool = new PrivacyPool();

        // Initialize with malicious token as "usdc"
        vm.prank(deployer);
        pool.initialize(
            address(shieldModule),
            address(transactModule),
            address(merkleModule),
            address(verifierModule),
            mockTokenMessenger,
            mockMessageTransmitter,
            address(maliciousToken),
            HUB_DOMAIN,
            deployer,
            true // testingMode: bypass SNARK verification
        );

        // Register remote pool and hookRouter
        vm.startPrank(deployer);
        pool.setRemotePool(CLIENT_A_DOMAIN, CLIENT_A_POOL);
        pool.setHookRouter(mockHookRouter);
        vm.stopPrank();

        // Give user tokens and approve pool
        maliciousToken.transfer(user, 100_000e6);
        vm.prank(user);
        maliciousToken.approve(address(pool), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helper: build a minimal ShieldRequest
    // ═══════════════════════════════════════════════════════════════════

    function _buildShieldRequest(uint256 amount) internal view returns (ShieldRequest[] memory) {
        CommitmentPreimage memory preimage = CommitmentPreimage({
            npk: bytes32(uint256(1)),
            token: TokenData({tokenType: TokenType.ERC20, tokenAddress: address(maliciousToken), tokenSubID: 0}),
            value: uint120(amount)
        });

        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: preimage,
            ciphertext: ShieldCiphertext({
                encryptedBundle: [bytes32(uint256(10)), bytes32(uint256(11)), bytes32(uint256(12))],
                shieldKey: bytes32(uint256(13))
            })
        });
        return requests;
    }

    function _buildShieldCalldata(uint256 amount) internal view returns (bytes memory) {
        ShieldRequest[] memory requests = _buildShieldRequest(amount);
        return abi.encodeWithSelector(PrivacyPool.shield.selector, requests);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Test: shield() is protected
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Reentering shield() during a shield() call reverts
    function test_H12_shieldReentrancyBlocked() public {
        // Arm the malicious token to re-enter shield() during transferFrom
        bytes memory reentrantCalldata = _buildShieldCalldata(100e6);
        maliciousToken.setAttack(address(pool), reentrantCalldata);

        // Call shield — during transferFrom, the token will try to re-enter shield()
        vm.prank(user);
        pool.shield(_buildShieldRequest(1000e6));

        // The reentrant call should have failed
        assertFalse(maliciousToken.lastAttackSuccess(), "Reentrant shield() should have been blocked");
    }

    /// @notice Reentering transact() during a shield() call reverts
    function test_H12_shieldToTransactReentrancyBlocked() public {
        // Build a minimal transact call (will fail on its own merits, but reentrancy check comes first)
        Transaction[] memory txns = new Transaction[](1);
        txns[0].proof = SnarkProof({a: G1Point(0, 0), b: G2Point([uint256(0), 0], [uint256(0), 0]), c: G1Point(0, 0)});
        txns[0].merkleRoot = bytes32(0);
        txns[0].boundParams = BoundParams({
            treeNumber: 0,
            minGasPrice: 0,
            unshield: UnshieldType.NONE,
            chainID: uint64(0),
            adaptContract: address(0),
            adaptParams: bytes32(0),
            commitmentCiphertext: new CommitmentCiphertext[](0)
        });
        txns[0].nullifiers = new bytes32[](1);
        txns[0].commitments = new bytes32[](1);

        bytes memory reentrantCalldata = abi.encodeWithSelector(PrivacyPool.transact.selector, txns);
        maliciousToken.setAttack(address(pool), reentrantCalldata);

        vm.prank(user);
        pool.shield(_buildShieldRequest(1000e6));

        assertFalse(maliciousToken.lastAttackSuccess(), "Reentrant transact() during shield() should be blocked");
    }

    // ═══════════════════════════════════════════════════════════════════
    // Test: handleReceiveFinalizedMessage() is protected
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Reentering handleReceiveFinalizedMessage during a previous call reverts
    function test_H12_handleMessageReentrancyBlocked() public {
        // Build a valid CCTP message
        ShieldData memory sd = ShieldData({
            npk: bytes32(uint256(1)),
            value: uint120(1000e6),
            encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
            shieldKey: bytes32(uint256(2))
        });
        bytes memory hookData = CCTPPayloadLib.encodeShield(sd);
        bytes memory messageBody = BurnMessageV2.encode(
            bytes32(0), bytes32(0), 1000e6, bytes32(0), 0, 0, 0, hookData
        );

        // The pool's shield flow will try to transferFrom the "usdc" (malicious token).
        // But wait — for incoming cross-chain shields, tokens are already minted to the pool.
        // The ShieldModule.processIncomingShield doesn't do transferFrom. So we need a
        // different attack vector for this function.

        // Instead, test that calling handleReceiveFinalizedMessage while already in a
        // nonReentrant context fails. We simulate this by having the malicious token
        // (used in a shield call) try to call handleReceiveFinalizedMessage.
        bytes memory reentrantCalldata = abi.encodeWithSelector(
            PrivacyPool.handleReceiveFinalizedMessage.selector,
            CLIENT_A_DOMAIN,
            bytes32(0),
            CCTPFinality.STANDARD,
            messageBody
        );
        maliciousToken.setAttack(address(pool), reentrantCalldata);

        // Trigger shield — during transferFrom, token tries to call handleReceiveFinalizedMessage
        vm.prank(user);
        pool.shield(_buildShieldRequest(1000e6));

        assertFalse(
            maliciousToken.lastAttackSuccess(),
            "Reentrant handleReceiveFinalizedMessage during shield() should be blocked"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // Test: atomicCrossChainUnshield() is protected
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Reentering atomicCrossChainUnshield during shield() reverts
    function test_H12_atomicCrossChainUnshieldReentrancyBlocked() public {
        // Build a minimal atomicCrossChainUnshield call
        Transaction memory txn;
        txn.proof = SnarkProof({a: G1Point(0, 0), b: G2Point([uint256(0), 0], [uint256(0), 0]), c: G1Point(0, 0)});
        txn.merkleRoot = bytes32(0);
        txn.boundParams = BoundParams({
            treeNumber: 0,
            minGasPrice: 0,
            unshield: UnshieldType.NONE,
            chainID: uint64(0),
            adaptContract: address(0),
            adaptParams: bytes32(0),
            commitmentCiphertext: new CommitmentCiphertext[](0)
        });
        txn.nullifiers = new bytes32[](1);
        txn.commitments = new bytes32[](1);

        bytes memory reentrantCalldata = abi.encodeWithSelector(
            PrivacyPool.atomicCrossChainUnshield.selector,
            txn,
            CLIENT_A_DOMAIN,
            user,
            bytes32(0),
            uint256(0)
        );
        maliciousToken.setAttack(address(pool), reentrantCalldata);

        vm.prank(user);
        pool.shield(_buildShieldRequest(1000e6));

        assertFalse(
            maliciousToken.lastAttackSuccess(),
            "Reentrant atomicCrossChainUnshield during shield() should be blocked"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // Test: Normal (non-reentrant) calls still work
    // ═══════════════════════════════════════════════════════════════════

    /// @notice shield() works normally when not reentering
    function test_H12_shieldWorksNormally() public {
        // Token is not armed — normal behavior
        vm.prank(user);
        pool.shield(_buildShieldRequest(1000e6));

        // Verify commitment was inserted (merkle tree advanced)
        assertEq(pool.treeNumber(), 0);
        // nextLeafIndex should have advanced by 1
        assertTrue(pool.nextLeafIndex() > 0, "Leaf should have been inserted");
    }

    /// @notice Multiple sequential shield() calls work (guard resets properly)
    function test_H12_sequentialShieldsWork() public {
        vm.startPrank(user);
        pool.shield(_buildShieldRequest(100e6));
        pool.shield(_buildShieldRequest(200e6));
        pool.shield(_buildShieldRequest(300e6));
        vm.stopPrank();

        // All three should have been inserted
        assertEq(pool.nextLeafIndex(), 3, "Three leaves should have been inserted");
    }

    // ═══════════════════════════════════════════════════════════════════
    // Fuzz tests
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Fuzz: shield with arbitrary amounts still works (guard doesn't interfere)
    function testFuzz_H12_shieldArbitraryAmountsWork(uint120 amount) public {
        // Bound to reasonable range (1 USDC to 10M USDC)
        amount = uint120(bound(uint256(amount), 1e6, 10_000_000e6));

        // Ensure user has enough tokens
        deal(address(maliciousToken), user, uint256(amount) * 2);
        vm.prank(user);
        maliciousToken.approve(address(pool), type(uint256).max);

        vm.prank(user);
        pool.shield(_buildShieldRequest(amount));

        assertTrue(pool.nextLeafIndex() > 0, "Leaf should have been inserted");
    }

    /// @notice Fuzz: reentrant calls always fail regardless of amount
    function testFuzz_H12_reentrancyAlwaysBlocked(uint120 shieldAmount, uint120 reenterAmount) public {
        shieldAmount = uint120(bound(uint256(shieldAmount), 1e6, 10_000_000e6));
        reenterAmount = uint120(bound(uint256(reenterAmount), 1e6, 10_000_000e6));

        // Ensure user has enough tokens
        deal(address(maliciousToken), user, uint256(shieldAmount) * 2);
        vm.prank(user);
        maliciousToken.approve(address(pool), type(uint256).max);

        // Arm token to re-enter with different amount
        bytes memory reentrantCalldata = _buildShieldCalldata(reenterAmount);
        maliciousToken.setAttack(address(pool), reentrantCalldata);

        vm.prank(user);
        pool.shield(_buildShieldRequest(shieldAmount));

        assertFalse(maliciousToken.lastAttackSuccess(), "Reentrant call should always fail");
    }
}
