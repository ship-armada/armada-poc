// ABOUTME: The pool validates the fee module's shield-fee split before moving any tokens (#640):
// ABOUTME: parts must sum to the total, an integrator fee needs an integrator, and the total is capped.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/cctp/MockUSDCV2.sol";
import "../contracts/fees/ArmadaFeeModule.sol";
import "../contracts/test/ConfigurableFeeModule.sol";
import "./helpers/PoseidonLinker.sol";

contract PrivacyPoolFeeModuleSplitGuardTest is Test, PoseidonLinker {
    uint32 internal constant CLIENT_DOMAIN = 1;
    bytes32 internal constant CLIENT_POOL = bytes32(uint256(0xC11E));
    address internal constant TREASURY = address(0x7EA5);
    address internal constant INTEGRATOR = address(0x1D7E);
    // Other users' funds already held by the pool, which a bad split must never reach.
    uint256 internal constant OTHER_USERS_USDC = 1_000_000e6;
    uint120 internal constant AMOUNT = 1_000e6;
    // The pool-side cap on a fee-module shield fee (15%), mirrored from ShieldModule.
    uint256 internal constant CAP_BPS = 1500;

    PrivacyPool internal pool;
    MockUSDCV2 internal usdc;
    ConfigurableFeeModule internal feeModule;
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
            address(0x7E55), // tokenMessenger (unused: this test is the hook router)
            address(0x7A45), // messageTransmitter (unused here)
            address(usdc),
            0,               // localDomain
            address(this),   // owner
            payable(TREASURY)
        );
        pool.setHookRouter(address(this));
        pool.setRemotePool(CLIENT_DOMAIN, CLIENT_POOL);
        feeModule = new ConfigurableFeeModule();
        pool.setFeeModule(address(feeModule));
        usdc.mint(address(pool), OTHER_USERS_USDC);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function _ciphertext() internal pure returns (ShieldCiphertext memory) {
        return ShieldCiphertext({encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)], shieldKey: bytes32(0)});
    }

    /// @dev Local shield of AMOUNT USDC by `shielder`, approving the full amount. A non-empty
    ///      `expectedRevert` is armed immediately before the pool call (not before the setup calls).
    function _shieldLocal(address integrator, bytes memory expectedRevert) internal {
        usdc.mint(shielder, AMOUNT);
        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: bytes32(uint256(1234)),
                token: TokenData({tokenType: TokenType.ERC20, tokenAddress: address(usdc), tokenSubID: 0}),
                value: AMOUNT
            }),
            ciphertext: _ciphertext()
        });
        vm.startPrank(shielder);
        usdc.approve(address(pool), AMOUNT);
        if (expectedRevert.length > 0) vm.expectRevert(expectedRevert);
        pool.shield(requests, integrator);
        vm.stopPrank();
    }

    /// @dev Cross-chain shield-in of AMOUNT USDC: CCTP has already minted it to the pool, and this
    ///      test (the configured hook router) delivers the burn message. A non-empty
    ///      `expectedRevert` is armed immediately before the delivery.
    function _shieldIn(address integrator, bytes memory expectedRevert) internal {
        usdc.mint(address(pool), AMOUNT);
        ShieldData[] memory notes = new ShieldData[](1);
        notes[0] = ShieldData({
            npk: bytes32(uint256(1234)),
            value: AMOUNT,
            encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
            shieldKey: bytes32(0),
            integrator: integrator
        });
        bytes memory body = BurnMessageV2.encode(
            MessageV2.addressToBytes32(address(usdc)),
            MessageV2.addressToBytes32(address(pool)),
            AMOUNT,
            CLIENT_POOL,
            0, // maxFee
            0, // feeExecuted
            0, // expirationBlock
            CCTPPayloadLib.encodeShield(notes)
        );
        if (expectedRevert.length > 0) vm.expectRevert(expectedRevert);
        pool.handleReceiveFinalizedMessage(CLIENT_DOMAIN, bytes32(0), 2000, body);
    }

    function _shield(bool inbound, address integrator, bytes memory expectedRevert) internal {
        if (inbound) _shieldIn(integrator, expectedRevert);
        else _shieldLocal(integrator, expectedRevert);
    }

    // ── inconsistent split ──────────────────────────────────────────────────

    /// @notice WHY: the pool deducts `totalFee` from the note but pays `armadaTake` and
    ///         `integratorFee` separately. On a shield-in it pays them from its own balance, so a
    ///         module reporting a zero total but a large integrator fee would hand other users'
    ///         USDC to the integrator. The pool must reject the split before paying anything.
    function test_shieldIn_rejectsPartsExceedingTotal() public {
        feeModule.setSplit(0, 500_000e6, 0);
        _shieldIn(INTEGRATOR, bytes("ShieldModule: inconsistent fee split"));
        assertEq(usdc.balanceOf(INTEGRATOR), 0);
    }

    /// @notice WHY: same split on a local shield. There the parts are pulled from the shielder's
    ///         allowance, so a bad module could take more than the fee it reports.
    function test_localShield_rejectsPartsExceedingTotal() public {
        feeModule.setSplit(0, 100e6, 0);
        _shieldLocal(INTEGRATOR, bytes("ShieldModule: inconsistent fee split"));
    }

    /// @notice WHY: the opposite mismatch (parts below the total) deducts fee from the note that
    ///         nobody receives, silently burning the user's value into pool surplus.
    function test_rejectsTotalExceedingParts() public {
        feeModule.setSplit(1e6, 0, 5e6);
        _shieldIn(address(0), bytes("ShieldModule: inconsistent fee split"));
        _shieldLocal(address(0), bytes("ShieldModule: inconsistent fee split"));
    }

    /// @notice WHY: any split whose parts don't sum to the total is rejected on both paths,
    ///         not just the hand-picked cases above.
    function testFuzz_rejectsAnyInconsistentSplit(uint96 take, uint96 integratorFee, uint96 total, bool inbound) public {
        vm.assume(uint256(take) + uint256(integratorFee) != uint256(total));
        feeModule.setSplit(take, integratorFee, total);
        _shield(inbound, INTEGRATOR, bytes("ShieldModule: inconsistent fee split"));
    }

    // ── integrator fee without an integrator ────────────────────────────────

    /// @notice WHY: with no integrator named, the pool skips the integrator payout, so a non-zero
    ///         integrator fee would be deducted from the note and paid to nobody.
    function test_rejectsIntegratorFeeWithoutIntegrator() public {
        feeModule.setSplit(0, 10e6, 10e6);
        _shieldIn(address(0), bytes("ShieldModule: integrator fee without integrator"));
        _shieldLocal(address(0), bytes("ShieldModule: integrator fee without integrator"));
    }

    // ── cap ─────────────────────────────────────────────────────────────────

    /// @notice WHY: a consistent split can still overcharge the shielder. The pool caps the
    ///         fee-module total at 15% of the shield (the shipped module's worst case: 10% take
    ///         plus a 5% integrator fee), so a replaced or upgraded module can't take more.
    function test_rejectsTotalAboveCap() public {
        uint256 total = (uint256(AMOUNT) * CAP_BPS) / 10000 + 1;
        feeModule.setSplit(total, 0, total);
        _shieldIn(address(0), bytes("ShieldModule: fee module fee too high"));
        _shieldLocal(address(0), bytes("ShieldModule: fee module fee too high"));
    }

    /// @notice WHY: a split exactly at the cap is legitimate and must still go through, paying
    ///         each party exactly its share and leaving other users' funds untouched.
    function test_acceptsSplitAtCap() public {
        uint256 total = (uint256(AMOUNT) * CAP_BPS) / 10000;
        uint256 take = (uint256(AMOUNT) * 1000) / 10000;
        feeModule.setSplit(take, total - take, total);

        _shieldIn(INTEGRATOR, "");
        assertEq(usdc.balanceOf(TREASURY), take);
        assertEq(usdc.balanceOf(INTEGRATOR), total - take);
        assertEq(usdc.balanceOf(address(pool)), OTHER_USERS_USDC + AMOUNT - total);

        _shieldLocal(INTEGRATOR, "");
        assertEq(usdc.balanceOf(TREASURY), 2 * take);
        assertEq(usdc.balanceOf(INTEGRATOR), 2 * (total - take));
        assertEq(usdc.balanceOf(address(pool)), OTHER_USERS_USDC + 2 * (AMOUNT - total));
    }

    // ── real fee module ─────────────────────────────────────────────────────

    /// @notice WHY: the guard must never reject the shipped ArmadaFeeModule. At its highest
    ///         settings (10% take, a registered integrator at the 5% maximum) its split is
    ///         consistent and exactly at the cap, on both shield paths.
    function test_realFeeModuleAtMaximumSettingsPasses() public {
        ArmadaFeeModule impl = new ArmadaFeeModule();
        ArmadaFeeModule real = ArmadaFeeModule(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                ArmadaFeeModule.initialize,
                (address(this), TREASURY, address(pool), address(0x7A11), address(usdc))
            )
        )));
        real.setBaseArmadaTake(real.MAX_BPS());
        uint256 maxIntegratorFee = real.MAX_INTEGRATOR_FEE_BPS();
        vm.prank(INTEGRATOR);
        real.setIntegratorFee(maxIntegratorFee);
        pool.setFeeModule(address(real));

        uint256 total = (uint256(AMOUNT) * CAP_BPS) / 10000;
        _shieldIn(INTEGRATOR, "");
        _shieldLocal(INTEGRATOR, "");
        assertEq(usdc.balanceOf(TREASURY) + usdc.balanceOf(INTEGRATOR), 2 * total);
    }
}
