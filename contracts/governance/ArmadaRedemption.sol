// SPDX-License-Identifier: MIT
// ABOUTME: Permissionless redemption contract for wind-down. ARM holders deposit ARM to receive
// ABOUTME: pro-rata shares of treasury assets (USDC, ETH, etc.) after wind-down triggers.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @notice Minimal interface for ARM token transferable flag
interface IArmadaTokenRedemption {
    function transferable() external view returns (bool);
}

/// @notice Minimal interface for reading wind-down trigger timestamp
interface IArmadaWindDownRedemption {
    function triggerTime() external view returns (uint256);
}

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

    /// @notice Deployer address; authorized to wire the wind-down contract once.
    address public immutable admin;

    // ============ Constants ============

    /// @notice Delay after wind-down trigger before redemptions can begin. Provides a
    ///         social coordination window for sweepToken/sweepETH to run, mitigating
    ///         the partial-sweep / pre-sweep ARM-lock footgun tracked in issue #254.
    uint256 public constant REDEMPTION_DELAY = 1 days;

    // ============ Mutable State ============

    /// @notice Wind-down contract reference. Set once via setWindDown after deployment.
    address public windDown;

    // ============ Events ============

    event Redeemed(address indexed redeemer, uint256 armAmount, address[] tokens, uint256 ethAmount);
    event WindDownSet(address indexed windDown);

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
        admin = msg.sender;
    }

    // ============ One-Time Wiring ============

    /// @notice Wire the wind-down contract reference. Callable once by the deployer.
    ///         Breaks the deploy-order circularity: ArmadaWindDown's constructor needs
    ///         this contract's address, so this contract learns the wind-down address
    ///         post-deploy instead of via constructor.
    /// @param _windDown ArmadaWindDown contract address
    function setWindDown(address _windDown) external {
        require(msg.sender == admin, "ArmadaRedemption: not admin");
        require(windDown == address(0), "ArmadaRedemption: wind-down already set");
        require(_windDown != address(0), "ArmadaRedemption: zero windDown");
        windDown = _windDown;
        emit WindDownSet(_windDown);
    }

    // ============ Redemption Functions ============

    /// @notice Deposit ARM and receive pro-rata share of specified ERC20 tokens and/or ETH.
    ///         ARM is locked permanently in this contract. A single ARM deposit covers all
    ///         requested asset types — per the spec, one deposit yields shares of all assets.
    /// @param armAmount Amount of ARM to deposit
    /// @param tokens Array of ERC20 token addresses to redeem (must be sorted ascending, no
    ///        duplicates, and must not include the ARM token)
    /// @param includeETH If true, also redeem pro-rata share of ETH held by this contract
    function redeem(
        uint256 armAmount,
        address[] calldata tokens,
        bool includeETH
    ) external nonReentrant {
        require(armAmount > 0, "ArmadaRedemption: zero amount");
        // Defense-in-depth: ARM transfers are enabled by the wind-down contract via
        // setTransferable(true). While the safeTransferFrom below would revert for
        // non-whitelisted callers pre-wind-down, this makes the invariant explicit.
        require(
            IArmadaTokenRedemption(address(armToken)).transferable(),
            "ArmadaRedemption: wind-down not triggered"
        );

        // Enforce the post-trigger redemption delay. Provides a social-coordination window
        // for sweepToken/sweepETH to run before any redemption can execute. See issue #254.
        require(windDown != address(0), "ArmadaRedemption: wind-down not set");
        uint256 triggeredAt = IArmadaWindDownRedemption(windDown).triggerTime();
        require(triggeredAt > 0, "ArmadaRedemption: wind-down not triggered");
        require(
            block.timestamp >= triggeredAt + REDEMPTION_DELAY,
            "ArmadaRedemption: redemption delay not elapsed"
        );

        // Calculate circulating supply BEFORE the ARM transfer (depositor's ARM is still
        // in circulation and counts in the denominator for correct pro-rata math)
        uint256 circulating = circulatingSupply();
        require(circulating > 0, "ArmadaRedemption: no circulating supply");

        // Transfer ARM from redeemer to this contract (locked permanently)
        armToken.safeTransferFrom(msg.sender, address(this), armAmount);

        // Distribute pro-rata share of each requested ERC20 token. Track whether any
        // payout occurred so we can revert if the caller would lock ARM for zero return
        // (e.g. redeeming before sweeps have populated the contract — see issue #254).
        bool anyPayout;
        for (uint256 i = 0; i < tokens.length; i++) {
            // ARM deposited in this contract is locked permanently — never distributable
            require(tokens[i] != address(armToken), "ArmadaRedemption: cannot redeem ARM");

            // Tokens must be sorted ascending with no duplicates to prevent double-claiming
            if (i > 0) {
                require(tokens[i] > tokens[i - 1], "ArmadaRedemption: tokens not sorted/unique");
            }

            uint256 available = IERC20(tokens[i]).balanceOf(address(this));
            uint256 share = (available * armAmount) / circulating;
            if (share > 0) {
                IERC20(tokens[i]).safeTransfer(msg.sender, share);
                anyPayout = true;
            }
        }

        // Distribute pro-rata share of ETH if requested
        uint256 ethPayout;
        if (includeETH) {
            uint256 ethBalance = address(this).balance;
            ethPayout = (ethBalance * armAmount) / circulating;
            if (ethPayout > 0) {
                (bool success,) = msg.sender.call{value: ethPayout}("");
                require(success, "ArmadaRedemption: ETH transfer failed");
                anyPayout = true;
            }
        }

        // Prevent ARM lock-in with zero return (issue #254). This closes the catastrophic
        // all-zero-payout case that the REDEMPTION_DELAY cannot guarantee against — the
        // delay gives sweeps a chance to run but does not force them. If no sweep ever
        // ran, or the caller requested only un-swept assets, this revert preserves ARM.
        require(anyPayout, "ArmadaRedemption: no assets available - call sweep first");

        emit Redeemed(msg.sender, armAmount, tokens, ethPayout);
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
