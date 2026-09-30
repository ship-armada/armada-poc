// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for the permissionless GaslessShieldWrapperClient — EIP-712 intent binding
// ABOUTME: of both notes + CCTP params, two-note cross-chain shield, replay, and front-run resistance.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";

import {GaslessShieldWrapperClient} from "../../contracts/GaslessShieldWrapperClient.sol";
import {MockUSDCV2} from "../../contracts/cctp/MockUSDCV2.sol";
import {ShieldData} from "../../contracts/privacy-pool/types/CCTPTypes.sol";

/// @dev Minimal PrivacyPoolClient stub. Records crossChainShieldWithFee args and pulls the summed
/// burn amount from the caller (the wrapper) via transferFrom — mirroring the real client. Returns a
/// deterministic CCTP nonce so the test can assert flow-through.
contract MockPrivacyPoolClient {
    address public usdc;
    uint64 public stubNonce = 42;

    uint256 public lastTotal;
    uint256 public lastMaxFee;
    uint32 public lastMinFinalityThreshold;
    bytes32 public lastUserNpk;
    uint256 public lastUserValue;
    bytes32 public lastFeeNpk;
    uint256 public lastFeeValue;
    uint256 public callCount;

    constructor(address _usdc) {
        usdc = _usdc;
    }

    function crossChainShieldWithFee(
        uint256 maxFee,
        uint32 minFinalityThreshold,
        ShieldData calldata userNote,
        ShieldData calldata feeNote
    ) external returns (uint64) {
        uint256 total = uint256(userNote.value) + uint256(feeNote.value);
        (bool ok, ) = usdc.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), total)
        );
        require(ok, "MockClient: transferFrom failed");
        lastTotal = total;
        lastMaxFee = maxFee;
        lastMinFinalityThreshold = minFinalityThreshold;
        lastUserNpk = userNote.npk;
        lastUserValue = userNote.value;
        lastFeeNpk = feeNote.npk;
        lastFeeValue = feeNote.value;
        callCount++;
        return stubNonce;
    }
}

