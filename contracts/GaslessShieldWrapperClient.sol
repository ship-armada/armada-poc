// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import {IPrivacyPoolClient} from "./privacy-pool/interfaces/IPrivacyPoolClient.sol";

/**
 * @title GaslessShieldWrapperClient
 * @notice Client-chain gasless cross-chain shield via EIP-2612 permit. Symmetric with
 *         `GaslessShieldWrapper` (hub) but routes through `PrivacyPoolClient.crossChainShield`
 *         instead of `PrivacyPool.shield` — the underlying CCTP burn happens here, the shielded
 *         commitment is created on the hub when the message is received + minted.
 *
 * Phase B1 of the relayer-mediation plan (see `.claude/RELAYER_MEDIATION_PLAN.md`).
 *
 * Trust model + admin pattern: identical to the hub wrapper. See `GaslessShieldWrapper.sol` for
 * the full rationale.
 */
contract GaslessShieldWrapperClient {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════════════════

    address public immutable usdc;
    address public immutable privacyPoolClient;

    address public relayer;
    address public owner;

    // ══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @dev `destHash` is `keccak256(abi.encode(dest))` — the digest of the `CrossChainParams`
     *      the wrapper executed. Lets the user verify off-chain that the relayer honored the
     *      cross-chain destination they signed against (npk, ciphertext, finality, maxFee,
     *      integrator, destinationCaller, …). Symmetric with the hub wrapper's
     *      `shieldRequestHash`.
     */
    event GaslessShield(
        address indexed user,
        uint256 shieldAmount,
        uint256 fee,
        uint64 cctpNonce,
        bytes32 destHash
    );
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ══════════════════════════════════════════════════════════════════════════

    modifier onlyOwner() {
        require(msg.sender == owner, "GaslessShieldWrapperClient: not owner");
        _;
    }

    modifier onlyRelayer() {
        require(msg.sender == relayer, "GaslessShieldWrapperClient: not relayer");
        _;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════════════

    constructor(address _usdc, address _privacyPoolClient, address _relayer) {
        require(_usdc != address(0), "GaslessShieldWrapperClient: zero usdc");
        require(
            _privacyPoolClient != address(0),
            "GaslessShieldWrapperClient: zero privacyPoolClient"
        );
        require(_relayer != address(0), "GaslessShieldWrapperClient: zero relayer");
        usdc = _usdc;
        privacyPoolClient = _privacyPoolClient;
        relayer = _relayer;
        owner = msg.sender;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════════════════════════════

    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "GaslessShieldWrapperClient: zero relayer");
        address old = relayer;
        relayer = newRelayer;
        emit RelayerUpdated(old, newRelayer);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "GaslessShieldWrapperClient: zero owner");
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev EIP-2612 permit components grouped to keep the entry point's stack shallow.
    struct PermitInput {
        address user;
        uint256 totalAmount;
        uint256 fee;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev CCTP V2 cross-chain shield destination args, grouped for stack-shallow reasons.
    struct CrossChainParams {
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes32 npk;
        bytes32[3] encryptedBundle;
        bytes32 shieldKey;
        bytes32 destinationCaller;
        address integrator;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GASLESS CROSS-CHAIN SHIELD
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Atomically permit + fee transfer + cross-chain shield. Returns the CCTP nonce.
     * @dev Permit + CCTP args grouped into structs to dodge stack-too-deep with the 14-arg
     *      flat signature. ABI-shape: the relayer encodes a `PermitInput` and `CrossChainParams`
     *      and forwards both — single calldata, same ergonomics as the hub wrapper from the
     *      relayer's POV.
     * @param permitInput Permit signer, totals, deadline, signature.
     * @param dest CCTP V2 burn args + hub recipient (npk + ciphertext + shieldKey).
     */
    function gaslessCrossChainShield(
        PermitInput calldata permitInput,
        CrossChainParams calldata dest
    ) external onlyRelayer returns (uint64 cctpNonce) {
        // ATOMIC: every step below must succeed together or the whole tx reverts. The wrapper
        // holds no inter-call state, so do not introduce intermediate storage writes between
        // permit / transfers / approve / crossChainShield — doing so would break the "no fee
        // paid without burn" guarantee documented in the contract header.
        require(permitInput.totalAmount > 0, "GaslessShieldWrapperClient: zero amount");
        require(
            permitInput.fee < permitInput.totalAmount,
            "GaslessShieldWrapperClient: fee >= amount"
        );
        uint256 shieldAmount = permitInput.totalAmount - permitInput.fee;
        // PrivacyPoolClient enforces `maxFee < amount`; pre-check so we don't burn gas on a
        // doomed-to-revert downstream call when the inputs are obviously inconsistent.
        require(dest.maxFee < shieldAmount, "GaslessShieldWrapperClient: maxFee >= shieldAmount");

        // 1. Permit. See GaslessShieldWrapper for the deadline + nonce rationale.
        IERC20Permit(usdc).permit(
            permitInput.user,
            address(this),
            permitInput.totalAmount,
            permitInput.deadline,
            permitInput.v,
            permitInput.r,
            permitInput.s
        );

        // 2. Relayer fee (skipped when zero, defensive).
        if (permitInput.fee > 0) {
            IERC20(usdc).safeTransferFrom(permitInput.user, relayer, permitInput.fee);
        }

        // 3. Pull burn amount into wrapper.
        IERC20(usdc).safeTransferFrom(permitInput.user, address(this), shieldAmount);

        // 4. Approve client to pull from wrapper (it will then approve TokenMessenger
        //    internally — same pattern PrivacyPoolClient uses for direct callers).
        IERC20(usdc).safeApprove(privacyPoolClient, 0);
        IERC20(usdc).safeApprove(privacyPoolClient, shieldAmount);

        // 5. Cross-chain shield. The client burns USDC via CCTP V2 and emits MessageSent.
        cctpNonce = IPrivacyPoolClient(privacyPoolClient).crossChainShield(
            shieldAmount,
            dest.maxFee,
            dest.minFinalityThreshold,
            dest.npk,
            dest.encryptedBundle,
            dest.shieldKey,
            dest.destinationCaller,
            dest.integrator
        );

        emit GaslessShield(
            permitInput.user,
            shieldAmount,
            permitInput.fee,
            cctpNonce,
            keccak256(abi.encode(dest))
        );
    }
}
