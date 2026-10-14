// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../fees/IArmadaFeeModule.sol";

/**
 * @title IAaveSpoke
 * @notice Interface for Aave V4 Spoke (or MockAaveSpoke)
 * @dev Matches the ISpokeBase interface from Aave V4
 */
interface IAaveSpoke {
    function supply(
        uint256 reserveId,
        uint256 amount,
        address onBehalfOf
    ) external returns (uint256 shares, uint256 supplied);

    function withdraw(
        uint256 reserveId,
        uint256 amount,
        address onBehalfOf
    ) external returns (uint256 shares, uint256 withdrawn);

    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);
    function getUserSuppliedShares(uint256 reserveId, address user) external view returns (uint256);
    function convertToAssets(uint256 reserveId, uint256 shares) external view returns (uint256);
    function convertToShares(uint256 reserveId, uint256 assets) external view returns (uint256);
    function getUnderlyingAsset(uint256 reserveId) external view returns (address);
}

/**
 * @title ArmadaYieldVault
 * @notice ERC-20 wrapper around Aave V4 Spoke for shielded yield.
 * @dev Issues non-rebasing shares compatible with shielded notes.
 *
 *      Fee accounting model:
 *      - `pendingProtocolFee()` always reports the protocol's currently-owed cut of yield.
 *      - `_convertToAssets`/`_convertToShares` net `pendingProtocolFee` out of `totalAssets`,
 *         so share price reflects what users can actually claim regardless of whether the
 *         pending cut has been swept yet. Deposits price correctly without an in-line settle.
 *      - `redeem` settles the pending cut before paying out (math demands it: a user pulling
 *         their proportional share from the spoke otherwise erodes the protocol's claim).
 *      - `harvestProtocolFee()` is the permissionless cadence-gated entrypoint for sweeping
 *         the protocol's cut to treasury when nobody redeems. Cadence is read from
 *         `ArmadaFeeModule.getHarvestInterval()` (governance-owned, default 7 days).
 *
 *      Treasury (ArmadaTreasuryGov) receives fee via plain `safeTransfer`; `feeModule`,
 *      when wired, records the fee for RevenueCounter accounting.
 */
