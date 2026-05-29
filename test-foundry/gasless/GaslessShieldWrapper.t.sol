// SPDX-License-Identifier: MIT
// ABOUTME: Foundry fuzz/property tests for GaslessShieldWrapper — permit replay, deadline
// ABOUTME: expiry, allowance race, onlyRelayer gate, fee bounds, and ShieldRequest binding.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";

import {GaslessShieldWrapper} from "../../contracts/GaslessShieldWrapper.sol";
import {MockUSDCV2} from "../../contracts/cctp/MockUSDCV2.sol";
import {
    ShieldRequest,
    CommitmentPreimage,
    TokenData,
    TokenType,
    ShieldCiphertext
} from "../../contracts/railgun/logic/Globals.sol";
import {IPrivacyPool} from "../../contracts/privacy-pool/interfaces/IPrivacyPool.sol";

/// @dev Minimal PrivacyPool stub. Only implements the `shield` entry the wrapper calls and
/// pulls USDC from the caller via transferFrom to validate the wrapper's approval pattern.
contract MockPrivacyPool {
    address public usdc;
    address public lastIntegrator;
    uint256 public lastShieldValue;
    address public lastShieldToken;
    uint256 public shieldCallCount;

    constructor(address _usdc) {
        usdc = _usdc;
    }

    function shield(ShieldRequest[] calldata requests, address integrator) external {
        require(requests.length == 1, "Mock: one request only");
        ShieldRequest calldata r = requests[0];
        // Pull the value via the wrapper's allowance — same as the real pool's path.
        (bool ok, ) = usdc.call(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)",
                msg.sender,
                address(this),
                r.preimage.value
            )
        );
        require(ok, "Mock: transferFrom failed");
        lastIntegrator = integrator;
        lastShieldValue = r.preimage.value;
        lastShieldToken = r.preimage.token.tokenAddress;
        shieldCallCount++;
    }
}

