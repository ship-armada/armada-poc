// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ClientShieldProxyV2
 * @notice User-facing contract for shield operations on client chain (Railgun-compatible)
 * @dev Abstracts CCTP details from users. Sends properly formatted ShieldRequest data.
 *
 * Shield flow:
 *   1. User generates ShieldRequest data off-chain (npk, ciphertext)
 *   2. User approves this contract to spend USDC
 *   3. User calls shield(amount, npk, encryptedBundle, shieldKey)
 *   4. This contract transfers USDC from user
 *   5. This contract burns USDC via MockUSDC.burnForDeposit()
 *   6. Relayer picks up event and mints on Hub
 *   7. HubCCTPReceiverV2 calls RailgunSmartWallet.shield()
 *
 * Key changes from V1:
 * - Accepts full ShieldRequest components instead of simple commitment
 * - Encodes payload format compatible with HubCCTPReceiverV2
 */
contract ClientShieldProxyV2 {
    using SafeERC20 for IERC20;

    // Immutable configuration
    address public immutable mockUSDC;
    uint32 public immutable hubChainId;
    address public hubReceiver;  // HubCCTPReceiverV2 address on hub chain

    // Events
    event ShieldInitiated(
        address indexed user,
        uint256 amount,
        bytes32 indexed npk,
        uint64 nonce
    );

    event HubReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);

    // Owner for configuration (POC simplicity)
    address public owner;

    constructor(
        address _mockUSDC,
        uint32 _hubChainId,
        address _hubReceiver
    ) {
        mockUSDC = _mockUSDC;
        hubChainId = _hubChainId;
        hubReceiver = _hubReceiver;
        owner = msg.sender;
    }

    /**
     * @notice Shield USDC into the hub MASP (Railgun-compatible)
     * @param amount Amount of USDC to shield (must match value encoded in npk commitment)
     * @param npk Note Public Key - Poseidon hash representing note ownership
     * @param encryptedBundle Shield ciphertext encrypted bundle [3 x bytes32]
     * @param shieldKey Public key for shared secret derivation
     * @return nonce The CCTP nonce for tracking
     *
     * The npk, encryptedBundle, and shieldKey should be generated off-chain using
     * the shield_request.ts library, which uses Poseidon hashing.
     */
    function shield(
        uint256 amount,
        bytes32 npk,
        bytes32[3] calldata encryptedBundle,
        bytes32 shieldKey
    ) external returns (uint64 nonce) {
        require(amount > 0, "Amount must be > 0");
        require(npk != bytes32(0), "Invalid npk");
        require(hubReceiver != address(0), "Hub receiver not set");

        // Transfer USDC from user to this contract
        IERC20(mockUSDC).safeTransferFrom(msg.sender, address(this), amount);

        // Encode payload for hub (V2 format)
        // This matches what HubCCTPReceiverV2.onCCTPReceive() expects
        bytes memory payload = abi.encode(
            npk,
            uint120(amount),
            encryptedBundle,
            shieldKey
        );

        // Burn USDC via CCTP simulation (reset to 0 first for SafeERC20)
        IERC20(mockUSDC).safeApprove(mockUSDC, 0);
        IERC20(mockUSDC).safeApprove(mockUSDC, amount);

        nonce = IMockUSDC(mockUSDC).burnForDeposit(
            amount,
            hubChainId,
            hubReceiver,
            payload
        );

        emit ShieldInitiated(msg.sender, amount, npk, nonce);

        return nonce;
    }

    /**
     * @notice Update hub receiver address (owner only)
     * @param _hubReceiver New HubCCTPReceiverV2 address
     */
    function setHubReceiver(address _hubReceiver) external {
        require(msg.sender == owner, "Only owner");
        emit HubReceiverUpdated(hubReceiver, _hubReceiver);
        hubReceiver = _hubReceiver;
    }

    /**
     * @notice Transfer ownership (POC only)
     */
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "Only owner");
        owner = newOwner;
    }
}

/**
 * @notice Interface for MockUSDC burn function
 */
interface IMockUSDC {
    function burnForDeposit(
        uint256 amount,
        uint32 destinationChainId,
        address destinationAddress,
        bytes calldata payload
    ) external returns (uint64);
}