contract ArmadaYieldVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Basis points denominator
    uint256 public constant BPS_DENOMINATOR = 10000;

    /// @notice Minimum yield fee: 1% (100 bps)
    uint256 public constant MIN_YIELD_FEE_BPS = 100;

    /// @notice Maximum yield fee: 50% (5000 bps)
    uint256 public constant MAX_YIELD_FEE_BPS = 5000;

    /// @notice Fallback harvest cadence used when `feeModule` is unset (test paths only).
    /// @dev In production the fee module is always wired, so the effective cadence comes
    ///      from `IArmadaFeeModule.getHarvestInterval()` and this constant is unused.
    uint256 public constant FALLBACK_HARVEST_INTERVAL = 7 days;

    /// @notice Yield fee in basis points, governable via extended proposal.
    uint256 public yieldFeeBps = 1000; // 10% at launch

    // ============ Immutables ============

    /// @notice The Aave Spoke contract (or MockAaveSpoke)
    IAaveSpoke public immutable spoke;

    /// @notice The underlying token (USDC)
    IERC20 public immutable underlying;

    /// @notice The reserve ID in the Spoke
    uint256 public immutable reserveId;

    /// @notice Treasury address for yield fees (ArmadaTreasuryGov). Set once at deployment.
    address public immutable treasury;

    // ============ State ============

    /// @notice Contract owner
    address public owner;

    /// @notice Privileged adapter (can bypass fees)
    address public adapter;

    /// @notice Fee module address (ArmadaFeeModule proxy) for centralized yield fee config.
    /// @dev When address(0), uses local yieldFeeBps. When set, reads fee from fee module.
    address public feeModule;

    /// @notice Aggregate cost-basis principal of outstanding shares.
    /// @dev Informational only (paired with per-user cost basis for `getUserYield`); the protocol
    ///      fee is computed from lifetime flows, not from cost basis (see `_lifetimeYield`).
    uint256 public totalPrincipal;

    /// @notice Lifetime protocol fee swept to treasury (in underlying units).
    uint256 public cumulativeProtocolFee;

    /// @notice Timestamp of the last protocol fee settle (via redeem or external harvest).
    uint256 public lastHarvestTime;

    /// @notice Per-user cost basis per share, scaled by 1e18
    /// @dev Tracks weighted average deposit price. On deposit, the cost basis is updated
    ///      as a weighted average of existing and new shares. On redeem, principal is
    ///      computed as shares * costBasis / COST_BASIS_PRECISION, which is independent
    ///      of balanceOf() and works correctly with the ArmadaYieldAdapter pattern.
    mapping(address => uint256) public userCostBasisPerShare;

    /// @notice Precision scalar for cost basis (1e18)
    uint256 internal constant COST_BASIS_PRECISION = 1e18;

    /// @notice Lifetime underlying deposited by all depositors.
    uint256 public totalDeposited;

    /// @notice Lifetime underlying paid out to redeemers (protocol fees excluded).
    uint256 public totalPaidOut;

    /// @notice Highest lifetime gross yield recorded at a fee checkpoint (underlying units).
    /// @dev Fees accrue only on yield above this mark, so yield that merely recovers an earlier
    ///      loss is not charged twice.
    uint256 public yieldHighWaterMark;

    /// @notice Lifetime protocol fee accrued at checkpoints, collected or not (underlying units).
    uint256 public accruedProtocolFee;

    // ============ Events ============

    event Deposit(
        address indexed caller,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );

    event Withdraw(
        address indexed caller,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares,
        uint256 yieldFee
    );

    event AdapterUpdated(address indexed oldAdapter, address indexed newAdapter);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event YieldFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeModuleUpdated(address indexed oldModule, address indexed newModule);
    event ProtocolFeeHarvested(uint256 amount, uint256 cumulativeAfter, uint256 settledAt);

    // ============ Modifiers ============

    modifier onlyOwner() {
        require(msg.sender == owner, "ArmadaYieldVault: not owner");
        _;
    }

    // ============ Constructor ============

    /**
     * @notice Initialize the vault
     * @param _spoke The Aave Spoke contract address
     * @param _reserveId The reserve ID for USDC in the Spoke
     * @param _treasury Address to receive yield fees
     * @param _name ERC-20 token name
     * @param _symbol ERC-20 token symbol
     */
    constructor(
        address _spoke,
        uint256 _reserveId,
        address _treasury,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) {
        require(_spoke != address(0), "ArmadaYieldVault: zero spoke");
        require(_treasury != address(0), "ArmadaYieldVault: zero treasury");

        spoke = IAaveSpoke(_spoke);
        reserveId = _reserveId;
        underlying = IERC20(spoke.getUnderlyingAsset(_reserveId));
        treasury = _treasury;
        owner = msg.sender;
        lastHarvestTime = block.timestamp;
    }

    // ============ Admin Functions ============

    /**
     * @notice Set privileged adapter address
     * @param _adapter New adapter address (can be zero to disable)
     */
    function setAdapter(address _adapter) external onlyOwner {
        emit AdapterUpdated(adapter, _adapter);
        adapter = _adapter;
    }

    /**
     * @notice Transfer ownership
     * @param newOwner New owner address
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ArmadaYieldVault: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /**
     * @notice Update yield fee basis points. Governance-only (via timelock).
     * @dev Reverts when feeModule is set — governance should use fee module instead.
     * @param _feeBps New yield fee in basis points (bounded by MIN/MAX)
     */
    function setYieldFeeBps(uint256 _feeBps) external onlyOwner {
        require(feeModule == address(0), "ArmadaYieldVault: use fee module");
        require(_feeBps >= MIN_YIELD_FEE_BPS, "ArmadaYieldVault: below min fee");
        require(_feeBps <= MAX_YIELD_FEE_BPS, "ArmadaYieldVault: above max fee");
        // Lock in the fee on yield earned so far at the old rate; the new rate applies only after.
        _checkpointProtocolFee();
        emit YieldFeeUpdated(yieldFeeBps, _feeBps);
        yieldFeeBps = _feeBps;
    }

    /**
     * @notice Set the fee module address (ArmadaFeeModule proxy)
     * @param _feeModule Address of the fee module (or address(0) to use local yieldFeeBps)
     */
    function setFeeModule(address _feeModule) external onlyOwner {
        // Switching the rate source changes the effective rate; lock in yield so far at the old one.
        _checkpointProtocolFee();
        emit FeeModuleUpdated(feeModule, _feeModule);
        feeModule = _feeModule;
    }

    // ============ Protocol Fee Harvest ============

    /**
     * @notice Permissionless trigger to sweep the protocol's pending yield cut to treasury.
     * @dev Cadence is read from `ArmadaFeeModule.getHarvestInterval()` (governance-owned).
     *      Reverts if the interval since the last settle has not elapsed.
     *      Calling `redeem` between harvests also settles, so the timer can be reset earlier.
     */
    function harvestProtocolFee() external nonReentrant {
        require(
            block.timestamp >= lastHarvestTime + _effectiveHarvestInterval(),
            "ArmadaYieldVault: interval not met"
        );
        _settleProtocolFee();
    }

    /**
     * @notice Amount of yield-fee that the next settle would withdraw.
     * @return Pending protocol fee in underlying units.
     */
    function pendingProtocolFee() external view returns (uint256) {
        return _pendingProtocolFee();
    }

    /**
     * @notice Earliest timestamp at which the next permissionless harvest is allowed.
     */
    function nextHarvestTime() external view returns (uint256) {
        return lastHarvestTime + _effectiveHarvestInterval();
    }

    /**
     * @notice The harvest cadence currently in force (seconds).
     */
    function harvestInterval() external view returns (uint256) {
        return _effectiveHarvestInterval();
    }

    // ============ Core Functions ============

    /**
     * @notice Deposit underlying assets and receive vault shares
     * @param assets Amount of underlying to deposit
     * @param receiver Address to receive shares
     * @return shares Amount of shares minted
     */
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        require(assets > 0, "ArmadaYieldVault: zero assets");
        require(receiver != address(0), "ArmadaYieldVault: zero receiver");

        // No inline settle on deposit: `_convertToShares` already nets `pendingProtocolFee`
        // out of `totalAssets`, so the depositor pays the correct user-side price and the
        // protocol's pending claim is preserved.
        shares = _convertToShares(assets);
        require(shares > 0, "ArmadaYieldVault: zero shares");

        totalDeposited += assets;

        // Track principal via weighted average cost basis (informational; see totalPrincipal)
        totalPrincipal += assets;
        uint256 existingShares = balanceOf(receiver);
        if (existingShares == 0) {
            // First deposit: cost basis = assets per share
            userCostBasisPerShare[receiver] = (assets * COST_BASIS_PRECISION) / shares;
        } else {
            // Weighted average: ((oldBasis * oldShares) + (assets * PRECISION)) / (oldShares + newShares)
            uint256 oldBasis = userCostBasisPerShare[receiver];
            userCostBasisPerShare[receiver] = (oldBasis * existingShares + assets * COST_BASIS_PRECISION) / (existingShares + shares);
        }

        // Transfer underlying from caller
        underlying.safeTransferFrom(msg.sender, address(this), assets);

        // Deposit to Aave Spoke
        underlying.approve(address(spoke), assets);
        spoke.supply(reserveId, assets, address(this));

        // Mint shares to receiver
        _mint(receiver, shares);

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /**
     * @notice Redeem vault shares for underlying assets.
     * @dev Settles the protocol's pending fee at the top of the call. Without this, a
     *      redeeming user would pull their proportional share of `totalAssets` from the
     *      spoke without the protocol's cut being withdrawn — eroding the protocol's
     *      tracked claim. After settle, `_convertToAssets` returns the user-claimable
     *      payout directly (pending is zero). The `yieldFee` field in `Withdraw` is
     *      retained for log-parser compatibility but is always 0.
     */
    function redeem(
        uint256 shares,
        address receiver,
        address owner_
    ) external nonReentrant returns (uint256 assets) {
        require(shares > 0, "ArmadaYieldVault: zero shares");
        require(receiver != address(0), "ArmadaYieldVault: zero receiver");

        // Check allowance if not owner
        if (msg.sender != owner_) {
            uint256 allowed = allowance(owner_, msg.sender);
            require(allowed >= shares, "ArmadaYieldVault: insufficient allowance");
            _approve(owner_, msg.sender, allowed - shares);
        }

        // Settle pending protocol fee BEFORE pricing the redemption. After settle,
        // _convertToAssets returns the user-claimable value (protocol's cut is gone).
        _settleProtocolFee();

        // Now compute payout against the post-settle share price.
        assets = _convertToAssets(shares);

        // Decrement aggregate principal by the user's cost-basis portion. The per-user
        // cost basis (userCostBasisPerShare) is intentionally NOT decremented — it is
        // an average price that stays valid for the user's remaining shares.
        uint256 costBasis = userCostBasisPerShare[owner_];
        uint256 principalPortion = (shares * costBasis) / COST_BASIS_PRECISION;
        if (principalPortion > totalPrincipal) {
            principalPortion = totalPrincipal;
        }
        totalPrincipal -= principalPortion;

        totalPaidOut += assets;

        // Burn shares before external call
        _burn(owner_, shares);

        // Withdraw the user's portion from the spoke and forward to receiver
        spoke.withdraw(reserveId, assets, address(this));
        underlying.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner_, assets, shares, 0);
    }

    // ============ Protocol Fee Settlement (internal) ============

    /**
     * @dev Lifetime gross yield: everything still in the vault, swept to the treasury or paid to
     *      redeemers, minus everything deposited. Deposits, redemptions and fee sweeps leave it
     *      unchanged; only yield (or a loss) in the spoke moves it. It does not depend on who
     *      deposited or who redeems, so shares changing hands do not affect the fee.
     */
    function _lifetimeYield() internal view returns (uint256) {
        uint256 accountedFor = totalAssets() + cumulativeProtocolFee + totalPaidOut;
        return accountedFor > totalDeposited ? accountedFor - totalDeposited : 0;
    }

    /// @dev Fee on yield earned above the high-water mark since the last checkpoint, at the
    ///      current rate.
    function _unaccruedProtocolFee() internal view returns (uint256) {
        uint256 lifetime = _lifetimeYield();
        if (lifetime <= yieldHighWaterMark) return 0;
        return ((lifetime - yieldHighWaterMark) * _effectiveYieldFeeBps()) / BPS_DENOMINATOR;
    }

    /**
     * @dev Locks in the fee on yield earned above the high-water mark at the current rate.
     *      Run before every settle and before every rate change, so a new rate applies only to
     *      yield earned after it. A rate change made inside the fee module cannot trigger this;
     *      it applies to yield earned since the vault's last checkpoint (at most one harvest
     *      interval when harvests run on schedule).
     */
    function _checkpointProtocolFee() internal {
        uint256 lifetime = _lifetimeYield();
        if (lifetime > yieldHighWaterMark) {
            accruedProtocolFee += ((lifetime - yieldHighWaterMark) * _effectiveYieldFeeBps()) / BPS_DENOMINATOR;
            yieldHighWaterMark = lifetime;
        }
    }

    /// @dev Pending protocol fee in underlying units: accrued plus not-yet-accrued fee, minus what
    ///      has already been swept.
    function _pendingProtocolFee() internal view returns (uint256) {
        uint256 owed = accruedProtocolFee + _unaccruedProtocolFee();
        return owed > cumulativeProtocolFee ? owed - cumulativeProtocolFee : 0;
    }

    /**
     * @dev Checkpoint, then sweep any pending protocol fee from the spoke to the treasury.
     *      Called by redeem and the external harvestProtocolFee (cadence-gated).
     */
    function _settleProtocolFee() internal {
        _checkpointProtocolFee();
        uint256 fee = accruedProtocolFee - cumulativeProtocolFee;
        if (fee > 0) {
            spoke.withdraw(reserveId, fee, address(this));
            underlying.safeTransfer(treasury, fee);
            cumulativeProtocolFee += fee;
            if (feeModule != address(0)) {
                IArmadaFeeModule(feeModule).recordYieldFee(fee);
            }
            emit ProtocolFeeHarvested(fee, cumulativeProtocolFee, block.timestamp);
        }
        lastHarvestTime = block.timestamp;
    }

    /// @dev Effective yield fee bps — fee module override if wired, else local `yieldFeeBps`.
    function _effectiveYieldFeeBps() internal view returns (uint256) {
        if (feeModule != address(0)) {
            return IArmadaFeeModule(feeModule).getYieldFeeBps();
        }
        return yieldFeeBps;
    }

    /// @dev Effective harvest cadence — fee module override if wired, else FALLBACK constant.
    function _effectiveHarvestInterval() internal view returns (uint256) {
        if (feeModule != address(0)) {
            return IArmadaFeeModule(feeModule).getHarvestInterval();
        }
        return FALLBACK_HARVEST_INTERVAL;
    }

    // ============ View Functions ============

    /**
     * @notice Get total assets in the vault (including yield)
     * @return Total underlying assets
     */
    function totalAssets() public view returns (uint256) {
        return spoke.getUserSuppliedAssets(reserveId, address(this));
    }

    /**
     * @notice Convert assets to shares
     * @param assets Amount of underlying assets
     * @return shares Amount of shares
     */
    function convertToShares(uint256 assets) external view returns (uint256) {
        return _convertToShares(assets);
    }

    /**
     * @notice Convert shares to assets
     * @param shares Amount of shares
     * @return assets Amount of underlying assets
     */
    function convertToAssets(uint256 shares) external view returns (uint256) {
        return _convertToAssets(shares);
    }

    /**
     * @notice Get user's total assets (shares converted to underlying)
     * @param user User address
     * @return assets User's underlying assets (before fees)
     */
    function getUserAssets(address user) external view returns (uint256) {
        return _convertToAssets(balanceOf(user));
    }

    /**
     * @notice Get user's accrued yield
     * @param user User address
     * @return yield_ User's yield (assets - principal)
     */
    function getUserYield(address user) external view returns (uint256 yield_) {
        uint256 userShares = balanceOf(user);
        uint256 assets = _convertToAssets(userShares);
        uint256 principal = (userShares * userCostBasisPerShare[user]) / COST_BASIS_PRECISION;
        yield_ = assets > principal ? assets - principal : 0;
    }

    /**
     * @notice Preview redeem — assets the holder would receive right now.
     * @dev Per-user fee math is gone: `_convertToAssets` already nets `pendingProtocolFee`
     *      out of `totalAssets`, so the returned figure is what `redeem` will pay (modulo
     *      block-level yield drift). The `owner_` parameter is retained for ABI stability.
     */
    function previewRedeem(uint256 shares, address /* owner_ */) external view returns (uint256) {
        return _convertToAssets(shares);
    }

    /**
     * @notice Get the underlying token decimals
     * @return Token decimals (6 for USDC)
     */
    function decimals() public view virtual override returns (uint8) {
        // USDC has 6 decimals
        return 6;
    }

    // ============ Internal Functions ============

    /**
     * @notice Convert assets to shares at the current user-side exchange rate.
     * @dev Denominator is `totalAssets - pendingProtocolFee` so depositors pay the same
     *      price whether or not a settle has occurred recently.
     */
    function _convertToShares(uint256 assets) internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            return assets;
        }
        uint256 userClaimable = _userClaimableAssets();
        if (userClaimable == 0) {
            return assets;
        }
        return (assets * supply) / userClaimable;
    }

    /**
     * @notice Convert shares to assets at the current user-side exchange rate.
     * @dev Numerator is `totalAssets - pendingProtocolFee` so redeemers and view callers
     *      see the post-fee value regardless of whether the cut has been swept yet.
     */
    function _convertToAssets(uint256 shares) internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            return shares;
        }
        return (shares * _userClaimableAssets()) / supply;
    }

    /// @dev Spoke balance minus the protocol's currently-pending fee claim.
    function _userClaimableAssets() internal view returns (uint256) {
        uint256 total = totalAssets();
        uint256 pending = _pendingProtocolFee();
        return pending >= total ? 0 : total - pending;
    }
}