contract GaslessShieldWrapperTest is Test {
    MockUSDCV2 internal usdc;
    MockPrivacyPool internal pool;
    GaslessShieldWrapper internal wrapper;

    address internal owner = address(this);
    address internal relayer = makeAddr("relayer");
    address internal frontrunner = makeAddr("frontrunner");
    address internal integrator = makeAddr("integrator");

    // User signing keypair — Foundry's vm.sign needs the raw private key.
    uint256 internal userPk = 0xA11CE;
    address internal user;

    uint256 internal constant ONE_USDC = 1_000_000;

    function setUp() public {
        usdc = new MockUSDCV2("USD Coin", "USDC");
        pool = new MockPrivacyPool(address(usdc));
        wrapper = new GaslessShieldWrapper(address(usdc), address(pool), relayer);
        user = vm.addr(userPk);
        // Fund the user; production USDC mint is permissioned (faucet/minter), but the mock
        // grants the deployer minting rights, which is `address(this)` here.
        usdc.mint(user, 100 * ONE_USDC);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Permit signing helpers
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Build the EIP-2612 digest for a permit(owner=user, spender=wrapper, value, nonce, deadline).
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

    function _shieldRequest(uint256 value) internal view returns (ShieldRequest memory) {
        return ShieldRequest({
            preimage: CommitmentPreimage({
                npk: bytes32(uint256(0xBEEF)),
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: address(usdc),
                    tokenSubID: 0
                }),
                value: uint120(value)
            }),
            ciphertext: ShieldCiphertext({
                encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
                shieldKey: bytes32(0)
            })
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Happy path
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_happyPath() public {
        // WHY: pin the load-bearing contract — relayer calls with valid permit + ShieldRequest,
        // wrapper splits funds correctly and the pool sees the right value. A regression that
        // mis-ordered the splits (e.g. paying the pool before transferring the fee) would show
        // up as a wrong final balance on either the relayer or the pool.
        uint256 totalAmount = 10 * ONE_USDC;
        uint256 fee = ONE_USDC / 2; // 0.5 USDC
        uint256 shieldAmount = totalAmount - fee;
        uint256 deadline = block.timestamp + 1 hours;

        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        vm.prank(relayer);
        wrapper.gaslessShield(
            user, totalAmount, fee, deadline, v, r, s, _shieldRequest(shieldAmount), integrator
        );

        assertEq(usdc.balanceOf(relayer), fee, "relayer got fee");
        assertEq(usdc.balanceOf(address(pool)), shieldAmount, "pool got shield amount");
        assertEq(usdc.balanceOf(user), 100 * ONE_USDC - totalAmount, "user debited totalAmount");
        assertEq(pool.shieldCallCount(), 1);
        assertEq(pool.lastShieldValue(), shieldAmount);
        assertEq(pool.lastIntegrator(), integrator);
    }

    function test_gaslessShield_zeroFeeSkipsTransfer() public {
        // WHY: relayer can choose to sponsor in some flows. A regression that did
        // `transferFrom(user, relayer, 0)` would still work on most ERC20s but would emit a
        // misleading Transfer(0) event and waste gas. Pin the skip semantically.
        uint256 totalAmount = 5 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        vm.prank(relayer);
        wrapper.gaslessShield(
            user, totalAmount, 0, deadline, v, r, s, _shieldRequest(totalAmount), integrator
        );

        assertEq(usdc.balanceOf(relayer), 0, "no fee transferred");
        assertEq(usdc.balanceOf(address(pool)), totalAmount, "full amount shielded");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Permit replay
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_permitReplayReverts() public {
        // WHY: a replayed permit signature should fail because ERC20Permit increments the user's
        // nonce on every successful permit. If a regression broke nonce handling — e.g. we
        // started signing without including the nonce — the same signature would be accepted
        // twice and the wrapper would drain the user's balance.
        uint256 totalAmount = 3 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        vm.prank(relayer);
        wrapper.gaslessShield(
            user, totalAmount, 0, deadline, v, r, s, _shieldRequest(totalAmount), integrator
        );

        // Re-using the same signature must fail — nonce has incremented.
        vm.prank(relayer);
        vm.expectRevert();
        wrapper.gaslessShield(
            user, totalAmount, 0, deadline, v, r, s, _shieldRequest(totalAmount), integrator
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Deadline expiry
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_expiredDeadlineReverts() public {
        // WHY: a permit signature with `deadline = T` is meant to be void after `block.timestamp
        // > T`. Otherwise a leaked permit from months ago could be replayed against a different
        // ShieldRequest (the only thing the user signed is the permit; the ShieldRequest is the
        // relayer's choice within the onlyRelayer trust model). Time-bounding is a defense in
        // depth.
        uint256 totalAmount = 2 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert();
        wrapper.gaslessShield(
            user, totalAmount, 0, deadline, v, r, s, _shieldRequest(totalAmount), integrator
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // onlyRelayer gate
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_frontrunnerCannotCall() public {
        // WHY: the load-bearing security gate. A leaked permit + leaked ShieldRequest would let
        // any caller front-run the relayer to send the shielded UTXO to their OWN npk. The
        // onlyRelayer modifier defeats this. Removing it would silently re-introduce the attack.
        uint256 totalAmount = 4 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapper: not relayer");
        wrapper.gaslessShield(
            user, totalAmount, 0, deadline, v, r, s, _shieldRequest(totalAmount), integrator
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Allowance race
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_thirdPartyPermitDoesNotEnableFreeShield() public {
        // WHY: a permit, by EIP-2612, can be relayed by ANYONE — the permit() call itself isn't
        // gated. A third-party (front-runner) could pre-call usdc.permit() with the user's
        // signature, then attempt to call gaslessShield with no ETH cost. The onlyRelayer modifier
        // STILL has to gate the wrapper — otherwise a permit observed in the mempool gives a
        // free shield to attacker's npk. This test exercises the failure mode end-to-end.
        uint256 totalAmount = 3 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        // Third-party publishes the permit on its own (this consumes the user's nonce).
        vm.prank(frontrunner);
        usdc.permit(user, address(wrapper), totalAmount, deadline, v, r, s);

        // Wrapper still rejects when the front-runner tries to follow through with gaslessShield.
        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapper: not relayer");
        wrapper.gaslessShield(
            user, totalAmount, 0, deadline, v, r, s, _shieldRequest(totalAmount), integrator
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Fee bounds
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_feeEqualsTotalReverts() public {
        // WHY: fee == totalAmount means shieldAmount == 0, which would mint a zero-value
        // commitment (pollutes the user's wallet with junk UTXOs at best, undefined at worst).
        // Pin the strict-less-than check.
        uint256 totalAmount = 2 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: fee >= amount");
        wrapper.gaslessShield(
            user, totalAmount, totalAmount, deadline, v, r, s, _shieldRequest(0), integrator
        );
    }

    function test_gaslessShield_feeExceedsTotalReverts() public {
        uint256 totalAmount = 2 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: fee >= amount");
        wrapper.gaslessShield(
            user, totalAmount, totalAmount + 1, deadline, v, r, s, _shieldRequest(0), integrator
        );
    }

    function test_gaslessShield_zeroTotalReverts() public {
        // WHY: defensive — a zero-totalAmount call would have a valid permit (zero permit is
        // allowed by EIP-2612) but would silently no-op the shield. Reject explicitly.
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(0, deadline);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: zero amount");
        wrapper.gaslessShield(
            user, 0, 0, deadline, v, r, s, _shieldRequest(0), integrator
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ShieldRequest binding
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_mismatchedValueReverts() public {
        // WHY: the wrapper computes `shieldAmount = totalAmount - fee` and bakes that into the
        // pool's commitment. If the ShieldRequest's preimage.value disagreed with our math,
        // the pool would mint a different value than the wrapper's transfer pulls in,
        // leaving USDC stranded in the wrapper. Pin the equality check.
        uint256 totalAmount = 5 * ONE_USDC;
        uint256 fee = ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        // ShieldRequest says we're minting 99 USDC, but we're only authorizing 4.
        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: value mismatch");
        wrapper.gaslessShield(
            user,
            totalAmount,
            fee,
            deadline,
            v,
            r,
            s,
            _shieldRequest(99 * ONE_USDC),
            integrator
        );
    }

    function test_gaslessShield_mismatchedTokenReverts() public {
        // WHY: defense in depth — the wrapper only supports USDC. A ShieldRequest claiming a
        // different tokenAddress must be rejected explicitly rather than silently producing
        // a commitment the user doesn't own (the SDK's downstream nullifier wouldn't match).
        uint256 totalAmount = 5 * ONE_USDC;
        uint256 fee = 0;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        ShieldRequest memory bad = _shieldRequest(totalAmount);
        bad.preimage.token.tokenAddress = address(0xDEADBEEF);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: token mismatch");
        wrapper.gaslessShield(user, totalAmount, fee, deadline, v, r, s, bad, integrator);
    }

    function test_gaslessShield_nonERC20TokenTypeReverts() public {
        // WHY: same rationale as token mismatch — defense in depth. The pool's shield path
        // routes NFTs differently; the wrapper's USDC math doesn't make sense for them.
        uint256 totalAmount = 5 * ONE_USDC;
        uint256 fee = 0;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(totalAmount, deadline);

        ShieldRequest memory bad = _shieldRequest(totalAmount);
        bad.preimage.token.tokenType = TokenType.ERC721;

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: not ERC20");
        wrapper.gaslessShield(user, totalAmount, fee, deadline, v, r, s, bad, integrator);
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
        vm.expectRevert("GaslessShieldWrapper: not owner");
        wrapper.setRelayer(frontrunner);
    }

    function test_setRelayer_zeroReverts() public {
        vm.expectRevert("GaslessShieldWrapper: zero relayer");
        wrapper.setRelayer(address(0));
    }

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");
        wrapper.transferOwnership(newOwner);
        assertEq(wrapper.owner(), newOwner);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Fuzz — happy path remains valid across the allowed fee range
    // ══════════════════════════════════════════════════════════════════════════

    function testFuzz_gaslessShield_feeWithinBounds(uint96 fee_, uint96 total_) public {
        // WHY: brute-check the value-split invariant across the entire (fee, total) plane the
        // contract allows. After a successful call, relayer balance + pool balance + user
        // remainder must reconstruct the user's pre-call balance exactly — no USDC left in
        // the wrapper.
        uint256 total = uint256(total_);
        uint256 fee = uint256(fee_);
        vm.assume(total > 0 && total <= 100 * ONE_USDC);
        vm.assume(fee < total);
        uint256 shieldAmount = total - fee;

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);

        uint256 userBefore = usdc.balanceOf(user);

        vm.prank(relayer);
        wrapper.gaslessShield(
            user, total, fee, deadline, v, r, s, _shieldRequest(shieldAmount), integrator
        );

        assertEq(usdc.balanceOf(relayer), fee, "relayer fee");
        assertEq(usdc.balanceOf(address(pool)), shieldAmount, "pool shieldAmount");
        assertEq(usdc.balanceOf(user), userBefore - total, "user remainder");
        assertEq(usdc.balanceOf(address(wrapper)), 0, "no dust in wrapper");
    }
}
