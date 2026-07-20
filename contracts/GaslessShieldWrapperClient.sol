// SPDX-License-Identifier: MIT
// ABOUTME: Client-chain permissionless gasless cross-chain shield. User signs an EIP-2612 permit +
// ABOUTME: EIP-712 intent; any relayer submits and is paid via a shielded fee note on the Hub.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IPrivacyPoolClient} from "./privacy-pool/interfaces/IPrivacyPoolClient.sol";
import {ShieldData} from "./privacy-pool/types/CCTPTypes.sol";

/**
 * @title GaslessShieldWrapperClient
 * @notice Client-chain permissionless gasless cross-chain shield via EIP-2612 permit. Symmetric with
 *         `GaslessShieldWrapper` (hub) but routes through `PrivacyPoolClient.crossChainShieldWithFee`
 *         — the CCTP burn happens here; both the user's commitment and the relayer's fee note are
 *         created on the Hub when the message is received + minted. The relayer is therefore paid an
 *         in-pool shielded note on the Hub (net of the Hub's shield fee), only once leg-2 delivery
 *         completes, rather than public USDC on the client.
 *
 * Trust model + rationale: identical to the hub wrapper (`GaslessShieldWrapper.sol`). The user signs
 * an EIP-712 `CrossChainShieldIntent` binding both notes (user + relayer fee), the CCTP `maxFee` and
 * finality, the `deadline`, and a per-user `nonce`, scoped to this wrapper + chainId. Submission is
 * permissionless; there is no `onlyRelayer` gate or privileged relayer address on this contract.
 */
contract GaslessShieldWrapperClient is EIP712 {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════════════════

    address public immutable usdc;
    address public immutable privacyPoolClient;

    /// @notice Per-user replay nonce for the EIP-712 intent. Independent of the ERC20Permit nonce.
    mapping(address => uint256) public nonces;

    /// @notice EIP-712 typehash for the cross-chain intent the user signs alongside the permit.
    bytes32 public constant CROSS_CHAIN_SHIELD_INTENT_TYPEHASH = keccak256(
        "CrossChainShieldIntent(address user,bytes32 userNoteHash,bytes32 feeNoteHash,uint256 maxFee,uint32 minFinalityThreshold,uint256 deadline,uint256 nonce)"
    );

    // ══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Scalar params grouped to keep the entry point's stack shallow (stack-too-deep without
    ///      via-ir). The user note + fee note stay as separate calldata args.
    struct CrossChainIntentParams {
        address user; // permit signer + intent signer + USDC source
        uint256 deadline; // shared permit + intent deadline
        uint256 nonce; // must equal nonces[user]
        uint256 maxFee; // CCTP protocol fee ceiling
        uint32 minFinalityThreshold; // CCTP finality (FAST/STANDARD, 0 = client default)
        uint8 permitV; // EIP-2612 permit signature component
        bytes32 permitR; // EIP-2612 permit signature component
        bytes32 permitS; // EIP-2612 permit signature component
    }

    // ══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @dev `notesHash` is `keccak256(abi.encode(userNote, feeNote))` — the digest the user signed in
     *      the intent. `feeValue` is the relayer fee note's declared value (gross of the Hub shield
     *      fee). Lets a watcher confirm off-chain that the burn honored the signed cross-chain intent.
     */
    event GaslessShield(
        address indexed user,
        uint256 totalAmount,
        uint256 feeValue,
        uint64 cctpNonce,
        bytes32 notesHash
    );

    // ══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════════════

    constructor(address _usdc, address _privacyPoolClient) EIP712("ArmadaGaslessCrossChainShield", "1") {
        require(_usdc != address(0), "GaslessShieldWrapperClient: zero usdc");
        require(_privacyPoolClient != address(0), "GaslessShieldWrapperClient: zero privacyPoolClient");
        usdc = _usdc;
        privacyPoolClient = _privacyPoolClient;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GASLESS CROSS-CHAIN SHIELD
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Atomically verify intent + permit + cross-chain shield. Returns the CCTP nonce.
     * @param params Scalar intent + permit-signature params (see `CrossChainIntentParams`).
     * @param intentSig EIP-712 CrossChainShieldIntent signature (EOA or EIP-1271).
     * @param userNote The user's recipient note (npk + ciphertext + value). Minted on the Hub net of
     *        the CCTP fee.
     * @param feeNote The relayer's fee note (to the relayer's npk). Minted on the Hub at full value.
     */
    function gaslessCrossChainShield(
        CrossChainIntentParams calldata params,
        bytes calldata intentSig,
        ShieldData calldata userNote,
        ShieldData calldata feeNote
    ) external returns (uint64 cctpNonce) {
        require(block.timestamp <= params.deadline, "GaslessShieldWrapperClient: expired");
        require(params.nonce == nonces[params.user], "GaslessShieldWrapperClient: bad nonce");

        // Verify the intent binds both notes + CCTP params + deadline + nonce for this user.
        _verifyIntent(params, keccak256(abi.encode(userNote)), keccak256(abi.encode(feeNote)), intentSig);

        // Effects: consume the nonce before any external call (checks-effects-interactions).
        nonces[params.user] = params.nonce + 1;

        require(userNote.value > 0, "GaslessShieldWrapperClient: zero user note");
        require(feeNote.value > 0, "GaslessShieldWrapperClient: zero fee note");
        uint256 total = uint256(userNote.value) + uint256(feeNote.value);

        cctpNonce = _permitPullApproveShield(params, total, userNote, feeNote);

        emit GaslessShield(
            params.user, total, uint256(feeNote.value), cctpNonce, keccak256(abi.encode(userNote, feeNote))
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Recompute the EIP-712 digest and require a valid EOA/EIP-1271 signature from `user`.
    function _verifyIntent(
        CrossChainIntentParams calldata params,
        bytes32 userNoteHash,
        bytes32 feeNoteHash,
        bytes calldata intentSig
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                CROSS_CHAIN_SHIELD_INTENT_TYPEHASH,
                params.user,
                userNoteHash,
                feeNoteHash,
                params.maxFee,
                params.minFinalityThreshold,
                params.deadline,
                params.nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        require(
            SignatureChecker.isValidSignatureNow(params.user, digest, intentSig),
            "GaslessShieldWrapperClient: bad intent sig"
        );
    }

    /// @dev The atomic money-movement leg. No inter-call state — do not add intermediate storage
    ///      writes here (preserves the "no funds pulled without burn" guarantee).
    function _permitPullApproveShield(
        CrossChainIntentParams calldata params,
        uint256 total,
        ShieldData calldata userNote,
        ShieldData calldata feeNote
    ) internal returns (uint64) {
        IERC20Permit(usdc).permit(
            params.user, address(this), total, params.deadline, params.permitV, params.permitR, params.permitS
        );
        IERC20(usdc).safeTransferFrom(params.user, address(this), total);
        IERC20(usdc).safeApprove(privacyPoolClient, 0);
        IERC20(usdc).safeApprove(privacyPoolClient, total);
        return IPrivacyPoolClient(privacyPoolClient).crossChainShieldWithFee(
            params.maxFee, params.minFinalityThreshold, userNote, feeNote
        );
    }
}