contract GaslessShieldWrapperClientTest is Test {
    // Mirror of the wrapper's event — see GaslessShieldWrapper.t.sol for the 0.8.17 rationale.
    event GaslessShield(
        address indexed user,
        uint256 totalAmount,
        uint256 feeValue,
        uint64 cctpNonce,
        bytes32 notesHash
    );

    MockUSDCV2 internal usdc;
    MockPrivacyPoolClient internal client;
    GaslessShieldWrapperClient internal wrapper;

    address internal relayer = makeAddr("relayer");
    address internal frontrunner = makeAddr("frontrunner");
    address internal integrator = makeAddr("integrator");

    uint256 internal userPk = 0xBEEF;
    address internal user;

    bytes32 internal constant USER_NPK = bytes32(uint256(0xBEEF));
    bytes32 internal constant RELAYER_NPK = bytes32(uint256(0xF33));

    uint256 internal constant ONE_USDC = 1_000_000;
    uint256 internal constant MAX_FEE = 1000;
    uint32 internal constant FINALITY = 1000;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        usdc = new MockUSDCV2("USD Coin", "USDC");
        client = new MockPrivacyPoolClient(address(usdc));
        wrapper = new GaslessShieldWrapperClient(address(usdc), address(client));
        user = vm.addr(userPk);
        usdc.mint(user, 100 * ONE_USDC);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Signing helpers
    // ══════════════════════════════════════════════════════════════════════════

    function _signPermit(uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 domainSeparator = usdc.DOMAIN_SEPARATOR();
        bytes32 PERMIT_TYPEHASH =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, user, address(wrapper), value, usdc.nonces(user), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (v, r, s) = vm.sign(userPk, digest);
    }

    function _wrapperDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("ArmadaGaslessCrossChainShield")),
                keccak256(bytes("1")),
                block.chainid,
                address(wrapper)
            )
        );
    }

    function _signIntent(
        ShieldData memory userNote,
        ShieldData memory feeNote,
        uint256 maxFee,
        uint32 minFinality,
        uint256 deadline,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                wrapper.CROSS_CHAIN_SHIELD_INTENT_TYPEHASH(),
                user,
                keccak256(abi.encode(userNote)),
                keccak256(abi.encode(feeNote)),
                maxFee,
                minFinality,
                deadline,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _wrapperDomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _params(uint256 deadline, uint256 nonce, uint256 maxFee, uint32 minFinality, uint256 total)
        internal
        view
        returns (GaslessShieldWrapperClient.CrossChainIntentParams memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        return GaslessShieldWrapperClient.CrossChainIntentParams({
            user: user,
            deadline: deadline,
            nonce: nonce,
            maxFee: maxFee,
            minFinalityThreshold: minFinality,
            permitV: v,
            permitR: r,
            permitS: s
        });
    }

    function _note(bytes32 npk, uint256 value) internal pure returns (ShieldData memory) {
        return ShieldData({
            npk: npk,
            value: uint120(value),
            encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
            shieldKey: bytes32(0),
            integrator: address(0)
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Happy path
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessCrossChainShield_happyPath() public {
        // WHY: pin the load-bearing path — a valid permit + intent burns the summed amount and passes
        // BOTH notes (user + relayer fee) through to the client, returns the client's nonce, and
        // leaves no dust. Submitted by an arbitrary caller (permissionless).
        uint256 shieldAmount = 9 * ONE_USDC + ONE_USDC / 2;
        uint256 fee = ONE_USDC / 2;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldData memory userNote = _note(USER_NPK, shieldAmount);
        ShieldData memory feeNote = _note(RELAYER_NPK, fee);
        bytes memory intentSig = _signIntent(userNote, feeNote, MAX_FEE, FINALITY, deadline, 0);
        GaslessShieldWrapperClient.CrossChainIntentParams memory p =
            _params(deadline, 0, MAX_FEE, FINALITY, total);

        vm.prank(frontrunner);
        uint64 nonce = wrapper.gaslessCrossChainShield(p, intentSig, userNote, feeNote);

        assertEq(nonce, 42, "returned client nonce");
        assertEq(usdc.balanceOf(address(client)), total, "client got full burn amount");
        assertEq(usdc.balanceOf(user), 100 * ONE_USDC - total, "user debited total");
        assertEq(usdc.balanceOf(address(wrapper)), 0, "no dust in wrapper");
        assertEq(client.callCount(), 1);
        assertEq(client.lastUserValue(), shieldAmount, "user note value");
        assertEq(client.lastFeeValue(), fee, "fee note value");
        assertEq(client.lastFeeNpk(), RELAYER_NPK, "fee note to relayer npk");
        assertEq(client.lastMaxFee(), MAX_FEE);
        assertEq(wrapper.nonces(user), 1, "nonce consumed");
    }

    function test_gaslessCrossChainShield_eventEmitsNotesHash() public {
        // WHY: symmetric with the hub wrapper. The event surfaces keccak256(abi.encode(userNote,
        // feeNote)) so a watcher can verify the burn honored the signed cross-chain intent.
        uint256 shieldAmount = 6 * ONE_USDC;
        uint256 fee = ONE_USDC / 2;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldData memory userNote = _note(USER_NPK, shieldAmount);
        ShieldData memory feeNote = _note(RELAYER_NPK, fee);
        bytes memory intentSig = _signIntent(userNote, feeNote, MAX_FEE, FINALITY, deadline, 0);
        GaslessShieldWrapperClient.CrossChainIntentParams memory p =
            _params(deadline, 0, MAX_FEE, FINALITY, total);
        bytes32 expectedHash = keccak256(abi.encode(userNote, feeNote));

        vm.expectEmit(true, false, false, true, address(wrapper));
        emit GaslessShield(user, total, fee, client.stubNonce(), expectedHash);

        vm.prank(relayer);
        wrapper.gaslessCrossChainShield(p, intentSig, userNote, feeNote);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Front-run resistance
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessCrossChainShield_substitutedUserNpkReverts() public {
        // WHY: a front-runner swapping the user note's npk for their own must be rejected — the
        // intent binds keccak256(abi.encode(userNote)). This is the cross-chain analog of the hub
        // wrapper's core theft-resistance test.
        uint256 shieldAmount = 4 * ONE_USDC;
        uint256 fee = ONE_USDC;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldData memory userNote = _note(USER_NPK, shieldAmount);
        ShieldData memory feeNote = _note(RELAYER_NPK, fee);
        bytes memory intentSig = _signIntent(userNote, feeNote, MAX_FEE, FINALITY, deadline, 0);
        GaslessShieldWrapperClient.CrossChainIntentParams memory p =
            _params(deadline, 0, MAX_FEE, FINALITY, total);

        ShieldData memory tampered = _note(bytes32(uint256(0xA77ACC)), shieldAmount);

        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapperClient: bad intent sig");
        wrapper.gaslessCrossChainShield(p, intentSig, tampered, feeNote);
    }

    function test_gaslessCrossChainShield_substitutedMaxFeeReverts() public {
        // WHY: the CCTP maxFee is bound in the intent (it's deducted from the user's bridged amount).
        // A submitter inflating maxFee to grief the user must be rejected by the signature check.
        uint256 shieldAmount = 4 * ONE_USDC;
        uint256 fee = ONE_USDC;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldData memory userNote = _note(USER_NPK, shieldAmount);
        ShieldData memory feeNote = _note(RELAYER_NPK, fee);
        bytes memory intentSig = _signIntent(userNote, feeNote, MAX_FEE, FINALITY, deadline, 0);
        // Submitter tries a larger maxFee than signed.
        GaslessShieldWrapperClient.CrossChainIntentParams memory p =
            _params(deadline, 0, MAX_FEE * 100, FINALITY, total);

        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapperClient: bad intent sig");
        wrapper.gaslessCrossChainShield(p, intentSig, userNote, feeNote);
    }

    function test_gaslessCrossChainShield_maxFeeExceedingUserNoteReverts() public {
        // WHY (C-1): the recipient note (index 0) absorbs the CCTP fee on the Hub, which enforces
        // userNote.value > feeExecuted. Because feeExecuted <= maxFee, a maxFee >= userNote.value is
        // an undeliverable configuration — the Hub reverts `received > feeSum` after the Client burn
        // already completed, permanently stranding the funds. The wrapper must reject it before
        // permit/pull/burn. maxFee (2 USDC) is >= userNote.value (1 USDC) but < total (4 USDC): the
        // exact gap the old `maxFee < total` bound permitted. Signed with the same over-large maxFee
        // so the intent check passes and the dedicated bound is what trips.
        uint256 shieldAmount = ONE_USDC;
        uint256 fee = 3 * ONE_USDC;
        uint256 total = shieldAmount + fee;
        uint256 maxFee = 2 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldData memory userNote = _note(USER_NPK, shieldAmount);
        ShieldData memory feeNote = _note(RELAYER_NPK, fee);
        bytes memory intentSig = _signIntent(userNote, feeNote, maxFee, FINALITY, deadline, 0);
        GaslessShieldWrapperClient.CrossChainIntentParams memory p =
            _params(deadline, 0, maxFee, FINALITY, total);

        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapperClient: maxFee >= user note");
        wrapper.gaslessCrossChainShield(p, intentSig, userNote, feeNote);
    }

    function test_gaslessCrossChainShield_permissionlessResubmitSucceeds() public {
        // WHY: anyone MAY submit the unmodified signed bundle; the fee still lands to the relayer npk.
        uint256 shieldAmount = 4 * ONE_USDC;
        uint256 fee = ONE_USDC;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldData memory userNote = _note(USER_NPK, shieldAmount);
        ShieldData memory feeNote = _note(RELAYER_NPK, fee);
        bytes memory intentSig = _signIntent(userNote, feeNote, MAX_FEE, FINALITY, deadline, 0);
        GaslessShieldWrapperClient.CrossChainIntentParams memory p =
            _params(deadline, 0, MAX_FEE, FINALITY, total);

        vm.prank(makeAddr("randomSubmitter"));
        wrapper.gaslessCrossChainShield(p, intentSig, userNote, feeNote);

        assertEq(client.lastFeeNpk(), RELAYER_NPK);
        assertEq(usdc.balanceOf(address(client)), total);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Replay / deadline / validation
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessCrossChainShield_nonceReplayReverts() public {
        uint256 total = 3 * ONE_USDC + ONE_USDC / 2;
        uint256 deadline = block.timestamp + 1 hours;
        ShieldData memory userNote = _note(USER_NPK, 3 * ONE_USDC);
        ShieldData memory feeNote = _note(RELAYER_NPK, ONE_USDC / 2);
        bytes memory intentSig = _signIntent(userNote, feeNote, MAX_FEE, FINALITY, deadline, 0);

        // Precompute both params structs — `_params` makes an external usdc.nonces() call that would
        // otherwise be captured by vm.expectRevert on the second invocation.
        GaslessShieldWrapperClient.CrossChainIntentParams memory p1 =
            _params(deadline, 0, MAX_FEE, FINALITY, total);

        vm.prank(relayer);
        wrapper.gaslessCrossChainShield(p1, intentSig, userNote, feeNote);

        GaslessShieldWrapperClient.CrossChainIntentParams memory p2 =
            _params(deadline, 0, MAX_FEE, FINALITY, total);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapperClient: bad nonce");
        wrapper.gaslessCrossChainShield(p2, intentSig, userNote, feeNote);
    }

    function test_gaslessCrossChainShield_expiredDeadlineReverts() public {
        uint256 total = 2 * ONE_USDC + ONE_USDC / 4;
        uint256 deadline = block.timestamp + 1 hours;
        ShieldData memory userNote = _note(USER_NPK, 2 * ONE_USDC);
        ShieldData memory feeNote = _note(RELAYER_NPK, ONE_USDC / 4);
        bytes memory intentSig = _signIntent(userNote, feeNote, MAX_FEE, FINALITY, deadline, 0);
        GaslessShieldWrapperClient.CrossChainIntentParams memory p =
            _params(deadline, 0, MAX_FEE, FINALITY, total);

        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapperClient: expired");
        wrapper.gaslessCrossChainShield(p, intentSig, userNote, feeNote);
    }

    function test_gaslessCrossChainShield_zeroFeeNoteReverts() public {
        uint256 total = 3 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        ShieldData memory userNote = _note(USER_NPK, 3 * ONE_USDC);
        ShieldData memory feeNote = _note(RELAYER_NPK, 0);
        bytes memory intentSig = _signIntent(userNote, feeNote, MAX_FEE, FINALITY, deadline, 0);
        GaslessShieldWrapperClient.CrossChainIntentParams memory p =
            _params(deadline, 0, MAX_FEE, FINALITY, total);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapperClient: zero fee note");
        wrapper.gaslessCrossChainShield(p, intentSig, userNote, feeNote);
    }

    function testFuzz_gaslessCrossChainShield_noDust(uint96 shield_, uint96 fee_) public {
        uint256 shieldAmount = uint256(shield_);
        uint256 fee = uint256(fee_);
        vm.assume(shieldAmount > 0 && fee > 0);
        uint256 total = shieldAmount + fee;
        vm.assume(total <= 100 * ONE_USDC);
        // C-1: the Client requires maxFee (= MAX_FEE here) < userNote.value, so the recipient note must
        // exceed the fee ceiling for a deliverable burn. Keep the fuzzed inputs in that valid domain
        // (this subsumes total > MAX_FEE, since shieldAmount is part of total).
        vm.assume(shieldAmount > MAX_FEE);
        uint256 deadline = block.timestamp + 1 hours;

        ShieldData memory userNote = _note(USER_NPK, shieldAmount);
        ShieldData memory feeNote = _note(RELAYER_NPK, fee);
        bytes memory intentSig = _signIntent(userNote, feeNote, MAX_FEE, FINALITY, deadline, 0);
        GaslessShieldWrapperClient.CrossChainIntentParams memory p =
            _params(deadline, 0, MAX_FEE, FINALITY, total);

        uint256 userBefore = usdc.balanceOf(user);

        vm.prank(relayer);
        wrapper.gaslessCrossChainShield(p, intentSig, userNote, feeNote);

        assertEq(usdc.balanceOf(address(client)), total, "client total");
        assertEq(usdc.balanceOf(user), userBefore - total, "user debited");
        assertEq(usdc.balanceOf(address(wrapper)), 0, "no dust");
    }
}
