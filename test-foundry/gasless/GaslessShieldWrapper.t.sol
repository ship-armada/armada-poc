// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for the permissionless GaslessShieldWrapper — EIP-712 intent binding,
// ABOUTME: two-note (user + relayer fee) shield, nonce replay, deadline, and front-run resistance.
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

/// @dev Minimal PrivacyPool stub. Implements the `shield` entry the wrapper calls, pulling the sum of
/// all note values from the caller (the wrapper) via transferFrom — mirroring the real pool's pull
/// pattern — and recording per-note values/npks so tests can assert the two-note split.
contract MockPrivacyPool {
    address public usdc;
    address public lastIntegrator;
    uint256 public shieldCallCount;
    uint256 public lastNoteCount;
    uint256[] public lastValues;
    bytes32[] public lastNpks;

    constructor(address _usdc) {
        usdc = _usdc;
    }

    function shield(ShieldRequest[] calldata requests, address integrator) external {
        delete lastValues;
        delete lastNpks;
        uint256 total;
        for (uint256 i = 0; i < requests.length; i++) {
            ShieldRequest calldata r = requests[i];
            total += r.preimage.value;
            lastValues.push(r.preimage.value);
            lastNpks.push(r.preimage.npk);
        }
        // Pull the aggregate value via the wrapper's allowance — same as the real pool's path.
        (bool ok, ) = usdc.call(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)",
                msg.sender,
                address(this),
                total
            )
        );
        require(ok, "Mock: transferFrom failed");
        lastIntegrator = integrator;
        lastNoteCount = requests.length;
        shieldCallCount++;
    }
}

