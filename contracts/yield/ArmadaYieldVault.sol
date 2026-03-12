// ABOUTME: ERC-20 yield vault wrapping Aave V4 Spoke for shielded yield positions.
// ABOUTME: Tracks per-deposit cost basis for adapter operations to ensure correct yield fee calculation.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

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
 * - Per-deposit cost basis: Adapter deposits track cost basis per nonce to prevent
 *   cross-user cost basis corruption (H-4 fix)
 */
contract ArmadaYieldVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Yield fee in basis points (10% = 1000 bps)
    uint256 public constant YIELD_FEE_BPS = 1000;

    /// @notice Basis points denominator
    uint256 public constant BPS_DENOMINATOR = 10000;

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

    /// @notice Total principal deposited (for yield calculation)
    uint256 public totalPrincipal;

    /// @notice Per-user cost basis per share, scaled by 1e18
    /// @dev Tracks weighted average deposit price for direct (non-adapter) users.
    ///      Adapter deposits use per-nonce tracking instead (see adapterDeposits).
    mapping(address => uint256) public userCostBasisPerShare;

    /// @notice Precision scalar for cost basis (1e18)
    uint256 internal constant COST_BASIS_PRECISION = 1e18;

    // ============ Per-Deposit Cost Basis (Adapter) ============

    /// @notice Tracks cost basis per deposit for adapter operations
    /// @dev Prevents cross-user cost basis corruption when the adapter acts
    ///      on behalf of multiple shielded users (H-4 fix).
    struct AdapterDeposit {
        uint256 costBasisPerShare; // Cost basis at deposit time, scaled by 1e18
        uint256 remainingShares;   // Shares not yet redeemed from this deposit
    }

    /// @notice Monotonically increasing nonce for adapter deposits
    uint256 public adapterDepositNonce;

    /// @notice Per-nonce cost basis and share tracking for adapter deposits
    mapping(uint256 => AdapterDeposit) public adapterDeposits;

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

    /// @notice Emitted when the adapter creates a deposit with per-nonce cost basis tracking
    event AdapterDepositCreated(
        uint256 indexed nonce,
        uint256 shares,
        uint256 costBasisPerShare
    );

    /// @notice Emitted when the adapter redeems shares against a specific deposit nonce
    event AdapterDepositRedeemed(
        uint256 indexed nonce,
        uint256 shares,
        uint256 assets,
        uint256 yieldFee
    );

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event AdapterUpdated(address indexed oldAdapter, address indexed newAdapter);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

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
     * @notice Update treasury address
     * @param _treasury New treasury address
     */
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "ArmadaYieldVault: zero treasury");
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

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
            yieldFee = (yield_ * YIELD_FEE_BPS) / BPS_DENOMINATOR;
        }

        assets = grossAssets - yieldFee;

        // Transfer fee to treasury and record it
        if (yieldFee > 0) {
            underlying.safeTransfer(treasury, yieldFee);
            // Record fee in treasury for tracking
            IArmadaTreasury(treasury).recordFee(address(underlying), owner_, yieldFee);
        }

        // Transfer assets to receiver
        underlying.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner_, assets, shares, yieldFee);
    }

    // ============ Adapter-Specific Functions ============

    /**
     * @notice Deposit underlying assets via the adapter with per-nonce cost basis tracking
     * @dev Only callable by the adapter. Each deposit gets a unique nonce so that
     *      cost basis is tracked per deposit, not per address. This prevents cross-user
     *      cost basis corruption when the adapter acts on behalf of multiple shielded users.
     * @param assets Amount of underlying to deposit
     * @return shares Amount of shares minted
     * @return nonce The deposit nonce for this deposit (used in redeemByNonce)
     */
    function depositForAdapter(uint256 assets) external nonReentrant returns (uint256 shares, uint256 nonce) {
        require(msg.sender == adapter, "ArmadaYieldVault: not adapter");
        require(adapter != address(0), "ArmadaYieldVault: adapter not set");
        require(assets > 0, "ArmadaYieldVault: zero assets");

        // Calculate shares before state changes
        shares = _convertToShares(assets);
        require(shares > 0, "ArmadaYieldVault: zero shares");

        // Assign nonce and track per-deposit cost basis
        nonce = adapterDepositNonce++;
        uint256 costBasis = (assets * COST_BASIS_PRECISION) / shares;
        adapterDeposits[nonce] = AdapterDeposit({
            costBasisPerShare: costBasis,
            remainingShares: shares
        });

        // Track global principal
        totalPrincipal += assets;

        // Transfer underlying from caller (adapter)
        underlying.safeTransferFrom(msg.sender, address(this), assets);

        // Deposit to Aave Spoke
        underlying.approve(address(spoke), assets);
        spoke.supply(reserveId, assets, address(this));

        // Mint shares to adapter
        _mint(msg.sender, shares);

        emit Deposit(msg.sender, msg.sender, assets, shares);
        emit AdapterDepositCreated(nonce, shares, costBasis);
    }

    /**
     * @notice Redeem vault shares via the adapter using a specific deposit nonce
     * @dev Only callable by the adapter. Uses the cost basis recorded at deposit time
     *      for the given nonce, ensuring each user's yield fee is calculated correctly.
     *      Supports partial redemption (redeeming fewer shares than the deposit).
     * @param nonce The deposit nonce from depositForAdapter
     * @param shares Amount of shares to redeem
     * @param receiver Address to receive underlying
     * @return assets Amount of underlying received (after fees)
     */
    function redeemByNonce(
        uint256 nonce,
        uint256 shares,
        address receiver
    ) external nonReentrant returns (uint256 assets) {
        require(msg.sender == adapter, "ArmadaYieldVault: not adapter");
        require(shares > 0, "ArmadaYieldVault: zero shares");
        require(receiver != address(0), "ArmadaYieldVault: zero receiver");

        AdapterDeposit storage dep = adapterDeposits[nonce];
        require(dep.remainingShares >= shares, "ArmadaYieldVault: exceeds deposit");

        // Decrement remaining shares for this deposit
        dep.remainingShares -= shares;

        // Calculate assets from shares (before fees)
        uint256 grossAssets = _convertToAssets(shares);

        // Calculate principal portion using the per-deposit cost basis
        uint256 costBasis = dep.costBasisPerShare;
        uint256 principalPortion = (shares * costBasis) / COST_BASIS_PRECISION;

        // Clamp to totalPrincipal to avoid underflow
        if (principalPortion > totalPrincipal) {
            principalPortion = totalPrincipal;
        }
        totalPrincipal -= principalPortion;

        // Burn shares from adapter
        _burn(msg.sender, shares);

        // Withdraw from Aave Spoke
        spoke.withdraw(reserveId, grossAssets, address(this));

        // Calculate yield and fee
        uint256 yieldFee = 0;
        if (grossAssets > principalPortion) {
            uint256 yield_ = grossAssets - principalPortion;
            yieldFee = (yield_ * YIELD_FEE_BPS) / BPS_DENOMINATOR;
        }

        assets = grossAssets - yieldFee;

        // Transfer fee to treasury and record it
        if (yieldFee > 0) {
            underlying.safeTransfer(treasury, yieldFee);
            IArmadaTreasury(treasury).recordFee(address(underlying), msg.sender, yieldFee);
        }

        // Transfer assets to receiver
        underlying.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, msg.sender, assets, shares, yieldFee);
        emit AdapterDepositRedeemed(nonce, shares, assets, yieldFee);
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
            uint256 yieldFee = (yield_ * YIELD_FEE_BPS) / BPS_DENOMINATOR;
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
