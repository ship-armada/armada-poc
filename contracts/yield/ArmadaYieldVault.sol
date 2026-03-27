// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../fees/IArmadaFeeModule.sol";

/**
 * @title IArmadaTreasury
 * @notice Interface for ArmadaTreasury fee recording
 */
interface IArmadaTreasury {
    function recordFee(address token, address from, uint256 amount) external;
}

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
 * @notice ERC-20 wrapper around Aave V4 Spoke for shielded yield
 * @dev Issues non-rebasing shares compatible with shielded notes.
 *      Tracks principal to calculate yield and applies 10% yield fee on redemption.
 *
 * Key properties:
 * - Non-rebasing: Share balances stay constant, share value increases
 * - Principal tracking: Accurately calculates yield at redemption
 * - Yield fee: 10% of yield goes to treasury on redemption
 * - Privileged path: Adapter can deposit/redeem without fees
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

    /// @notice Yield fee in basis points, governable via extended proposal.
    uint256 public yieldFeeBps = 1000; // 10% at launch

    // ============ Immutables ============

    /// @notice The Aave Spoke contract (or MockAaveSpoke)
    IAaveSpoke public immutable spoke;

    /// @notice The underlying token (USDC)
    IERC20 public immutable underlying;

    /// @notice The reserve ID in the Spoke
    uint256 public immutable reserveId;

    // ============ State ============

    /// @notice Treasury address for yield fees
    address public treasury;

    /// @notice Contract owner
    address public owner;

    /// @notice Privileged adapter (can bypass fees)
    address public adapter;

    /// @notice Fee module address (ArmadaFeeModule proxy) for centralized yield fee config.
    /// @dev When address(0), uses local yieldFeeBps. When set, reads fee from fee module.
    address public feeModule;

    /// @notice Total principal deposited (for yield calculation)
    uint256 public totalPrincipal;

    /// @notice Per-user cost basis per share, scaled by 1e18
    /// @dev Tracks weighted average deposit price. On deposit, the cost basis is updated
    ///      as a weighted average of existing and new shares. On redeem, principal is
    ///      computed as shares * costBasis / COST_BASIS_PRECISION, which is independent
    ///      of balanceOf() and works correctly with the ArmadaYieldAdapter pattern.
    mapping(address => uint256) public userCostBasisPerShare;

    /// @notice Precision scalar for cost basis (1e18)
    uint256 internal constant COST_BASIS_PRECISION = 1e18;

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
        emit YieldFeeUpdated(yieldFeeBps, _feeBps);
        yieldFeeBps = _feeBps;
    }

    /**
     * @notice Set the fee module address (ArmadaFeeModule proxy)
     * @param _feeModule Address of the fee module (or address(0) to use local yieldFeeBps)
     */
    function setFeeModule(address _feeModule) external onlyOwner {
        emit FeeModuleUpdated(feeModule, _feeModule);
        feeModule = _feeModule;
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

        // Calculate shares before state changes
        shares = _convertToShares(assets);
        require(shares > 0, "ArmadaYieldVault: zero shares");

        // Track principal via weighted average cost basis
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
     * @notice Redeem vault shares for underlying assets
     * @dev Applies 10% yield fee unless caller is privileged adapter
     * @param shares Amount of shares to redeem
     * @param receiver Address to receive underlying
     * @param owner_ Address that owns the shares
     * @return assets Amount of underlying received (after fees)
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

        // Calculate assets from shares (before fees)
        uint256 grossAssets = _convertToAssets(shares);

        // Calculate principal portion using cost basis (independent of balanceOf)
        uint256 costBasis = userCostBasisPerShare[owner_];
        uint256 principalPortion = (shares * costBasis) / COST_BASIS_PRECISION;

        // Clamp to totalPrincipal to avoid underflow
        if (principalPortion > totalPrincipal) {
            principalPortion = totalPrincipal;
        }
        totalPrincipal -= principalPortion;
        // Note: costBasisPerShare is not decremented on redeem - it's an average
        // price that stays valid for remaining shares

        // Burn shares
        _burn(owner_, shares);

        // Withdraw from Aave Spoke
        spoke.withdraw(reserveId, grossAssets, address(this));

        // Calculate yield and fee
        // Note: Fees are always applied. The adapter privilege was removed
        // because the privacy-preserving flow applies fees at the user level.
        uint256 yieldFee = 0;
        if (grossAssets > principalPortion) {
            uint256 yield_ = grossAssets - principalPortion;
            // Read yield fee rate from fee module when set, otherwise use local yieldFeeBps
            uint256 effectiveFeeBps = feeModule != address(0)
                ? IArmadaFeeModule(feeModule).getYieldFeeBps()
                : yieldFeeBps;
            yieldFee = (yield_ * effectiveFeeBps) / BPS_DENOMINATOR;
        }

        assets = grossAssets - yieldFee;

        // Transfer fee to treasury and record it
        if (yieldFee > 0) {
            underlying.safeTransfer(treasury, yieldFee);
            if (feeModule != address(0)) {
                // Record yield fee in centralized fee module for RevenueCounter
                IArmadaFeeModule(feeModule).recordYieldFee(yieldFee);
            } else {
                // Fallback path: record fee in treasury for tracking
                IArmadaTreasury(treasury).recordFee(address(underlying), owner_, yieldFee);
            }
        }

        // Transfer assets to receiver
        underlying.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner_, assets, shares, yieldFee);
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
     * @notice Preview redeem - get assets after fees
     * @param shares Amount of shares to redeem
     * @param owner_ Address that owns the shares
     * @return assets Amount of underlying after fees
     */
    function previewRedeem(uint256 shares, address owner_) external view returns (uint256 assets) {
        uint256 grossAssets = _convertToAssets(shares);

        // Calculate principal portion using cost basis
        uint256 costBasis = userCostBasisPerShare[owner_];
        uint256 principalPortion = (shares * costBasis) / COST_BASIS_PRECISION;

        // Calculate fee
        if (grossAssets > principalPortion) {
            uint256 yield_ = grossAssets - principalPortion;
            uint256 effectiveFeeBps = feeModule != address(0)
                ? IArmadaFeeModule(feeModule).getYieldFeeBps()
                : yieldFeeBps;
            uint256 yieldFee = (yield_ * effectiveFeeBps) / BPS_DENOMINATOR;
            assets = grossAssets - yieldFee;
        } else {
            assets = grossAssets;
        }
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
     * @notice Convert assets to shares using current exchange rate
     */
    function _convertToShares(uint256 assets) internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            // 1:1 for first deposit
            return assets;
        }
        uint256 total = totalAssets();
        if (total == 0) {
            return assets;
        }
        return (assets * supply) / total;
    }

    /**
     * @notice Convert shares to assets using current exchange rate
     */
    function _convertToAssets(uint256 shares) internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            return shares;
        }
        return (shares * totalAssets()) / supply;
    }
}
