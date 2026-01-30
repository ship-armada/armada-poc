// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title HubCCTPReceiver
 * @notice Receives CCTP mints and forwards to MASP adapter
 * @dev This contract is the recipient of all CCTP messages on the Hub chain.
 *      It decodes the payload and calls the appropriate MASP function.
 */
contract HubCCTPReceiver {
    using SafeERC20 for IERC20;

    // Addresses
    address public immutable mockUSDC;
    address public shieldAdapter;  // SimpleShieldAdapter or RailgunSmartWallet

    // Events
    event CCTPReceived(
        uint256 amount,
        bytes32 commitment,
        bytes encryptedNote
    );

    event AdapterUpdated(address indexed oldAdapter, address indexed newAdapter);

    // Owner for configuration
    address public owner;

    constructor(address _mockUSDC, address _shieldAdapter) {
        mockUSDC = _mockUSDC;
        shieldAdapter = _shieldAdapter;
        owner = msg.sender;
    }

    /**
     * @notice Called by MockUSDC when receiving CCTP message
     * @param amount Amount of USDC received (minted to this contract)
     * @param payload Encoded shield data from ClientShieldProxy
     */
    function onCCTPReceive(uint256 amount, bytes calldata payload) external {
        require(msg.sender == mockUSDC, "Only MockUSDC");

        if (payload.length == 0) {
            // Empty payload - shouldn't happen in normal flow
            // USDC stays in this contract
            return;
        }

        // Decode payload from ClientShieldProxy
        (bytes32 commitment, uint256 encodedAmount, bytes memory encryptedNote) =
            abi.decode(payload, (bytes32, uint256, bytes));

        // Sanity check
        require(encodedAmount == amount, "Amount mismatch");

        emit CCTPReceived(amount, commitment, encryptedNote);

        // Transfer USDC to adapter and insert commitment
        IERC20(mockUSDC).safeTransfer(shieldAdapter, amount);

        // Call adapter to insert commitment
        IShieldAdapter(shieldAdapter).insertCommitment(
            commitment,
            amount,
            encryptedNote
        );
    }

    /**
     * @notice Update shield adapter address (owner only)
     * @dev Use this to swap SimpleShieldAdapter for RailgunSmartWallet
     */
    function setShieldAdapter(address _shieldAdapter) external {
        require(msg.sender == owner, "Only owner");
        emit AdapterUpdated(shieldAdapter, _shieldAdapter);
        shieldAdapter = _shieldAdapter;
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
 * @notice Interface for shield adapters (SimpleShieldAdapter or Railgun wrapper)
 */
interface IShieldAdapter {
    function insertCommitment(
        bytes32 commitment,
        uint256 amount,
        bytes calldata encryptedNote
    ) external;
}
