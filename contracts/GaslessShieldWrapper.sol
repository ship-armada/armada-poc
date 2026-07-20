// SPDX-License-Identifier: MIT
// ABOUTME: Hub-chain permissionless gasless shield. User signs an EIP-2612 permit + an EIP-712
// ABOUTME: ShieldIntent; any relayer submits and is paid via a shielded fee note inside the pool.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IPrivacyPool} from "./privacy-pool/interfaces/IPrivacyPool.sol";
import {ShieldRequest, CommitmentPreimage, TokenType} from "./railgun/logic/Globals.sol";

/**
 * @title GaslessShieldWrapper
 * @notice Hub-chain gasless shield via EIP-2612 permit. The user signs an off-chain permit and an
 *         EIP-712 `ShieldIntent`; any relayer submits this call and pays gas in ETH. The wrapper
 *         shields the signed `ShieldRequest[]` into the privacy pool — the array carries both the
 *         user's own note and a fee note addressed to the relayer's shielded (`0zk`) address, so the
 *         relayer is paid an in-pool shielded UTXO rather than public USDC.
 *
 * Companion: `GaslessShieldWrapperClient.sol` for the cross-chain shield path.
 *
 * Trust model (permissionless):
 *   - The user signs an EIP-712 `ShieldIntent` binding `keccak256(abi.encode(shieldRequests))` (the
 *     full note array — user note AND relayer fee note), the `integrator`, the `deadline`, and a
 *     per-user `nonce`, scoped to this wrapper + chainId via the EIP-712 domain. The wrapper verifies
 *     the signature on-chain and shields exactly the signed array. A front-runner therefore cannot
 *     substitute a different recipient npk, inflate the fee note, or redirect the integrator — the
 *     hash would not match. Submission is open to anyone; there is no `onlyRelayer` gate and no
 *     privileged relayer address on this contract. The fee recipient is per-transaction signed data.
 *   - The permit binds the spender to this wrapper, the amount to the summed note values, and adds a
 *     deadline; ERC20Permit's nonce protects the permit against replay, and the wrapper's own
 *     `nonces` mapping protects the intent against replay.
 *   - `SignatureChecker` accepts both EOA (ecrecover) and EIP-1271 (smart-account) intent signatures.
 *     Note: the EIP-2612 permit leg is ecrecover-only in real USDC, so full smart-account gasless
 *     shield remains gated by the permit path, not by this contract.
 */
