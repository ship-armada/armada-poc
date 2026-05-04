// SPDX-License-Identifier: MIT
// ABOUTME: Permissionless redemption contract for wind-down. ARM holders deposit ARM to receive
// ABOUTME: pro-rata shares of treasury assets (USDC, ETH, etc.) after wind-down triggers.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @notice Minimal interface for ARM token: transferable flag and the
/// circulatingSupplyOf batch helper used by circulatingSupply().
interface IArmadaTokenRedemption {
    function transferable() external view returns (bool);
    function circulatingSupplyOf(address[] calldata excluded) external view returns (uint256);
}

/// @notice Minimal interface for reading wind-down trigger timestamp
interface IArmadaWindDownRedemption {
    function triggerTime() external view returns (uint256);
}

/// @notice Minimal interface for reading the locked (unvested) portion of RevenueLock.
///         Pre-freeze the live ratchet is used; post-freeze (after wind-down trigger)
///         this returns the value frozen at trigger time.
interface IRevenueLockRedemption {
    function lockedAtWindDown() external view returns (uint256);
}

/// @notice Minimal interface for reading entitled-but-unclaimed ARM in the crowdfund.
///         `armStillOwed` returns the dynamic amount the contract owes participants
///         (zero pre-finalize / on cancel / refundMode / post-claim-deadline).
interface IArmadaCrowdfundRedemption {
    function armStillOwed() external view returns (uint256);
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
    uint256 public constant REDEMPTION_DELAY = 7 days;

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
        // Parameter check before cold SLOAD on the lock flag (audit-79).
        require(_windDown != address(0), "ArmadaRedemption: zero windDown");
        require(windDown == address(0), "ArmadaRedemption: wind-down already set");
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
    /// @param ethRecipient Recipient for the pro-rata ETH share. Must be non-zero when this
    ///        contract holds ETH; passing address(0) reverts in that case so a redeemer
    ///        cannot silently forfeit their ETH share. When the contract holds zero ETH,
    ///        ethRecipient is ignored — allowing ERC20-only redemption against an ETH-less
    ///        treasury. Smart-contract redeemers that cannot receive ETH should pass an EOA
    ///        address they control rather than address(0).
    function redeem(
        uint256 armAmount,
        address[] calldata tokens,
        address ethRecipient
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

        // Distribute pro-rata share of each requested ERC20 token. Each requested asset
        // must yield a non-zero share — partial sweeps that leave some balances at zero
        // would otherwise silently forfeit the redeemer's claim on the un-swept assets,
        // shifting that value to later redeemers (sequential-correctness violation per
        // GOVERNANCE.md §Redemption mechanism). The strict check forces redeemers to
        // wait until all requested assets are swept (or to call again with only the
        // swept subset). Same rule applies to ETH below.
        bool anyPayout;
        for (uint256 i = 0; i < tokens.length; i++) {
            // ARM deposited in this contract is locked permanently — never distributable
            require(tokens[i] != address(0), "ArmadaRedemption: zero token");
            require(tokens[i] != address(armToken), "ArmadaRedemption: cannot redeem ARM");

            // Tokens must be sorted ascending with no duplicates to prevent double-claiming
            if (i > 0) {
                require(tokens[i] > tokens[i - 1], "ArmadaRedemption: tokens not sorted/unique");
            }

            uint256 available = IERC20(tokens[i]).balanceOf(address(this));
            uint256 share = (available * armAmount) / circulating;
            require(share > 0, "ArmadaRedemption: zero share for token");
            IERC20(tokens[i]).safeTransfer(msg.sender, share);
            anyPayout = true;
        }

        // Distribute pro-rata share of ETH if the pool has any. The ethRecipient
        // parameter prevents silent forfeit (audit-81): a smart-contract redeemer
        // unable to receive ETH must route to an EOA explicitly rather than passing
        // a flag that drops their share. When the pool holds zero ETH (legitimate
        // for a USDC-only protocol), ethRecipient is ignored — redemption proceeds
        // against ERC20s alone.
        uint256 ethPayout;
        uint256 ethBalance = address(this).balance;
        if (ethBalance > 0) {
            require(ethRecipient != address(0), "ArmadaRedemption: zero ETH recipient");
            ethPayout = (ethBalance * armAmount) / circulating;
            require(ethPayout > 0, "ArmadaRedemption: zero share for ETH");
            // Assembly call with retSize=0 skips the return-data copy. ethRecipient
            // is user-supplied and could be a contract returning a maximally-sized
            // payload to grief the redeemer's gas — the high-level .call form
            // copies that payload into memory regardless of whether we read it.
            // See audit-86.
            bool success;
            address recipient = ethRecipient;
            uint256 value = ethPayout;
            assembly {
                success := call(gas(), recipient, value, 0, 0, 0, 0)
            }
            require(success, "ArmadaRedemption: ETH transfer failed");
            anyPayout = true;
        }

        // Belt-and-suspenders for the empty-input case (tokens.length == 0 and the
        // ETH pool is empty). The per-asset checks above don't fire on empty input,
        // so this preserves ARM if a caller requests nothing.
        require(anyPayout, "ArmadaRedemption: must request at least one asset");

        emit Redeemed(msg.sender, armAmount, tokens, ethPayout);
    }

