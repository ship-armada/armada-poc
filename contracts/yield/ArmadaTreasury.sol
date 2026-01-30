// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ArmadaTreasury
 * @notice Simple treasury contract for collecting yield fees
 * @dev Receives fees from ArmadaYieldVault and allows owner to withdraw
 */
contract ArmadaTreasury {
    using SafeERC20 for IERC20;

    // ============ State ============

    /// @notice Contract owner
    address public owner;

    /// @notice Total fees collected per token (for tracking)
    mapping(address => uint256) public totalCollected;

    // ============ Events ============

    event FeeReceived(address indexed token, address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ============ Modifiers ============

    modifier onlyOwner() {
        require(msg.sender == owner, "ArmadaTreasury: not owner");
        _;
    }

    // ============ Constructor ============

    constructor() {
        owner = msg.sender;
    }

    // ============ External Functions ============

    /**
     * @notice Withdraw tokens from treasury
     * @param token Token address to withdraw
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function withdraw(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(to != address(0), "ArmadaTreasury: zero address");
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    /**
     * @notice Transfer ownership
     * @param newOwner New owner address
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ArmadaTreasury: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ============ View Functions ============

    /**
     * @notice Get current balance of a token
     * @param token Token address
     * @return Current balance
     */
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    // ============ Receive Functions ============

    /**
     * @notice Called when tokens are transferred to this contract
     * @dev This is called by ERC20 tokens that support ERC677 (transferAndCall)
     *      For standard ERC20 transfers, use recordFee() after transfer
     */
    function onTokenTransfer(
        address from,
        uint256 amount,
        bytes calldata
    ) external returns (bool) {
        totalCollected[msg.sender] += amount;
        emit FeeReceived(msg.sender, from, amount);
        return true;
    }

    /**
     * @notice Record a fee that was transferred via standard ERC20 transfer
     * @dev Call this after transferring tokens to update tracking
     * @param token Token that was transferred
     * @param from Original sender
     * @param amount Amount transferred
     */
    function recordFee(
        address token,
        address from,
        uint256 amount
    ) external {
        totalCollected[token] += amount;
        emit FeeReceived(token, from, amount);
    }

    /**
     * @notice Receive ETH (if needed in future)
     */
    receive() external payable {}
}