contract GaslessShieldWrapper is EIP712 {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice USDC token (with EIP-2612 permit support).
    address public immutable usdc;
    /// @notice PrivacyPool contract this wrapper shields into.
    address public immutable privacyPool;

    /// @notice Per-user replay nonce for the EIP-712 ShieldIntent. Independent of the ERC20Permit nonce.
    mapping(address => uint256) public nonces;

    /// @notice EIP-712 typehash for the intent the user signs alongside the permit.
    /// @dev `requestsHash` is `keccak256(abi.encode(shieldRequests))` — binds every note (user note +
    ///      relayer fee note) so the submitter cannot alter any recipient, value, or ciphertext.
    bytes32 public constant SHIELD_INTENT_TYPEHASH = keccak256(
        "ShieldIntent(address user,bytes32 requestsHash,address integrator,uint256 deadline,uint256 nonce)"
    );

    // ══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Scalar params grouped to keep the entry point's stack shallow (stack-too-deep without
    ///      via-ir). `intentSig` and `shieldRequests` stay as separate calldata args.
    struct ShieldIntentParams {
        address user; // permit signer + intent signer + USDC source
        uint256 deadline; // shared permit + intent deadline
        uint256 nonce; // must equal nonces[user]
        address integrator; // pool fee-split integrator (address(0) for none); applies to whole array
        uint8 permitV; // EIP-2612 permit signature component
        bytes32 permitR; // EIP-2612 permit signature component
        bytes32 permitS; // EIP-2612 permit signature component
    }

    // ══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @dev `requestsHash` is `keccak256(abi.encode(shieldRequests))` — the same digest the user signed
     *      in the ShieldIntent. Lets any watcher confirm off-chain that the submitted array matched the
     *      user's intent. `totalAmount` is the sum of all note values pulled from the user.
     */
    event GaslessShield(
        address indexed user,
        bytes32 requestsHash,
        uint256 totalAmount,
        uint256 nonce
    );

    // ══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════════════

    constructor(address _usdc, address _privacyPool) EIP712("ArmadaGaslessShield", "1") {
        require(_usdc != address(0), "GaslessShieldWrapper: zero usdc");
        require(_privacyPool != address(0), "GaslessShieldWrapper: zero privacyPool");
        usdc = _usdc;
        privacyPool = _privacyPool;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GASLESS SHIELD
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Atomically verify intent + permit + shield. The whole sequence reverts or commits
     *         together — there is no "funds pulled but shield failed" path.
     * @param params Scalar intent + permit-signature params (see `ShieldIntentParams`).
     * @param intentSig EIP-712 ShieldIntent signature (EOA or EIP-1271) over `params` + `requestsHash`.
     * @param shieldRequests The notes to shield: the user's own note plus a fee note to the relayer's
     *        npk. Every note must be USDC/ERC20 with a non-zero value. Their values sum to the amount
     *        pulled from the user via the permit.
     */
    function gaslessShield(
        ShieldIntentParams calldata params,
        bytes calldata intentSig,
        ShieldRequest[] calldata shieldRequests
    ) external {
        require(block.timestamp <= params.deadline, "GaslessShieldWrapper: expired");
        require(params.nonce == nonces[params.user], "GaslessShieldWrapper: bad nonce");

        // Verify the intent binds exactly this array + integrator + deadline + nonce for this user.
        bytes32 requestsHash = keccak256(abi.encode(shieldRequests));
        _verifyIntent(params, requestsHash, intentSig);

        // Effects: consume the nonce before any external call (checks-effects-interactions).
        nonces[params.user] = params.nonce + 1;

        // Validate every note is USDC/ERC20 and sum the total the wrapper must pull from the user.
        uint256 totalAmount = _validateAndSum(shieldRequests);

        // ATOMIC permit → pull → approve → shield (see `_permitPullApproveShield`).
        _permitPullApproveShield(params, totalAmount, shieldRequests);

        emit GaslessShield(params.user, requestsHash, totalAmount, params.nonce);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Recompute the EIP-712 digest and require a valid EOA/EIP-1271 signature from `user`.
    function _verifyIntent(
        ShieldIntentParams calldata params,
        bytes32 requestsHash,
        bytes calldata intentSig
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                SHIELD_INTENT_TYPEHASH,
                params.user,
                requestsHash,
                params.integrator,
                params.deadline,
                params.nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        require(
            SignatureChecker.isValidSignatureNow(params.user, digest, intentSig),
            "GaslessShieldWrapper: bad intent sig"
        );
    }

    /// @dev Require every note is USDC/ERC20 with a non-zero value and return the summed amount the
    ///      wrapper must pull from the user (gross of the pool's per-note shield fee).
    function _validateAndSum(ShieldRequest[] calldata shieldRequests)
        internal
        view
        returns (uint256 totalAmount)
    {
        uint256 numRequests = shieldRequests.length;
        require(numRequests > 0, "GaslessShieldWrapper: no requests");
        for (uint256 i = 0; i < numRequests; i++) {
            CommitmentPreimage calldata p = shieldRequests[i].preimage;
            require(p.token.tokenAddress == usdc, "GaslessShieldWrapper: token mismatch");
            require(p.token.tokenType == TokenType.ERC20, "GaslessShieldWrapper: not ERC20");
            require(p.value > 0, "GaslessShieldWrapper: zero note");
            totalAmount += p.value;
        }
    }

    /// @dev The atomic money-movement leg. The wrapper holds no inter-call state, so do not introduce
    ///      intermediate storage writes here — doing so would break the "no funds pulled without
    ///      shield" guarantee documented in the contract header.
    function _permitPullApproveShield(
        ShieldIntentParams calldata params,
        uint256 totalAmount,
        ShieldRequest[] calldata shieldRequests
    ) internal {
        // 1. Permit gives the wrapper `totalAmount` allowance from `user`.
        IERC20Permit(usdc).permit(
            params.user, address(this), totalAmount, params.deadline, params.permitV, params.permitR, params.permitS
        );
        // 2. Pull the full amount (all note values, gross of the pool's shield fee) into the wrapper.
        IERC20(usdc).safeTransferFrom(params.user, address(this), totalAmount);
        // 3. Approve the pool to pull from the wrapper. safeApprove(0, amount) is defensive against
        //    tokens that revert on non-zero→non-zero.
        IERC20(usdc).safeApprove(privacyPool, 0);
        IERC20(usdc).safeApprove(privacyPool, totalAmount);
        // 4. Shield. The pool nullifies the wrapper's USDC and creates one commitment per request —
        //    the user's own note plus the relayer's fee note (each fee-adjusted by the pool).
        IPrivacyPool(privacyPool).shield(shieldRequests, params.integrator);
    }
}
