// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import {IPrivacyPool} from "./privacy-pool/interfaces/IPrivacyPool.sol";
import {ShieldRequest, TokenType} from "./railgun/logic/Globals.sol";

/**
 * @title GaslessShieldWrapper
 * @notice Hub-chain gasless shield via EIP-2612 permit. The user signs an off-chain permit;
 *         the relayer submits this call and pays gas in ETH. The wrapper sends `fee` USDC to
 *         the relayer and shields `(totalAmount - fee)` USDC into the privacy pool as a single
 *         shielded UTXO to the user's npk.
 *
 * Phase B1 of the relayer-mediation plan (see `.claude/RELAYER_MEDIATION_PLAN.md`).
 * Companion: `GaslessShieldWrapperClient.sol` for the cross-chain shield path.
 *
 * Trust model:
 *   - `onlyRelayer` gates `gaslessShield(...)` so a leaked permit signature can't be replayed
 *     by a front-runner with a different recipient `npk`. The user therefore implicitly trusts
 *     the relayer to honor the requested ShieldRequest. A stronger mainnet-grade model would
 *     bind permit + ShieldRequest + relayer to EIP-712 typed data the user signs, gated at the
 *     contract; tracked as future work in the plan doc.
 *   - The permit itself binds the spender to this wrapper, the amount to `totalAmount`, and
 *     adds a deadline. ERC20Permit's nonce protects against replay.
 *   - Owner can rotate the `relayer` address (key rotation) and transfer ownership.
 */
contract GaslessShieldWrapper {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice USDC token (with EIP-2612 permit support).
    address public immutable usdc;
    /// @notice PrivacyPool contract this wrapper shields into.
    address public immutable privacyPool;

    /// @notice Address allowed to call `gaslessShield`. Rotatable by owner.
    address public relayer;
    /// @notice Owner; can rotate the relayer + transfer ownership.
    address public owner;

    // ══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @dev `shieldRequestHash` is `keccak256(abi.encode(shieldRequest))`. Lets the user (or any
     *      watcher) verify off-chain that the relayer called the wrapper with exactly the
     *      `ShieldRequest` the user signed against — recompute the hash from the request handed
     *      to the relayer and check for equality. Raw `npk` is not surfaced because the pool's
     *      own `Shield` event already publishes the full preimage in the same tx; adding a
     *      digest here provides the integrity primitive without making `npk` a first-class
     *      indexed query surface on the wrapper.
     */
    event GaslessShield(
        address indexed user,
        uint256 shieldAmount,
        uint256 fee,
        bytes32 shieldRequestHash
    );
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ══════════════════════════════════════════════════════════════════════════

    modifier onlyOwner() {
        require(msg.sender == owner, "GaslessShieldWrapper: not owner");
        _;
    }

    modifier onlyRelayer() {
        require(msg.sender == relayer, "GaslessShieldWrapper: not relayer");
        _;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════════════

    constructor(address _usdc, address _privacyPool, address _relayer) {
        require(_usdc != address(0), "GaslessShieldWrapper: zero usdc");
        require(_privacyPool != address(0), "GaslessShieldWrapper: zero privacyPool");
        require(_relayer != address(0), "GaslessShieldWrapper: zero relayer");
        usdc = _usdc;
        privacyPool = _privacyPool;
        relayer = _relayer;
        owner = msg.sender;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════════════════════════════

    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "GaslessShieldWrapper: zero relayer");
        address old = relayer;
        relayer = newRelayer;
        emit RelayerUpdated(old, newRelayer);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "GaslessShieldWrapper: zero owner");
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GASLESS SHIELD
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Atomically permit + fee transfer + shield. The whole sequence reverts or commits
     *         together — there is no "fee paid but shield failed" path.
     * @param user The shielded balance owner (permit signer + USDC source).
     * @param totalAmount Total USDC the wrapper is authorised to pull from `user` (= shield + fee).
     * @param fee USDC sent to the relayer as gas reimbursement. Must satisfy `fee < totalAmount`.
     * @param deadline EIP-2612 permit deadline (`block.timestamp` must be <= this).
     * @param v EIP-2612 permit signature component.
     * @param r EIP-2612 permit signature component.
     * @param s EIP-2612 permit signature component.
     * @param shieldRequest The ShieldRequest the user wants the pool to commit. Must have
     *        `preimage.value == totalAmount - fee` and `preimage.token.tokenAddress == usdc`.
     * @param integrator Integrator address for the pool's fee split (or address(0) for none).
     */
    function gaslessShield(
        address user,
        uint256 totalAmount,
        uint256 fee,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        ShieldRequest calldata shieldRequest,
        address integrator
    ) external onlyRelayer {
        // ATOMIC: every step below must succeed together or the whole tx reverts. The wrapper
        // holds no inter-call state, so do not introduce intermediate storage writes between
        // permit / transfers / approve / shield — doing so would break the "no fee paid without
        // shield" guarantee documented in the contract header.
        require(totalAmount > 0, "GaslessShieldWrapper: zero amount");
        require(fee < totalAmount, "GaslessShieldWrapper: fee >= amount");
        uint256 shieldAmount = totalAmount - fee;

        // Pin the ShieldRequest to the math the wrapper is about to execute.
        require(
            shieldRequest.preimage.value == shieldAmount,
            "GaslessShieldWrapper: value mismatch"
        );
        require(
            shieldRequest.preimage.token.tokenAddress == usdc,
            "GaslessShieldWrapper: token mismatch"
        );
        require(
            shieldRequest.preimage.token.tokenType == TokenType.ERC20,
            "GaslessShieldWrapper: not ERC20"
        );

        // 1. Permit — gives wrapper `totalAmount` allowance from `user`. Nonces protect against
        //    replay; deadline protects against stale signatures sitting in the mempool.
        IERC20Permit(usdc).permit(user, address(this), totalAmount, deadline, v, r, s);

        // 2. Pay relayer fee (skipped when fee == 0 — defensive; the relayer can choose to
        //    sponsor in some flows).
        if (fee > 0) {
            IERC20(usdc).safeTransferFrom(user, relayer, fee);
        }

        // 3. Pull the shield amount into the wrapper.
        IERC20(usdc).safeTransferFrom(user, address(this), shieldAmount);

        // 4. Approve the pool to pull from the wrapper. Same safeApprove(0, amount) pattern as
        //    PrivacyPoolClient — defensive against tokens that revert on non-zero→non-zero.
        IERC20(usdc).safeApprove(privacyPool, 0);
        IERC20(usdc).safeApprove(privacyPool, shieldAmount);

        // 5. Shield. The pool atomically nullifies the wrapper's USDC and creates the commitment
        //    bound to `user`'s `npk` (encoded inside `shieldRequest.preimage`).
        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = shieldRequest;
        IPrivacyPool(privacyPool).shield(requests, integrator);

        emit GaslessShield(user, shieldAmount, fee, keccak256(abi.encode(shieldRequest)));
    }
}
