// ABOUTME: A cross-chain unshield to a domain with no pinned hook router is rejected before any
// ABOUTME: proof work or burn (D-16). Replaces the golden vector dropped in #633.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "./helpers/PoseidonLinker.sol";

contract CrossChainUnshieldHookRouterRequiredTest is Test, PoseidonLinker {
    uint32 internal constant CLIENT_DOMAIN = 1;
    address internal constant USDC = address(0x05DC);

    PrivacyPool internal pool;

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
            USDC,
            0,
            address(this),
            payable(address(0xFEE))
        );
        pool.setRemotePool(CLIENT_DOMAIN, bytes32(uint256(0xC11E)));
        // Deliberately no setRemoteHookRouter(CLIENT_DOMAIN, ...).
    }

    /// @notice WHY: the outbound burn's CCTP destinationCaller is pinned to the destination's hook
    ///         router (D-16). With none configured the burn could not be delivered through a hook
    ///         router, so the unshield must be rejected before any proof is checked or USDC burned.
    function test_rejectsDestinationWithoutHookRouter() public {
        Transaction memory txn;
        txn.boundParams.unshield = UnshieldType.NORMAL;
        txn.unshieldPreimage.token = TokenData({tokenType: TokenType.ERC20, tokenAddress: USDC, tokenSubID: 0});

        vm.expectRevert("TransactModule: Hook router not configured");
        pool.atomicCrossChainUnshield(txn, CLIENT_DOMAIN, address(0xBEEF), 0, bytes32(0));
    }
}
