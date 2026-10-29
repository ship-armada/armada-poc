// ABOUTME: The CCTP hook router on PrivacyPool and PrivacyPoolClient is set once, non-zero, by the owner,
// ABOUTME: and announced with HookRouterSet, so a later owner-key compromise can't re-point it (#641).
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/PrivacyPoolClient.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "./helpers/PoseidonLinker.sol";

contract HookRouterSetOnceTest is Test, PoseidonLinker {
    event HookRouterSet(address indexed hookRouter);

    address internal constant ROUTER = address(0x7007E5);
    address internal constant OTHER_ROUTER = address(0xBAD7007E5);
    address internal constant STRANGER = address(0x5757);

    PrivacyPool internal pool;
    PrivacyPoolClient internal client;

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
            0,               // localDomain
            address(this),   // owner
            payable(address(0xFEE))
        );
        client = new PrivacyPoolClient();
        client.initialize(
            address(0x7E55), // tokenMessenger (unused here)
            address(0x7A45), // messageTransmitter (unused here)
            address(0x05DC), // usdc (unused here)
            1,               // localDomain
            0,               // hubDomain
            bytes32(uint256(uint160(address(pool)))),
            address(this)    // owner
        );
    }

    // ── PrivacyPool ─────────────────────────────────────────────────────────

    /// @notice WHY: the hub pool credits shield notes for any message its hook router delivers,
    ///         without checking USDC arrived. Wiring the router must be announced so monitors see it.
    function test_pool_setHookRouterEmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit HookRouterSet(ROUTER);
        pool.setHookRouter(ROUTER);
        assertEq(pool.hookRouter(), ROUTER);
    }

    /// @notice WHY: a re-pointable router would let whoever holds the owner key point it at their
    ///         own address, deliver a fabricated shield message and mint unbacked notes. After the
    ///         one-time wiring at link time the router can't change.
    function test_pool_secondSetReverts() public {
        pool.setHookRouter(ROUTER);
        vm.expectRevert("PrivacyPool: hook router already set");
        pool.setHookRouter(OTHER_ROUTER);
        assertEq(pool.hookRouter(), ROUTER);
    }

    /// @notice WHY: setting zero would leave the slot "unset" and so re-settable, defeating set-once.
    function test_pool_zeroRouterReverts() public {
        vm.expectRevert("PrivacyPool: zero hook router");
        pool.setHookRouter(address(0));
    }

    /// @notice WHY: only the owner may perform the one-time wiring; anyone else could otherwise
    ///         claim the slot first and become the pool's trusted message source.
    function test_pool_nonOwnerReverts() public {
        vm.prank(STRANGER);
        vm.expectRevert("PrivacyPool: Only owner");
        pool.setHookRouter(ROUTER);
    }

    // ── PrivacyPoolClient ───────────────────────────────────────────────────

    /// @notice WHY: the client pays out cross-chain unshields for messages its hook router delivers.
    ///         Wiring it must be announced, like the hub's.
    function test_client_setHookRouterEmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(client));
        emit HookRouterSet(ROUTER);
        client.setHookRouter(ROUTER);
        assertEq(client.hookRouter(), ROUTER);
    }

    /// @notice WHY: re-pointing the client's router while an unshield is in flight would make that
    ///         message undeliverable (the hub pins its destinationCaller to the old router), and a
    ///         compromised owner could pay out any USDC the client holds. Set-once removes both.
    function test_client_secondSetReverts() public {
        client.setHookRouter(ROUTER);
        vm.expectRevert("PrivacyPoolClient: hook router already set");
        client.setHookRouter(OTHER_ROUTER);
        assertEq(client.hookRouter(), ROUTER);
    }

    /// @notice WHY: as on the hub, zero would leave the slot re-settable.
    function test_client_zeroRouterReverts() public {
        vm.expectRevert("PrivacyPoolClient: zero hook router");
        client.setHookRouter(address(0));
    }

    /// @notice WHY: only the owner may perform the one-time wiring.
    function test_client_nonOwnerReverts() public {
        vm.prank(STRANGER);
        vm.expectRevert("PrivacyPoolClient: Only owner");
        client.setHookRouter(ROUTER);
    }
}
