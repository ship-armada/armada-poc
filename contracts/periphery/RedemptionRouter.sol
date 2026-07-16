// SPDX-License-Identifier: MIT
// ABOUTME: Contingency periphery for wind-down redemption (issue #256). Deployed only during the
// ABOUTME: post-trigger window with the then-known swept-token list; never part of launch deployments.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @notice Minimal interface to ArmadaRedemption's redeem entry point.
interface IArmadaRedemptionRouter {
    function redeem(uint256 armAmount, address[] calldata tokens, address ethRecipient) external;
}

/// @title RedemptionRouter — Footgun-free wrapper around ArmadaRedemption.redeem
/// @notice ArmadaRedemption.redeem() pays out only the assets the caller explicitly lists;
///         any swept asset omitted from the list is silently and irreversibly forfeited
///         (the deposited ARM is locked regardless). This router bakes the complete
///         swept-token list in at construction so a redeemer cannot forget one: a single
///         redeemAll(armAmount, recipient) call claims the caller's pro-rata share of
///         every listed asset plus ETH.
///
///         Deployment model (see docs/winddown-redemption-runbook.md):
///         - NOT deployed at launch and NOT part of `npm run setup`. This contract sits
///           in the repo, kept compiling and tested by CI, until wind-down actually
///           happens.
///         - Deployed during the 7-day REDEMPTION_DELAY window, after all sweeps have
///           completed, with the full swept-token list as a constructor argument
///           (sourced from ArmadaWindDown's TokenSwept events).
///         - Immutable once deployed: no admin, no setters. A wrong list means deploying
///           a fresh router, not mutating this one.
///
///         Trust surface for redeemers: approve ARM to this router and call redeemAll.
///         The baked list is readable via allTokens() so anyone can verify it against
///         the published manifest before approving.
contract RedemptionRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice ARM governance token
    IERC20 public immutable armToken;

    /// @notice The core redemption contract this router wraps
    IArmadaRedemptionRouter public immutable redemption;

    /// @notice Complete swept-token list, sorted ascending, fixed at deployment.
    ///         May be empty for an ETH-only wind-down.
    address[] private tokens;

    event RouterRedeemed(address indexed caller, address indexed recipient, uint256 armAmount);

    /// @param _armToken ARM token address
    /// @param _redemption ArmadaRedemption contract address
    /// @param _tokens Complete list of swept ERC20 assets (sorted ascending, no duplicates,
    ///        no zero entries, ARM excluded). Validated here so a malformed list fails at
    ///        deploy time — during the coordinated runbook window — never at user
    ///        redemption time.
    constructor(address _armToken, address _redemption, address[] memory _tokens) {
        require(_armToken != address(0), "RedemptionRouter: zero armToken");
        require(_redemption != address(0), "RedemptionRouter: zero redemption");

        for (uint256 i = 0; i < _tokens.length; i++) {
            require(_tokens[i] != address(0), "RedemptionRouter: zero token");
            require(_tokens[i] != _armToken, "RedemptionRouter: ARM in token list");
            // Mirrors ArmadaRedemption's ordering requirement so redeem() cannot
            // reject the baked list later.
            if (i > 0) {
                require(_tokens[i] > _tokens[i - 1], "RedemptionRouter: tokens not sorted/unique");
            }
        }

        armToken = IERC20(_armToken);
        redemption = IArmadaRedemptionRouter(_redemption);
        tokens = _tokens;

        // One-time allowance: redeem() pulls ARM from this router via
        // safeTransferFrom. ARM is a fixed-supply token, so max approval here
        // covers the router's lifetime.
        IERC20(_armToken).safeApprove(_redemption, type(uint256).max);
    }

    /// @notice Deposit ARM and receive the pro-rata share of EVERY swept asset in one call.
    ///         ARM is locked permanently in the redemption contract (same semantics as
    ///         calling redeem() directly). ERC20 payouts pass through this router to the
    ///         recipient; the ETH share goes directly from the redemption contract to the
    ///         recipient.
    /// @param armAmount Amount of ARM to deposit (pulled from msg.sender; approve first)
    /// @param recipient Receives all payouts. Smart-contract callers that cannot receive
    ///        ETH should pass an address that can — if the recipient rejects the ETH
    ///        transfer, the entire redemption reverts and the caller keeps their ARM.
    function redeemAll(uint256 armAmount, address recipient) external nonReentrant {
        require(recipient != address(0), "RedemptionRouter: zero recipient");

        armToken.safeTransferFrom(msg.sender, address(this), armAmount);

        // ETH is routed straight to the recipient via ethRecipient, so this router
        // never holds ETH (it has no receive function by design).
        redemption.redeem(armAmount, tokens, recipient);

        // Forward each payout in full. Transferring the whole balance (rather than a
        // computed share) also flushes any stray donations — the router retains
        // nothing across calls.
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 balance = IERC20(tokens[i]).balanceOf(address(this));
            if (balance > 0) {
                IERC20(tokens[i]).safeTransfer(recipient, balance);
            }
        }

        emit RouterRedeemed(msg.sender, recipient, armAmount);
    }

    /// @notice The complete baked token list. Read this and check it against the
    ///         published wind-down manifest before approving ARM to this router.
    function allTokens() external view returns (address[] memory) {
        return tokens;
    }
}
