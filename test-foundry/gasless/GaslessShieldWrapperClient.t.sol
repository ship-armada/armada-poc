// SPDX-License-Identifier: MIT
// ABOUTME: Foundry fuzz/property tests for GaslessShieldWrapperClient — same property set as
// ABOUTME: the hub wrapper plus maxFee bound interaction with the cross-chain shield path.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";

import {GaslessShieldWrapperClient} from "../../contracts/GaslessShieldWrapperClient.sol";
import {MockUSDCV2} from "../../contracts/cctp/MockUSDCV2.sol";
import {IPrivacyPoolClient} from "../../contracts/privacy-pool/interfaces/IPrivacyPoolClient.sol";

/// @dev Minimal PrivacyPoolClient stub. Records crossChainShield args and pulls the burn amount
/// from the caller (the wrapper) via transferFrom — same as the real client's path. Returns a
/// deterministic CCTP nonce so the test can assert flow-through.
contract MockPrivacyPoolClient {
    address public usdc;
    uint64 public stubNonce = 42;

    uint256 public lastAmount;
    uint256 public lastMaxFee;
    uint32 public lastMinFinalityThreshold;
    bytes32 public lastNpk;
    bytes32 public lastShieldKey;
    address public lastIntegrator;
    uint256 public callCount;

    constructor(address _usdc) {
        usdc = _usdc;
    }

    function crossChainShield(
        uint256 amount,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes32 npk,
        bytes32[3] calldata /* encryptedBundle */,
        bytes32 shieldKey,
        address integrator
    ) external returns (uint64) {
        // Mirror the real client: pull amount from msg.sender (the wrapper).
        (bool ok, ) = usdc.call(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)",
                msg.sender,
                address(this),
                amount
            )
        );
        require(ok, "MockClient: transferFrom failed");
        lastAmount = amount;
        lastMaxFee = maxFee;
        lastMinFinalityThreshold = minFinalityThreshold;
        lastNpk = npk;
        lastShieldKey = shieldKey;
        lastIntegrator = integrator;
        callCount++;
        return stubNonce;
    }
}

