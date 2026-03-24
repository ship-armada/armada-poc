// ABOUTME: Permissionless redemption contract for wind-down. ARM holders deposit ARM to receive
// ABOUTME: pro-rata shares of treasury assets (USDC, ETH, etc.) after wind-down triggers.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @title ArmadaRedemption — Pro-rata treasury redemption for ARM holders
/// @notice Not upgradeable. Permissionless. No admin functions. No deadline.
///
///         After wind-down triggers and treasury assets are swept here, ARM holders can
///         deposit ARM and receive their pro-rata share of each treasury asset.
///
///         Deposited ARM is locked permanently (not burned — ARM has no burn function).
///         The circulating supply denominator excludes treasury, revenue-lock, crowdfund,
///         and this redemption contract — all hardcoded at construction.
///
///         Sequential correctness: each redemption is calculated against remaining assets
///         and remaining circulating supply. Early and late redeemers get the same
///         pro-rata outcome.
contract ArmadaRedemption is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Immutable References ============

    /// @notice ARM governance token
    IERC20 public immutable armToken;

    /// @notice Treasury contract address (excluded from circulating supply)
    address public immutable treasury;

    /// @notice Revenue-lock contract address (excluded from circulating supply)
    address public immutable revenueLock;

    /// @notice Crowdfund contract address (excluded from circulating supply)
    address public immutable crowdfundContract;

    // ============ Events ============

    event Redeemed(address indexed redeemer, uint256 armAmount, address[] tokens);
    event RedeemedETH(address indexed redeemer, uint256 armAmount, uint256 ethAmount);

    // ============ Constructor ============

    /// @param _armToken ARM token address
    /// @param _treasury Treasury contract address
    /// @param _revenueLock Revenue-lock contract address
    /// @param _crowdfundContract Crowdfund contract address
    constructor(
        address _armToken,
        address _treasury,
        address _revenueLock,
        address _crowdfundContract
    ) {
        require(_armToken != address(0), "ArmadaRedemption: zero armToken");
        require(_treasury != address(0), "ArmadaRedemption: zero treasury");
        require(_revenueLock != address(0), "ArmadaRedemption: zero revenueLock");
        require(_crowdfundContract != address(0), "ArmadaRedemption: zero crowdfund");

        armToken = IERC20(_armToken);
        treasury = _treasury;
        revenueLock = _revenueLock;
        crowdfundContract = _crowdfundContract;
    }

    // ============ Redemption Functions ============

    /// @notice Deposit ARM and receive pro-rata share of specified ERC20 tokens.
    ///         ARM is locked permanently in this contract.
    /// @param armAmount Amount of ARM to deposit
    /// @param tokens Array of ERC20 token addresses to redeem
    function redeem(uint256 armAmount, address[] calldata tokens) external nonReentrant {
        require(armAmount > 0, "ArmadaRedemption: zero amount");

        // Calculate circulating supply BEFORE the ARM transfer (depositor's ARM is still
        // in circulation and counts in the denominator for correct pro-rata math)
        uint256 circulating = circulatingSupply();
        require(circulating > 0, "ArmadaRedemption: no circulating supply");

        // Transfer ARM from redeemer to this contract (locked permanently)
        armToken.safeTransferFrom(msg.sender, address(this), armAmount);

        // Distribute pro-rata share of each requested token
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 available = IERC20(tokens[i]).balanceOf(address(this));
            uint256 share = (available * armAmount) / circulating;
            if (share > 0) {
                IERC20(tokens[i]).safeTransfer(msg.sender, share);
            }
        }

        emit Redeemed(msg.sender, armAmount, tokens);
    }

    /// @notice Deposit ARM and receive pro-rata share of ETH held by this contract.
    ///         ARM is locked permanently in this contract.
    /// @param armAmount Amount of ARM to deposit
    function redeemETH(uint256 armAmount) external nonReentrant {
        require(armAmount > 0, "ArmadaRedemption: zero amount");

        // Calculate circulating supply BEFORE the ARM transfer
        uint256 circulating = circulatingSupply();
        require(circulating > 0, "ArmadaRedemption: no circulating supply");

        // Transfer ARM from redeemer to this contract (locked permanently)
        armToken.safeTransferFrom(msg.sender, address(this), armAmount);

        // Calculate and send ETH share
        uint256 ethBalance = address(this).balance;
        uint256 share = (ethBalance * armAmount) / circulating;
        if (share > 0) {
            (bool success,) = msg.sender.call{value: share}("");
            require(success, "ArmadaRedemption: ETH transfer failed");
        }

        emit RedeemedETH(msg.sender, armAmount, share);
    }

    // ============ View Functions ============

    /// @notice Circulating ARM supply, excluding non-redeemable addresses.
    ///         Denominator = totalSupply - treasury - revenueLock - crowdfund - this contract
    function circulatingSupply() public view returns (uint256) {
        uint256 total = armToken.totalSupply();
        total -= armToken.balanceOf(treasury);
        total -= armToken.balanceOf(revenueLock);
        total -= armToken.balanceOf(crowdfundContract);
        total -= armToken.balanceOf(address(this));
        return total;
    }

    /// @notice Accept ETH (from wind-down sweeps)
    receive() external payable {}
}