contract GaslessShieldWrapperTest is Test {
    // Mirror of the wrapper's event so vm.expectEmit can match — Solidity 0.8.17 doesn't resolve
    // event references via ContractName.EventName, so the test contract redeclares it.
    event GaslessShield(
        address indexed user,
        bytes32 requestsHash,
        uint256 totalAmount,
        uint256 nonce
    );

    MockUSDCV2 internal usdc;
    MockPrivacyPool internal pool;
    GaslessShieldWrapper internal wrapper;

    address internal relayer = makeAddr("relayer");
    address internal frontrunner = makeAddr("frontrunner");
    address internal integrator = makeAddr("integrator");

    // User signing keypair — Foundry's vm.sign needs the raw private key.
    uint256 internal userPk = 0xA11CE;
    address internal user;

    // Recipient npks — user's own note vs the relayer's fee note.
    bytes32 internal constant USER_NPK = bytes32(uint256(0xBEEF));
    bytes32 internal constant RELAYER_NPK = bytes32(uint256(0xF33));

    uint256 internal constant ONE_USDC = 1_000_000;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        usdc = new MockUSDCV2("USD Coin", "USDC");
        pool = new MockPrivacyPool(address(usdc));
        wrapper = new GaslessShieldWrapper(address(usdc), address(pool));
        user = vm.addr(userPk);
        usdc.mint(user, 100 * ONE_USDC);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Signing helpers
    // ══════════════════════════════════════════════════════════════════════════

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
        (v, r, s) = vm.sign(userPk, _permitDigest(value, deadline, nonce));
    }

    /// @dev Reconstruct the wrapper's EIP-712 domain separator (name/version pinned in the contract).
    function _wrapperDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("ArmadaGaslessShield")),
                keccak256(bytes("1")),
                block.chainid,
                address(wrapper)
            )
        );
    }

    function _signIntent(
        ShieldRequest[] memory requests,
        address integrator_,
        uint256 deadline,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 requestsHash = keccak256(abi.encode(requests));
        bytes32 structHash = keccak256(
            abi.encode(
                wrapper.SHIELD_INTENT_TYPEHASH(),
                user,
                requestsHash,
                integrator_,
                deadline,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _wrapperDomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Build the wrapper's grouped scalar params for the given permit signature.
    function _params(
        uint256 deadline,
        uint256 nonce,
        address integrator_,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal view returns (GaslessShieldWrapper.ShieldIntentParams memory) {
        return GaslessShieldWrapper.ShieldIntentParams({
            user: user,
            deadline: deadline,
            nonce: nonce,
            integrator: integrator_,
            permitV: v,
            permitR: r,
            permitS: s
        });
    }

    function _note(bytes32 npk, uint256 value) internal view returns (ShieldRequest memory) {
        return ShieldRequest({
            preimage: CommitmentPreimage({
                npk: npk,
                token: TokenData({tokenType: TokenType.ERC20, tokenAddress: address(usdc), tokenSubID: 0}),
                value: uint120(value)
            }),
            ciphertext: ShieldCiphertext({
                encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
                shieldKey: bytes32(0)
            })
        });
    }

    /// @dev The canonical two-note array: user's own note + a fee note to the relayer's npk.
    function _twoNotes(uint256 shieldAmount, uint256 fee)
        internal
        view
        returns (ShieldRequest[] memory reqs)
    {
        reqs = new ShieldRequest[](2);
        reqs[0] = _note(USER_NPK, shieldAmount);
        reqs[1] = _note(RELAYER_NPK, fee);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Happy path
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_happyPath() public {
        // WHY: pin the load-bearing behaviour — a valid permit + intent shields BOTH notes (user note
        // + relayer fee note) into the pool and pulls exactly the summed amount from the user. A
        // regression that dropped the fee note, mis-summed, or left dust would show here.
        uint256 shieldAmount = 9 * ONE_USDC + ONE_USDC / 2;
        uint256 fee = ONE_USDC / 2;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldRequest[] memory reqs = _twoNotes(shieldAmount, fee);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);

        // Submitted by an arbitrary caller (not a privileged relayer) — permissionless.
        vm.prank(frontrunner);
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);

        assertEq(usdc.balanceOf(address(pool)), total, "pool got both notes' value");
        assertEq(usdc.balanceOf(user), 100 * ONE_USDC - total, "user debited total");
        assertEq(usdc.balanceOf(address(wrapper)), 0, "no dust in wrapper");
        assertEq(pool.shieldCallCount(), 1);
        assertEq(pool.lastNoteCount(), 2, "two notes shielded");
        assertEq(pool.lastValues(0), shieldAmount, "user note value");
        assertEq(pool.lastValues(1), fee, "relayer fee note value");
        assertEq(pool.lastNpks(1), RELAYER_NPK, "fee note addressed to relayer npk");
        assertEq(pool.lastIntegrator(), integrator);
        assertEq(wrapper.nonces(user), 1, "nonce consumed");
    }

    function test_gaslessShield_eventEmitsRequestsHash() public {
        // WHY: the GaslessShield event surfaces keccak256(abi.encode(shieldRequests)) — the same digest
        // the user signed. A refactor that hashed a different shape would break the off-chain
        // verification primitive silently. Pin the exact hash against a known input.
        uint256 shieldAmount = 6 * ONE_USDC;
        uint256 fee = ONE_USDC;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;
        ShieldRequest[] memory reqs = _twoNotes(shieldAmount, fee);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);
        bytes32 expectedHash = keccak256(abi.encode(reqs));

        vm.expectEmit(true, false, false, true, address(wrapper));
        emit GaslessShield(user, expectedHash, total, 0);

        vm.prank(relayer);
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Front-run resistance (the load-bearing security property)
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_substitutedUserNpkReverts() public {
        // WHY: THE attack the intent binding defeats. A front-runner observes the signed bundle and
        // swaps the user's note npk for their OWN, trying to redirect the shielded funds. Because the
        // intent signs keccak256(abi.encode(shieldRequests)), the mutated array no longer matches the
        // signature and the wrapper rejects it. Without this binding, gasless shield would be theft-prone.
        uint256 shieldAmount = 4 * ONE_USDC;
        uint256 fee = ONE_USDC;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldRequest[] memory signed = _twoNotes(shieldAmount, fee);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        bytes memory intentSig = _signIntent(signed, integrator, deadline, 0);

        // Attacker mutates the user note's npk to their own, keeping the signature.
        ShieldRequest[] memory tampered = _twoNotes(shieldAmount, fee);
        tampered[0].preimage.npk = bytes32(uint256(0xA77ACC));

        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapper: bad intent sig");
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, tampered);
    }

    function test_gaslessShield_inflatedFeeNoteReverts() public {
        // WHY: a front-runner (or greedy relayer) tries to enlarge the fee note beyond what the user
        // signed. The array hash changes, so the intent signature no longer validates. This is what
        // caps the fee at exactly the user-signed amount without an explicit maxFee.
        uint256 shieldAmount = 4 * ONE_USDC;
        uint256 fee = ONE_USDC;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldRequest[] memory signed = _twoNotes(shieldAmount, fee);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        bytes memory intentSig = _signIntent(signed, integrator, deadline, 0);

        ShieldRequest[] memory tampered = _twoNotes(shieldAmount, fee * 3);

        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapper: bad intent sig");
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, tampered);
    }

    function test_gaslessShield_substitutedIntegratorReverts() public {
        // WHY: the integrator is bound in the intent (it drives the pool's fee split). A submitter
        // swapping in their own integrator to skim a split must be rejected by the signature check.
        uint256 shieldAmount = 4 * ONE_USDC;
        uint256 fee = ONE_USDC;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldRequest[] memory reqs = _twoNotes(shieldAmount, fee);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);

        vm.prank(frontrunner);
        vm.expectRevert("GaslessShieldWrapper: bad intent sig");
        wrapper.gaslessShield(
            _params(deadline, 0, makeAddr("evilIntegrator"), v, r, s), intentSig, reqs
        );
    }

    function test_gaslessShield_permissionlessResubmitSucceeds() public {
        // WHY: the flip side of front-run resistance — anyone MAY submit the UNMODIFIED signed bundle
        // and it executes correctly, paying the intended relayer npk. This is what makes the feature
        // permissionless (no onlyRelayer) while remaining safe: there is nothing to gain by front-
        // running except paying gas for the user's own intended action.
        uint256 shieldAmount = 4 * ONE_USDC;
        uint256 fee = ONE_USDC;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldRequest[] memory reqs = _twoNotes(shieldAmount, fee);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);

        vm.prank(makeAddr("randomSubmitter"));
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);

        assertEq(pool.lastNpks(1), RELAYER_NPK, "fee still goes to intended relayer npk");
        assertEq(usdc.balanceOf(address(pool)), total);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Replay / deadline
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_nonceReplayReverts() public {
        // WHY: the wrapper's own nonce protects the intent against replay independently of the permit
        // nonce. After a successful call nonces[user] increments; re-submitting the same intent (nonce
        // 0) must fail on the nonce check before touching the permit.
        uint256 shieldAmount = 3 * ONE_USDC;
        uint256 fee = ONE_USDC / 2;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldRequest[] memory reqs = _twoNotes(shieldAmount, fee);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);

        vm.prank(relayer);
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: bad nonce");
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);
    }

    function test_gaslessShield_wrongNonceReverts() public {
        // WHY: a submitter cannot skip ahead or reuse a stale nonce — the intent nonce must equal the
        // current on-chain value exactly.
        uint256 shieldAmount = 3 * ONE_USDC;
        uint256 fee = ONE_USDC / 2;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldRequest[] memory reqs = _twoNotes(shieldAmount, fee);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 5);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: bad nonce");
        wrapper.gaslessShield(_params(deadline, 5, integrator, v, r, s), intentSig, reqs);
    }

    function test_gaslessShield_expiredDeadlineReverts() public {
        // WHY: a stale signed bundle sitting in the mempool must be void after its deadline — the
        // wrapper checks the deadline before doing any work.
        uint256 shieldAmount = 2 * ONE_USDC;
        uint256 fee = ONE_USDC / 4;
        uint256 total = shieldAmount + fee;
        uint256 deadline = block.timestamp + 1 hours;

        ShieldRequest[] memory reqs = _twoNotes(shieldAmount, fee);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);

        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: expired");
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Note validation
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_zeroValueNoteReverts() public {
        // WHY: a zero-value note would mint a junk commitment; the shield path also rejects it, but
        // catching it in the wrapper gives a clear error and avoids a wasted downstream call.
        uint256 deadline = block.timestamp + 1 hours;
        ShieldRequest[] memory reqs = _twoNotes(3 * ONE_USDC, 0); // fee note has zero value
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(3 * ONE_USDC, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: zero note");
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);
    }

    function test_gaslessShield_mismatchedTokenReverts() public {
        // WHY: the wrapper only supports USDC. A note claiming a different tokenAddress must be
        // rejected — otherwise the permit/pull math (denominated in USDC) is meaningless.
        uint256 deadline = block.timestamp + 1 hours;
        ShieldRequest[] memory reqs = _twoNotes(3 * ONE_USDC, ONE_USDC);
        reqs[1].preimage.token.tokenAddress = address(0xDEADBEEF);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(4 * ONE_USDC, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: token mismatch");
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);
    }

    function test_gaslessShield_nonERC20Reverts() public {
        // WHY: defense in depth — the pool routes non-ERC20 token types differently; the wrapper's
        // USDC accounting doesn't apply to them.
        uint256 deadline = block.timestamp + 1 hours;
        ShieldRequest[] memory reqs = _twoNotes(3 * ONE_USDC, ONE_USDC);
        reqs[0].preimage.token.tokenType = TokenType.ERC721;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(4 * ONE_USDC, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);

        vm.prank(relayer);
        vm.expectRevert("GaslessShieldWrapper: not ERC20");
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Single-note (fee-sponsored) and fuzz
    // ══════════════════════════════════════════════════════════════════════════

    function test_gaslessShield_singleNoteNoFee() public {
        // WHY: a relayer may sponsor gas (no fee note) — a one-element array must still shield
        // correctly. Confirms the loop/sum handles the no-fee case without a hardcoded length.
        uint256 shieldAmount = 5 * ONE_USDC;
        uint256 deadline = block.timestamp + 1 hours;
        ShieldRequest[] memory reqs = new ShieldRequest[](1);
        reqs[0] = _note(USER_NPK, shieldAmount);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(shieldAmount, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);

        vm.prank(relayer);
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);

        assertEq(usdc.balanceOf(address(pool)), shieldAmount, "full amount shielded");
        assertEq(pool.lastNoteCount(), 1);
    }

    function testFuzz_gaslessShield_noDustAcrossSplit(uint96 shield_, uint96 fee_) public {
        // WHY: brute-check the value-conservation invariant across the (shieldAmount, fee) plane —
        // after a successful call the pool holds exactly shield+fee, the user is debited exactly
        // shield+fee, and no USDC is stranded in the wrapper.
        uint256 shieldAmount = uint256(shield_);
        uint256 fee = uint256(fee_);
        vm.assume(shieldAmount > 0 && fee > 0);
        uint256 total = shieldAmount + fee;
        vm.assume(total <= 100 * ONE_USDC);
        uint256 deadline = block.timestamp + 1 hours;

        ShieldRequest[] memory reqs = _twoNotes(shieldAmount, fee);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, deadline);
        bytes memory intentSig = _signIntent(reqs, integrator, deadline, 0);

        uint256 userBefore = usdc.balanceOf(user);

        vm.prank(relayer);
        wrapper.gaslessShield(_params(deadline, 0, integrator, v, r, s), intentSig, reqs);

        assertEq(usdc.balanceOf(address(pool)), total, "pool total");
        assertEq(usdc.balanceOf(user), userBefore - total, "user debited");
        assertEq(usdc.balanceOf(address(wrapper)), 0, "no dust");
    }
}