contract GaslessShieldWrapperClientTest is Test {
    // Mirror of the wrapper's event — see GaslessShieldWrapper.t.sol for the 0.8.17 rationale.
    event GaslessShield(
        address indexed user,
        uint256 shieldAmount,
        uint256 fee,
        uint64 cctpNonce,
        bytes32 destHash
    );

    MockUSDCV2 internal usdc;
    MockPrivacyPoolClient internal client;
    GaslessShieldWrapperClient internal wrapper;

    address internal owner = address(this);
    address internal relayer = makeAddr("relayer");
    address internal frontrunner = makeAddr("frontrunner");
    address internal integrator = makeAddr("integrator");

    uint256 internal userPk = 0xBEEF;
    address internal user;

    uint256 internal constant ONE_USDC = 1_000_000;

    function setUp() public {
        usdc = new MockUSDCV2("USD Coin", "USDC");
        client = new MockPrivacyPoolClient(address(usdc));
        wrapper = new GaslessShieldWrapperClient(address(usdc), address(client), relayer);
        user = vm.addr(userPk);
        usdc.mint(user, 100 * ONE_USDC);
    }

    function _permitDigest(uint256 value, uint256 deadline, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSeparator = usdc.DOMAIN_SEPARATOR();
        bytes32 PERMIT_TYPEHASH =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, user, address(wrapper), value, nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _signPermit(uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        uint256 nonce = usdc.nonces(user);
        bytes32 digest = _permitDigest(value, deadline, nonce);
        (v, r, s) = vm.sign(userPk, digest);
    }

    function _permitInput(uint256 totalAmount, uint256 fee, uint256 deadline)
        internal
        view
        returns (GaslessShieldWrapperClient.PermitInput memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);
        return GaslessShieldWrapperClient.PermitInput({
            user: user,
            totalAmount: totalAmount,
            fee: fee,
            deadline: deadline,
            v: v,
            r: r,
            s: s
        });
    }

    function _destDefaults() internal view returns (GaslessShieldWrapperClient.CrossChainParams memory) {
        return GaslessShieldWrapperClient.CrossChainParams({
            maxFee: 1000,
            minFinalityThreshold: 1000,
            npk: bytes32(uint256(0xBEEF)),
            encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
            shieldKey: bytes32(0),
            integrator: integrator
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Happy path
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessCrossChainShield_happyPath() public {
        // WHY: pin the load-bearing happy path — relayer's call splits funds correctly, the
        // mock client gets the right burn amount and forwarded CCTP args, and the wrapper
        // returns the client's nonce.
        uint256 totalAmount = 10 * ONE_USDC;
        uint256 fee = ONE_USDC / 2;
        uint256 deadline = block.timestamp + 1 hours;
        // Compute permit args BEFORE the prank — `_permitInput` reads USDC.nonces() which is an
        // external call that would consume vm.prank's one-shot effect, leaving msg.sender as
        // address(this) when the wrapper call lands.
        GaslessShieldWrapperClient.PermitInput memory p = _permitInput(totalAmount, fee, deadline);
        GaslessShieldWrapperClient.CrossChainParams memory d = _destDefaults();

        vm.prank(relayer);
        uint64 nonce = wrapper.gaslessCrossChainShield(p, d);

        assertEq(nonce, 42, "returned client nonce");
        assertEq(usdc.balanceOf(relayer), fee);
        assertEq(usdc.balanceOf(address(client)), totalAmount - fee);
        assertEq(usdc.balanceOf(user), 100 * ONE_USDC - totalAmount);
        assertEq(client.callCount(), 1);
        assertEq(client.lastAmount(), totalAmount - fee);
        assertEq(client.lastMaxFee(), 1000);
        assertEq(client.lastIntegrator(), integrator);
    }

    function test_gaslessCrossChainShield_eventEmitsDestDigest() public {
        // WHY: symmetric with the hub wrapper's shieldRequestHash test. The event surfaces
        // keccak256(abi.encode(dest)) so the user can verify off-chain that the relayer honoured
        // the cross-chain destination they signed against (npk, ciphertext, finality, maxFee,
        // integrator, …). A refactor that changed the hash shape (e.g.
        // hashed individual fields, used encodePacked) would silently break that primitive.
        // Pin the exact digest shape.
        uint256 totalAmount = 6 * ONE_USDC;
        uint256 fee = ONE_USDC / 2;
        uint256 deadline = block.timestamp + 1 hours;
        GaslessShieldWrapperClient.PermitInput memory p = _permitInput(totalAmount, fee, deadline);
        GaslessShieldWrapperClient.CrossChainParams memory d = _destDefaults();
        bytes32 expectedHash = keccak256(abi.encode(d));

        vm.expectEmit(true, false, false, true, address(wrapper));
        emit GaslessShield(user, totalAmount - fee, fee, client.stubNonce(), expectedHash);

        vm.prank(relayer);
        wrapper.gaslessCrossChainShield(p, d);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Permit replay / deadline / onlyRelayer — symmetric coverage with hub wrapper
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessCrossChainShield_permitReplayReverts() public {
        uint256 totalAmount = 3 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        GaslessShieldWrapperClient.PermitInput memory p = _permitInput(totalAmount, 0, deadline);

        vm.prank(relayer);
        wrapper.gaslessCrossChainShield(p, _destDefaults());

        vm.prank(relayer);
        vm.expectRevert();
        wrapper.gaslessCrossChainShield(p, _destDefaults());
    }

    function test_gaslessCrossChainShield_expiredDeadlineReverts() public {
        uint256 totalAmount = 2 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        GaslessShieldWrapperClient.PermitInput memory p = _permitInput(totalAmount, 0, deadline);

        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert();
        wrapper.gaslessCrossChainShield(p, _destDefaults());
    }

    function test_gaslessCrossChainShield_frontrunnerCannotCall() public {
        uint256 totalAmount = 4 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        GaslessShieldWrapperClient.PermitInput memory p = _permitInput(totalAmount, 0, deadline);

        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapperClient: not relayer");
        wrapper.gaslessCrossChainShield(p, _destDefaults());
    }

    function test_gaslessCrossChainShield_thirdPartyPermitDoesNotEnableFreeShield() public {
        uint256 totalAmount = 3 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        GaslessShieldWrapperClient.PermitInput memory p = _permitInput(totalAmount, 0, deadline);

        vm.prank(frontrunner);
        usdc.permit(user, address(wrapper), totalAmount, deadline, p.v, p.r, p.s);

        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapperClient: not relayer");
        wrapper.gaslessCrossChainShield(p, _destDefaults());
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Fee bounds
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessCrossChainShield_feeEqualsTotalReverts() public {
        uint256 totalAmount = 2 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        GaslessShieldWrapperClient.PermitInput memory p =
            _permitInput(totalAmount, totalAmount, deadline);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapperClient: fee >= amount");
        wrapper.gaslessCrossChainShield(p, _destDefaults());
    }

    function test_gaslessCrossChainShield_zeroTotalReverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        GaslessShieldWrapperClient.PermitInput memory p = _permitInput(0, 0, deadline);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapperClient: zero amount");
        wrapper.gaslessCrossChainShield(p, _destDefaults());
    }

    // ══════════════════════════════════════════════════════════════════════════
    // maxFee bound interaction with the burn amount
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessCrossChainShield_maxFeeExceedsShieldAmountReverts() public {
        // WHY: PrivacyPoolClient enforces `maxFee < amount`. The wrapper pre-checks against the
        // POST-fee burn amount (totalAmount - fee), not the pre-fee total — otherwise a $5 burn
        // with a $4 maxFee plus a $0.50 broadcaster fee would silently slip through here and
        // revert downstream in the client, costing the relayer gas on a doomed tx. Pin the early
        // rejection so misbehaving fee inputs fail fast at this contract.
        uint256 totalAmount = 5 * ONE_USDC;
        uint256 fee = ONE_USDC; // shieldAmount = 4 USDC
        uint256 deadline = block.timestamp + 1 hours;
        GaslessShieldWrapperClient.PermitInput memory p = _permitInput(totalAmount, fee, deadline);

        GaslessShieldWrapperClient.CrossChainParams memory dest = _destDefaults();
        dest.maxFee = 4 * ONE_USDC; // == shieldAmount, must revert

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapperClient: maxFee >= shieldAmount");
        wrapper.gaslessCrossChainShield(p, dest);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Admin
    // ══════════════════════════════════════════════════════════════════════════

    function test_setRelayer_byOwner() public {
        address newRelayer = makeAddr("newRelayer");
        wrapper.setRelayer(newRelayer);
        assertEq(wrapper.relayer(), newRelayer);
    }

    function test_setRelayer_nonOwnerReverts() public {
        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapperClient: not owner");
        wrapper.setRelayer(frontrunner);
    }

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");
        wrapper.transferOwnership(newOwner);
        assertEq(wrapper.owner(), newOwner);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Fuzz — value-split invariant across the allowed (fee, total) plane
    // ══════════════════════════════════════════════════════════════════════════

    function testFuzz_gaslessCrossChainShield_feeWithinBounds(uint96 fee_, uint96 total_) public {
        uint256 total = uint256(total_);
        uint256 fee = uint256(fee_);
        vm.assume(total > 0 && total <= 100 * ONE_USDC);
        vm.assume(fee < total);
        uint256 shieldAmount = total - fee;
        vm.assume(shieldAmount > 1000); // keep maxFee=1000 valid

        uint256 deadline = block.timestamp + 1 hours;
        uint256 userBefore = usdc.balanceOf(user);
        GaslessShieldWrapperClient.PermitInput memory p = _permitInput(total, fee, deadline);
        GaslessShieldWrapperClient.CrossChainParams memory d = _destDefaults();

        vm.prank(relayer);
        wrapper.gaslessCrossChainShield(p, d);

        assertEq(usdc.balanceOf(relayer), fee, "relayer fee");
        assertEq(usdc.balanceOf(address(client)), shieldAmount, "client burn amount");
        assertEq(usdc.balanceOf(user), userBefore - total, "user remainder");
        assertEq(usdc.balanceOf(address(wrapper)), 0, "no dust in wrapper");
    }
}
