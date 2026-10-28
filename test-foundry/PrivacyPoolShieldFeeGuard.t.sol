// ABOUTME: The pool's legacy flat shield fee is settable only while no fee module is wired (#155).
// ABOUTME: Detaching the fee module puts the pool in emergency flat-fee mode, where the setter works again.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/cctp/MockUSDCV2.sol";
import "./helpers/PoseidonLinker.sol";

contract PrivacyPoolShieldFeeGuardTest is Test, PoseidonLinker {
    PrivacyPool internal pool;
    MockUSDCV2 internal usdc;

    address internal constant TREASURY = address(0xFEE);
    address internal constant FEE_MODULE = address(0xFEE0);
    address internal shielder = address(0x5111E1D);

    function setUp() public {
        _linkRealPoseidon();
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        usdc.addMinter(address(this));
        pool = new PrivacyPool();
        pool.initialize(
            address(new ShieldModule()),
            address(new TransactModule()),
            address(new MerkleModule()),
            address(new VerifierModule()),
            address(0x7E55), // tokenMessenger (unused here)
            address(0x7A45), // messageTransmitter (unused here)
            address(usdc),
            0,               // localDomain
            address(this),   // owner
            payable(TREASURY)
        );
    }

    function _shield(uint120 amount) internal {
        usdc.mint(shielder, amount);
        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: bytes32(uint256(1234)),
                token: TokenData({tokenType: TokenType.ERC20, tokenAddress: address(usdc), tokenSubID: 0}),
                value: amount
            }),
            ciphertext: ShieldCiphertext({encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)], shieldKey: bytes32(0)})
        });
        vm.startPrank(shielder);
        usdc.approve(address(pool), amount);
        pool.shield(requests, address(0));
        vm.stopPrank();
    }

    /// @notice WHY: without a fee module the flat fee is the live rate, so the owner must be able
    ///         to set it (this is also how the deploy script configures the pool before wiring the
    ///         fee module).
    function test_setShieldFeeWorksWithoutFeeModule() public {
        pool.setShieldFee(50);
        assertEq(pool.shieldFee(), 50);
    }

    /// @notice WHY: while a fee module is wired it alone sets the fee. Accepting a flat-fee change
    ///         then would silently do nothing and make `shieldFee()` disagree with the fee charged.
    function test_setShieldFeeRevertsWhileFeeModuleIsActive() public {
        pool.setFeeModule(FEE_MODULE);
        vm.expectRevert("PrivacyPool: use fee module");
        pool.setShieldFee(50);
    }

    /// @notice WHY: the flat-fee fallback is the emergency mode for a broken or misbehaving fee
    ///         module. Detaching it must unlock the setter, and shields must then pay the flat fee.
    function test_detachingFeeModuleRestoresFlatFeeMode() public {
        pool.setFeeModule(FEE_MODULE);
        pool.setFeeModule(address(0));

        pool.setShieldFee(30);
        _shield(1_000e6);

        assertEq(usdc.balanceOf(TREASURY), 3e6, "flat 30 bps fee paid to treasury");
        assertEq(usdc.balanceOf(address(pool)), 997e6, "note value is the amount after the fee");
    }
}
