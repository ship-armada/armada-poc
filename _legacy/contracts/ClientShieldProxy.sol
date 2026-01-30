// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ClientShieldProxy
 * @notice User-facing contract for shield/unshield operations on client chain
 * @dev Abstracts CCTP details from users. This is what users interact with.
 *
 * Shield flow:
 *   1. User approves this contract to spend USDC
 *   2. User calls shield(amount, commitment, encryptedNote)
 *   3. This contract transfers USDC from user
 *   4. This contract burns USDC via MockUSDC.burnForDeposit()
 *   5. Relayer picks up event and mints on Hub
 *
 * Unshield flow:
 *   1. Hub burns USDC destined for user's address on this chain
 *   2. Relayer calls receiveMessage on MockUSDC here
 *   3. MockUSDC mints directly to user (no callback needed)
 */
contract ClientShieldProxy {
    using SafeERC20 for IERC20;

    // Immutable configuration
    address public immutable mockUSDC;
    uint32 public immutable hubChainId;
    address public hubReceiver;  // HubCCTPReceiver address on hub chain

    // Events
    event ShieldInitiated(
        address indexed user,
        uint256 amount,
        bytes32 commitment,
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
     * @notice Shield USDC into the hub MASP
     * @param amount Amount of USDC to shield
     * @param commitment The note commitment hash (generated off-chain)
     * @param encryptedNote Encrypted note data for wallet recovery
     * @return nonce The CCTP nonce for tracking
     */
    function shield(
        uint256 amount,
        bytes32 commitment,
        bytes calldata encryptedNote
    ) external returns (uint64 nonce) {
        require(amount > 0, "Amount must be > 0");
        require(commitment != bytes32(0), "Invalid commitment");
        require(hubReceiver != address(0), "Hub receiver not set");

        // Transfer USDC from user to this contract
        IERC20(mockUSDC).safeTransferFrom(msg.sender, address(this), amount);

        // Encode payload for hub
        bytes memory payload = abi.encode(commitment, amount, encryptedNote);

        // Burn USDC via CCTP simulation
        // First approve MockUSDC to burn from this contract
        IERC20(mockUSDC).safeApprove(mockUSDC, amount);

        nonce = IMockUSDC(mockUSDC).burnForDeposit(
            amount,
            hubChainId,
            hubReceiver,
            payload
        );

        emit ShieldInitiated(msg.sender, amount, commitment, nonce);

        return nonce;
    }

    /**
     * @notice Update hub receiver address (owner only)
     * @param _hubReceiver New HubCCTPReceiver address
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
