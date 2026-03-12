// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/PrivacyPoolClient.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/privacy-pool/types/CCTPTypes.sol";
import "../contracts/cctp/ICCTPV2.sol";

/// @title PrivacyPoolSecurityBlockersTest
/// @notice Tests for H-1/H-2 (CCTP domain validation) and H-5 (deployer-only initialize)
contract PrivacyPoolSecurityBlockersTest is Test {
    PrivacyPool pool;
    ShieldModule shieldModule;
    TransactModule transactModule;
    MerkleModule merkleModule;
    VerifierModule verifierModule;

    address deployer = address(0xD1);
    address attacker = address(0xA1);
    address mockTokenMessenger = address(0x1111);
    address mockMessageTransmitter = address(0x2222);
    address mockUsdc = address(0x3333);
    address mockHookRouter = address(0x4444);

    uint32 constant HUB_DOMAIN = 100;
    uint32 constant CLIENT_A_DOMAIN = 101;
    uint32 constant CLIENT_B_DOMAIN = 102;
    uint32 constant ROGUE_DOMAIN = 999;

    bytes32 constant CLIENT_A_POOL = bytes32(uint256(0xCA));
    bytes32 constant CLIENT_B_POOL = bytes32(uint256(0xCB));

    function setUp() public {
        // Deploy modules (these don't need deployer guard)
        shieldModule = new ShieldModule();
        transactModule = new TransactModule();
        merkleModule = new MerkleModule();
        verifierModule = new VerifierModule();

        // Deploy pool as deployer
        vm.prank(deployer);
        pool = new PrivacyPool();

        // Initialize as deployer
        vm.prank(deployer);
        pool.initialize(
            address(shieldModule),
            address(transactModule),
            address(merkleModule),
            address(verifierModule),
            mockTokenMessenger,
            mockMessageTransmitter,
            mockUsdc,
            HUB_DOMAIN,
            deployer,
            true // testingMode: bypass SNARK verification for tests
        );

        // Register remote pools
        vm.startPrank(deployer);
        pool.setRemotePool(CLIENT_A_DOMAIN, CLIENT_A_POOL);
        pool.setRemotePool(CLIENT_B_DOMAIN, CLIENT_B_POOL);
        pool.setHookRouter(mockHookRouter);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════
    // H-5: Deployer-only initialize()
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Attacker cannot front-run initialize() on a fresh PrivacyPool
    function test_H5_attackerCannotInitialize() public {
        // Deploy a new pool as deployer
        vm.prank(deployer);
        PrivacyPool newPool = new PrivacyPool();

        // Attacker tries to front-run initialize
        vm.prank(attacker);
        vm.expectRevert("PrivacyPool: Only deployer can initialize");
        newPool.initialize(
            address(shieldModule),
            address(transactModule),
            address(merkleModule),
            address(verifierModule),
            mockTokenMessenger,
            mockMessageTransmitter,
            mockUsdc,
            HUB_DOMAIN,
            attacker, // attacker tries to set themselves as owner
            false
        );
    }

    /// @notice Deployer can initialize successfully
    function test_H5_deployerCanInitialize() public {
        vm.prank(deployer);
        PrivacyPool newPool = new PrivacyPool();

        vm.prank(deployer);
        newPool.initialize(
            address(shieldModule),
            address(transactModule),
            address(merkleModule),
            address(verifierModule),
            mockTokenMessenger,
            mockMessageTransmitter,
            mockUsdc,
            HUB_DOMAIN,
            deployer,
            false
        );

        assertTrue(newPool.initialized());
        assertEq(newPool.owner(), deployer);
    }

    /// @notice Double-initialize still reverts
    function test_H5_cannotDoubleInitialize() public {
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
            HUB_DOMAIN,
            deployer,
            false
        );
    }

    /// @notice H-5 also applies to PrivacyPoolClient
    function test_H5_clientAttackerCannotInitialize() public {
        vm.prank(deployer);
        PrivacyPoolClient client = new PrivacyPoolClient();

        vm.prank(attacker);
        vm.expectRevert("PrivacyPoolClient: Only deployer can initialize");
        client.initialize(
            mockTokenMessenger,
            mockMessageTransmitter,
            mockUsdc,
            CLIENT_A_DOMAIN,
            HUB_DOMAIN,
            bytes32(uint256(uint160(address(pool)))),
            attacker
        );
    }

    /// @notice PrivacyPoolClient deployer can initialize
    function test_H5_clientDeployerCanInitialize() public {
        vm.prank(deployer);
        PrivacyPoolClient client = new PrivacyPoolClient();

        vm.prank(deployer);
        client.initialize(
            mockTokenMessenger,
            mockMessageTransmitter,
            mockUsdc,
            CLIENT_A_DOMAIN,
            HUB_DOMAIN,
            bytes32(uint256(uint160(address(pool)))),
            deployer
        );

        assertTrue(client.initialized());
    }

    /// @notice Fuzz: no address other than deployer can initialize
    function testFuzz_H5_onlyDeployerCanInitialize(address caller) public {
        vm.assume(caller != deployer);

        vm.prank(deployer);
        PrivacyPool newPool = new PrivacyPool();

        vm.prank(caller);
        vm.expectRevert("PrivacyPool: Only deployer can initialize");
        newPool.initialize(
            address(shieldModule),
            address(transactModule),
            address(merkleModule),
            address(verifierModule),
            mockTokenMessenger,
            mockMessageTransmitter,
            mockUsdc,
            HUB_DOMAIN,
            caller,
            false
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // H-1/H-2: CCTP remoteDomain validation
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Helper: build a minimal valid BurnMessageV2 with SHIELD payload
    function _buildShieldMessage(uint256 amount) internal pure returns (bytes memory) {
        ShieldData memory sd = ShieldData({
            npk: bytes32(uint256(1)),
            value: uint120(amount),
            encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
            shieldKey: bytes32(uint256(2))
        });

        bytes memory hookData = CCTPPayloadLib.encodeShield(sd);

        return BurnMessageV2.encode(
            bytes32(0), // burnToken
            bytes32(0), // mintRecipient
            amount,
            bytes32(0), // messageSender
            0,          // maxFee
            0,          // feeExecuted
            0,          // expirationBlock
            hookData
        );
    }

    /// @notice Registered domain is accepted
    function test_H1H2_registeredDomainAccepted() public {
        bytes memory messageBody = _buildShieldMessage(1000e6);

        // Fund pool with USDC for shield
        vm.mockCall(
            mockUsdc,
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(pool)),
            abi.encode(uint256(2000e6))
        );

        // Call from hookRouter with registered domain
        vm.prank(mockHookRouter);
        bool result = pool.handleReceiveFinalizedMessage(
            CLIENT_A_DOMAIN,
            bytes32(0),
            CCTPFinality.STANDARD,
            messageBody
        );
        assertTrue(result);
    }

    /// @notice Unregistered domain is rejected
    function test_H1H2_unregisteredDomainRejected() public {
        bytes memory messageBody = _buildShieldMessage(1000e6);

        vm.prank(mockHookRouter);
        vm.expectRevert("PrivacyPool: Unknown remote domain");
        pool.handleReceiveFinalizedMessage(
            ROGUE_DOMAIN,
            bytes32(0),
            CCTPFinality.STANDARD,
            messageBody
        );
    }

    /// @notice Domain 0 (never registered) is rejected
    function test_H1H2_zeroDomainRejected() public {
        bytes memory messageBody = _buildShieldMessage(1000e6);

        vm.prank(mockHookRouter);
        vm.expectRevert("PrivacyPool: Unknown remote domain");
        pool.handleReceiveFinalizedMessage(
            0,
            bytes32(0),
            CCTPFinality.STANDARD,
            messageBody
        );
    }

    /// @notice After removing a domain, messages from it are rejected
    function test_H1H2_removedDomainRejected() public {
        // Remove Client A
        vm.prank(deployer);
        pool.setRemotePool(CLIENT_A_DOMAIN, bytes32(0));

        bytes memory messageBody = _buildShieldMessage(1000e6);

        vm.prank(mockHookRouter);
        vm.expectRevert("PrivacyPool: Unknown remote domain");
        pool.handleReceiveFinalizedMessage(
            CLIENT_A_DOMAIN,
            bytes32(0),
            CCTPFinality.STANDARD,
            messageBody
        );
    }

    /// @notice Fuzz: any unregistered domain is rejected
    function testFuzz_H1H2_unregisteredDomainRejected(uint32 domain) public {
        vm.assume(domain != CLIENT_A_DOMAIN && domain != CLIENT_B_DOMAIN);

        bytes memory messageBody = _buildShieldMessage(1000e6);

        vm.prank(mockHookRouter);
        vm.expectRevert("PrivacyPool: Unknown remote domain");
        pool.handleReceiveFinalizedMessage(
            domain,
            bytes32(0),
            CCTPFinality.STANDARD,
            messageBody
        );
    }

    /// @notice Unauthorized caller is still rejected (existing check)
    function test_unauthorizedCallerRejected() public {
        bytes memory messageBody = _buildShieldMessage(1000e6);

        vm.prank(attacker);
        vm.expectRevert("PrivacyPool: Unauthorized caller");
        pool.handleReceiveFinalizedMessage(
            CLIENT_A_DOMAIN,
            bytes32(0),
            CCTPFinality.STANDARD,
            messageBody
        );
    }

    /// @notice Insufficient finality is still rejected (existing check)
    function test_insufficientFinalityRejected() public {
        bytes memory messageBody = _buildShieldMessage(1000e6);

        vm.prank(mockHookRouter);
        vm.expectRevert("PrivacyPool: Insufficient finality");
        pool.handleReceiveFinalizedMessage(
            CLIENT_A_DOMAIN,
            bytes32(0),
            CCTPFinality.FAST, // Below STANDARD threshold
            messageBody
        );
    }
}
