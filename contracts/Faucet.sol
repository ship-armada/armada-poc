// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./cctp/MockUSDCV2.sol";

/**
 * @title Faucet
 * @notice Simple faucet for local devnet testing
 * @dev Mints MockUSDC and sends ETH to requesters
 */
contract Faucet {
    MockUSDCV2 public immutable usdc;

    uint256 public constant USDC_AMOUNT = 1000 * 1e6;  // 1000 USDC (6 decimals)
    uint256 public constant ETH_AMOUNT = 1 ether;

    // No cooldown for local devnet - set to 0
    uint256 public constant COOLDOWN = 0;

    mapping(address => uint256) public lastFaucetTime;

    event Drip(address indexed recipient, uint256 usdcAmount, uint256 ethAmount);

    constructor(address _usdc) payable {
        usdc = MockUSDCV2(_usdc);
    }

    /**
     * @notice Request test tokens
     * @dev Mints USDC and sends ETH if available
     */
    function drip() external {
        _drip(msg.sender);
    }

    /**
     * @notice Request test tokens for a specific recipient
     * @dev Allows backend to fund users without them needing gas first
     * @param recipient Address to receive tokens
     */
    function dripTo(address recipient) external {
        _drip(recipient);
    }

    function _drip(address recipient) internal {
        require(
            block.timestamp >= lastFaucetTime[recipient] + COOLDOWN,
            "Cooldown not elapsed"
        );

        lastFaucetTime[recipient] = block.timestamp;

        // Mint USDC to recipient
        usdc.mint(recipient, USDC_AMOUNT);

        // Send ETH if contract has balance
        uint256 ethToSend = 0;
        if (address(this).balance >= ETH_AMOUNT) {
            ethToSend = ETH_AMOUNT;
            payable(recipient).transfer(ETH_AMOUNT);
        }

        emit Drip(recipient, USDC_AMOUNT, ethToSend);
    }

    /**
     * @notice Check contract ETH balance
     */
    function ethBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // Allow funding the faucet with ETH
    receive() external payable {}
}
