// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title HubUnshieldProxy
 * @notice Bridge for cross-chain unshield - converts Hub USDC to Client chain USDC
 * @dev For POC simplicity, this uses a user-initiated approach:
 *
 * Flow:
 *   1. User creates NORMAL unshield with npk = their own address (on Hub)
 *   2. User receives USDC on Hub chain
 *   3. User approves this contract and calls bridgeToClient()
 *   4. This contract burns via MockUSDC.burnForDeposit()
 *   5. Relayer picks up BurnForDeposit event and mints on Client chain
 *
 * Note: In production, this would use actual CCTP with attestations.
 */
contract HubUnshieldProxy {
    using SafeERC20 for IERC20;

    // MockUSDC address (the token we're bridging)
    address public immutable mockUSDC;

    // Default destination chain ID (Client chain)
    uint32 public immutable clientChainId;

    // Events
    event BridgeInitiated(
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint32 destinationChainId,
        uint64 ccptNonce
    );

    // Owner for emergency functions
    address public owner;

    constructor(address _mockUSDC, uint32 _clientChainId) {
        mockUSDC = _mockUSDC;
        clientChainId = _clientChainId;
        owner = msg.sender;
    }

    /**
     * @notice Bridge USDC from Hub to Client chain
     * @param amount Amount of USDC to bridge
     * @param recipient Address to receive USDC on Client chain
     * @return nonce The CCTP nonce for tracking
     *
     * User must approve this contract to spend their USDC before calling.
     */
    function bridgeToClient(
        uint256 amount,
        address recipient
    ) external returns (uint64 nonce) {
        require(amount > 0, "Amount must be > 0");
        require(recipient != address(0), "Invalid recipient");

        // Transfer USDC from user to this contract
        IERC20(mockUSDC).safeTransferFrom(msg.sender, address(this), amount);

        // Approve MockUSDC to burn from this contract (reset to 0 first for SafeERC20)
        IERC20(mockUSDC).safeApprove(mockUSDC, 0);
        IERC20(mockUSDC).safeApprove(mockUSDC, amount);

        // Burn via CCTP simulation
        nonce = IMockUSDC(mockUSDC).burnForDeposit(
            amount,
            clientChainId,
            recipient,
            ""  // No payload - direct transfer to recipient
        );

        emit BridgeInitiated(
            msg.sender,
            recipient,
            amount,
            clientChainId,
            nonce
        );

        return nonce;
    }

    /**
     * @notice Bridge USDC to any supported chain
     * @param amount Amount of USDC to bridge
     * @param recipient Address to receive USDC on destination chain
     * @param destinationChainId Target chain ID
     * @return nonce The CCTP nonce for tracking
     */
    function bridgeTo(
        uint256 amount,
        address recipient,
        uint32 destinationChainId
    ) external returns (uint64 nonce) {
        require(amount > 0, "Amount must be > 0");
        require(recipient != address(0), "Invalid recipient");
        require(destinationChainId != 0, "Invalid chain ID");

        // Transfer USDC from user to this contract
        IERC20(mockUSDC).safeTransferFrom(msg.sender, address(this), amount);

        // Approve MockUSDC to burn from this contract (reset to 0 first for SafeERC20)
        IERC20(mockUSDC).safeApprove(mockUSDC, 0);
        IERC20(mockUSDC).safeApprove(mockUSDC, amount);

        // Burn via CCTP simulation
        nonce = IMockUSDC(mockUSDC).burnForDeposit(
            amount,
            destinationChainId,
            recipient,
            ""  // No payload - direct transfer to recipient
        );

        emit BridgeInitiated(
            msg.sender,
            recipient,
            amount,
            destinationChainId,
            nonce
        );

        return nonce;
    }

    /**
     * @notice Emergency withdraw stuck funds (POC only)
     */
    function emergencyWithdraw(address token, address to, uint256 amount) external {
        require(msg.sender == owner, "Only owner");
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Transfer ownership
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