    // ============ View Functions ============

    /// @notice Circulating ARM supply for the redemption denominator.
    /// @dev Includes entitled-but-unclaimed ARM in RevenueLock and ArmadaCrowdfund —
    ///      otherwise late releasers/claimers would be denominator-exempt and early
    ///      redeemers would consume the treasury at their expense (see PoC #90).
    ///
    ///      Subtracted from totalSupply:
    ///      1. Treasury balance — ARM the treasury holds is never circulating.
    ///      2. Redemption contract balance — deposited ARM is locked here permanently.
    ///      3. RevenueLock LOCKED portion only — `lockedAtWindDown()` returns the
    ///         unvested portion (totalAllocation × (10000 − unlockBps) / 10000).
    ///         Entitled-unreleased ARM stays in circulating: beneficiaries can call
    ///         release() and then redeem.
    ///      4. Crowdfund UNSOLD-IN-CONTRACT portion only — balance minus armStillOwed.
    ///         Entitled-unclaimed ARM stays in circulating: participants can call
    ///         claim() and then redeem.
    ///
    ///      The crowdfund portion is computed dynamically (balance − armStillOwed)
    ///      rather than as a constant (totalArmSupply − totalAllocatedArm). When
    ///      withdrawUnallocatedArm runs and moves the unsold portion to treasury,
    ///      the dynamic computation goes to 0 (balance and armStillOwed both fall
    ///      by the swept amount), and the treasury balance subtraction picks it up.
    ///      A constant subtraction would double-count the swept portion.
    function circulatingSupply() public view returns (uint256 total) {
        // Batch the totalSupply + treasury/this balanceOf reads into one external
        // CALL via circulatingSupplyOf. Crowdfund balance stays separate so the
        // defensive clamp below (cfStillOwed >= cfBalance) can still surface an
        // accounting inconsistency without underflowing.
        address[] memory excluded = new address[](2);
        excluded[0] = treasury;
        excluded[1] = address(this);
        total = IArmadaTokenRedemption(address(armToken)).circulatingSupplyOf(excluded);

        // RevenueLock locked portion (unvested). Pre-freeze: live ratchet value.
        // Post-freeze: stable across the redemption window.
        total -= IRevenueLockRedemption(revenueLock).lockedAtWindDown();

        // Crowdfund unsold-in-contract: balance - armStillOwed. Goes to 0 once the
        // unsold portion is swept to treasury.
        uint256 cfBalance = armToken.balanceOf(crowdfundContract);
        uint256 cfStillOwed = IArmadaCrowdfundRedemption(crowdfundContract).armStillOwed();
        // Defensive: cfStillOwed should never exceed cfBalance, but clamp to avoid
        // underflow if the crowdfund's accounting ever becomes inconsistent.
        uint256 cfUnsold = cfStillOwed >= cfBalance ? 0 : cfBalance - cfStillOwed;
        total -= cfUnsold;
    }

    /// @notice Accept ETH (from wind-down sweeps)
    receive() external payable {}
}
