// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title IMintable
 * @notice Interface for mintable tokens (MockUSDCV2)
 */
interface IMintable {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockAaveSpoke
 * @notice Simplified Aave V4 Spoke mock for local devnet testing
 * @dev Implements the same interface as real Aave V4 ISpokeBase so frontends
 *      can switch between mock and real Aave with zero code changes.
 *
 * Key differences from real Aave:
 * - No borrowing/debt mechanics (yield is simulated via configurable APY)
 * - Yield is minted on-demand (requires mintable token like MockUSDCV2)
 * - No liquidations, health factors, or risk parameters
 * - Single admin, no AccessManager complexity
 *
 * The share math uses the same RAY precision (27 decimals) as real Aave.
 */
contract MockAaveSpoke {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice RAY precision (27 decimals) - matches Aave's WadRayMath
    uint256 public constant RAY = 1e27;

    /// @notice Seconds per year for APY calculations
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ============ Structs ============

    struct Reserve {
        IERC20 underlying;              // The token (e.g., MockUSDCV2)
        uint256 totalShares;            // Total shares issued
        uint256 totalDeposited;         // Total principal deposited (for tracking)
        uint256 liquidityIndex;         // Current index (RAY precision)
        uint256 lastUpdateTimestamp;    // Last yield accrual
        uint256 annualYieldBps;         // APY in basis points (e.g., 500 = 5%)
        bool mintableYield;             // If true, mint yield on withdrawal
    }

    // ============ State ============

    /// @notice Reserve data by reserveId
    mapping(uint256 => Reserve) public reserves;

    /// @notice User shares by reserveId and user address
    mapping(uint256 => mapping(address => uint256)) public userShares;

    /// @notice Contract owner (for admin functions)
    address public owner;

    /// @notice Next reserve ID
    uint256 public nextReserveId;

    // ============ Events (match Aave V4 signatures) ============

    event Supply(
        uint256 indexed reserveId,
        address indexed caller,
        address indexed user,
        uint256 suppliedShares,
        uint256 suppliedAmount
    );

    event Withdraw(
        uint256 indexed reserveId,
        address indexed caller,
        address indexed user,
        uint256 withdrawnShares,
        uint256 withdrawnAmount
    );

    event ReserveAdded(
        uint256 indexed reserveId,
        address indexed underlying,
        uint256 annualYieldBps
    );

    event YieldRateUpdated(uint256 indexed reserveId, uint256 newYieldBps);

    event YieldMinted(uint256 indexed reserveId, uint256 amount);

    // ============ Modifiers ============

    modifier onlyOwner() {
        require(msg.sender == owner, "MockAaveSpoke: not owner");
        _;
    }

    // ============ Constructor ============

    constructor() {
        owner = msg.sender;
    }

    // ============ Admin Functions ============

    /**
     * @notice Add a new reserve
     * @param underlying The token address (must be mintable for yield)
     * @param annualYieldBps Annual yield in basis points (500 = 5% APY)
     * @param mintableYield Whether to mint yield tokens on withdrawal
     * @return reserveId The ID of the new reserve
     */
    function addReserve(
        address underlying,
        uint256 annualYieldBps,
        bool mintableYield
    ) external onlyOwner returns (uint256 reserveId) {
        reserveId = nextReserveId++;

        reserves[reserveId] = Reserve({
            underlying: IERC20(underlying),
            totalShares: 0,
            totalDeposited: 0,
            liquidityIndex: RAY,
            lastUpdateTimestamp: block.timestamp,
            annualYieldBps: annualYieldBps,
            mintableYield: mintableYield
        });

        emit ReserveAdded(reserveId, underlying, annualYieldBps);
    }

    /**
     * @notice Update yield rate for a reserve
     * @param reserveId The reserve to update
     * @param annualYieldBps New annual yield in basis points
     */
    function setYieldRate(uint256 reserveId, uint256 annualYieldBps) external onlyOwner {
        Reserve storage reserve = reserves[reserveId];
        require(address(reserve.underlying) != address(0), "MockAaveSpoke: reserve not found");

        // Accrue yield at old rate before changing
        _accrueYield(reserve);

        reserve.annualYieldBps = annualYieldBps;
        emit YieldRateUpdated(reserveId, annualYieldBps);
    }

    /**
     * @notice Transfer ownership
     * @param newOwner New owner address
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "MockAaveSpoke: zero address");
        owner = newOwner;
    }

    // ============ User Functions (Aave V4 Interface) ============

    /**
     * @notice Supply assets to the reserve
     * @dev EXACT same signature as Aave V4 ISpokeBase.supply()
     * @param reserveId The reserve to supply to
     * @param amount Amount of underlying to supply
     * @param onBehalfOf Address to credit shares to
     * @return shares Amount of shares minted
     * @return supplied Amount of underlying supplied
     */
    function supply(
        uint256 reserveId,
        uint256 amount,
        address onBehalfOf
    ) external returns (uint256 shares, uint256 supplied) {
        Reserve storage reserve = reserves[reserveId];
        require(address(reserve.underlying) != address(0), "MockAaveSpoke: reserve not found");
        require(amount > 0, "MockAaveSpoke: zero amount");

        // Accrue yield before state changes
        _accrueYield(reserve);

        // Calculate shares using current index
        shares = (amount * RAY) / reserve.liquidityIndex;
        require(shares > 0, "MockAaveSpoke: zero shares");

        // Update state
        userShares[reserveId][onBehalfOf] += shares;
        reserve.totalShares += shares;
        reserve.totalDeposited += amount;

        // Transfer tokens in
        reserve.underlying.safeTransferFrom(msg.sender, address(this), amount);

        supplied = amount;
        emit Supply(reserveId, msg.sender, onBehalfOf, shares, supplied);
    }

    /**
     * @notice Withdraw assets from the reserve
     * @dev EXACT same signature as Aave V4 ISpokeBase.withdraw()
     * @param reserveId The reserve to withdraw from
     * @param amount Amount of underlying to withdraw (use type(uint256).max for all)
     * @param onBehalfOf Address to debit shares from (must be caller)
     * @return shares Amount of shares burned
     * @return withdrawn Amount of underlying withdrawn
     */
    function withdraw(
        uint256 reserveId,
        uint256 amount,
        address onBehalfOf
    ) external returns (uint256 shares, uint256 withdrawn) {
        // For simplicity, only allow withdrawing own funds
        require(msg.sender == onBehalfOf, "MockAaveSpoke: can only withdraw own funds");

        Reserve storage reserve = reserves[reserveId];
        require(address(reserve.underlying) != address(0), "MockAaveSpoke: reserve not found");

        // Accrue yield before state changes
        _accrueYield(reserve);

        // Get user's total assets (including yield)
        uint256 userAssets = _getUserAssets(reserve, onBehalfOf, reserveId);

        // Handle max withdrawal
        if (amount == type(uint256).max) {
            amount = userAssets;
        }
        require(amount > 0, "MockAaveSpoke: zero amount");
        require(amount <= userAssets, "MockAaveSpoke: insufficient balance");

        // Calculate shares to burn
        shares = (amount * RAY) / reserve.liquidityIndex;

        // Handle rounding: if withdrawing all, burn all shares
        uint256 userShareBalance = userShares[reserveId][onBehalfOf];
        if (amount == userAssets) {
            shares = userShareBalance;
        }
        require(shares <= userShareBalance, "MockAaveSpoke: insufficient shares");

        // Update state
        userShares[reserveId][onBehalfOf] -= shares;
        reserve.totalShares -= shares;

        // Calculate how much is yield vs principal
        uint256 currentBalance = reserve.underlying.balanceOf(address(this));

        if (amount > currentBalance && reserve.mintableYield) {
            // Need to mint yield tokens
            uint256 toMint = amount - currentBalance;
            IMintable(address(reserve.underlying)).mint(address(this), toMint);
            emit YieldMinted(reserveId, toMint);
        }

        // Transfer tokens out
        reserve.underlying.safeTransfer(msg.sender, amount);

        withdrawn = amount;
        emit Withdraw(reserveId, msg.sender, onBehalfOf, shares, withdrawn);
    }

    // ============ View Functions (Aave V4 Interface) ============

    /**
     * @notice Get user's supplied assets including accrued yield
     * @dev EXACT same signature as Aave V4 ISpokeBase.getUserSuppliedAssets()
     * @param reserveId The reserve to query
     * @param user The user address
     * @return The amount of underlying assets (principal + yield)
     */
    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256) {
        Reserve storage reserve = reserves[reserveId];
        if (address(reserve.underlying) == address(0)) return 0;

        uint256 currentIndex = _currentIndex(reserve);
        return (userShares[reserveId][user] * currentIndex) / RAY;
    }

    /**
     * @notice Get user's share balance
     * @dev EXACT same signature as Aave V4 ISpokeBase.getUserSuppliedShares()
     * @param reserveId The reserve to query
     * @param user The user address
     * @return The amount of shares held
     */
    function getUserSuppliedShares(uint256 reserveId, address user) external view returns (uint256) {
        return userShares[reserveId][user];
    }

    /**
     * @notice Get total supplied assets in reserve (including yield)
     * @param reserveId The reserve to query
     * @return The total underlying assets
     */
    function getReserveSuppliedAssets(uint256 reserveId) external view returns (uint256) {
        Reserve storage reserve = reserves[reserveId];
        if (address(reserve.underlying) == address(0)) return 0;

        uint256 currentIndex = _currentIndex(reserve);
        return (reserve.totalShares * currentIndex) / RAY;
    }

    /**
     * @notice Get total shares in reserve
     * @param reserveId The reserve to query
     * @return The total shares issued
     */
    function getReserveSuppliedShares(uint256 reserveId) external view returns (uint256) {
        return reserves[reserveId].totalShares;
    }

    /**
     * @notice Get reserve details
     * @param reserveId The reserve to query
     */
    function getReserveData(uint256 reserveId) external view returns (
        address underlying,
        uint256 totalShares,
        uint256 totalDeposited,
        uint256 liquidityIndex,
        uint256 lastUpdateTimestamp,
        uint256 annualYieldBps,
        bool mintableYield
    ) {
        Reserve storage reserve = reserves[reserveId];
        return (
            address(reserve.underlying),
            reserve.totalShares,
            reserve.totalDeposited,
            _currentIndex(reserve),
            reserve.lastUpdateTimestamp,
            reserve.annualYieldBps,
            reserve.mintableYield
        );
    }

    /**
     * @notice Get current liquidity index for a reserve
     * @param reserveId The reserve to query
     * @return The current liquidity index (RAY precision)
     */
    function getReserveLiquidityIndex(uint256 reserveId) external view returns (uint256) {
        return _currentIndex(reserves[reserveId]);
    }

    /**
     * @notice Convert shares to assets (for yield calculation)
     * @dev Matches Aave V4 Hub pattern
     * @param reserveId The reserve to query
     * @param shares Amount of shares
     * @return assets Amount of underlying assets
     */
    function convertToAssets(uint256 reserveId, uint256 shares) external view returns (uint256 assets) {
        Reserve storage reserve = reserves[reserveId];
        if (address(reserve.underlying) == address(0)) return 0;
        uint256 currentIndex = _currentIndex(reserve);
        return (shares * currentIndex) / RAY;
    }

    /**
     * @notice Convert assets to shares
     * @dev Matches Aave V4 Hub pattern
     * @param reserveId The reserve to query
     * @param assets Amount of underlying assets
     * @return shares Amount of shares
     */
    function convertToShares(uint256 reserveId, uint256 assets) external view returns (uint256 shares) {
        Reserve storage reserve = reserves[reserveId];
        if (address(reserve.underlying) == address(0)) return 0;
        uint256 currentIndex = _currentIndex(reserve);
        return (assets * RAY) / currentIndex;
    }

    /**
     * @notice Get the underlying token address for a reserve
     * @param reserveId The reserve to query
     * @return The underlying token address
     */
    function getUnderlyingAsset(uint256 reserveId) external view returns (address) {
        return address(reserves[reserveId].underlying);
    }

    // ============ Internal Functions ============

    /**
     * @notice Accrue yield by updating the liquidity index
     */
    function _accrueYield(Reserve storage reserve) internal {
        reserve.liquidityIndex = _currentIndex(reserve);
        reserve.lastUpdateTimestamp = block.timestamp;
    }

    /**
     * @notice Calculate current liquidity index with accrued yield
     * @dev Uses simple linear interest (good enough for testing)
     */
    function _currentIndex(Reserve storage reserve) internal view returns (uint256) {
        if (reserve.lastUpdateTimestamp == 0) return RAY;

        uint256 elapsed = block.timestamp - reserve.lastUpdateTimestamp;
        if (elapsed == 0) return reserve.liquidityIndex;

        // Linear yield: index * (1 + rate * time)
        uint256 yieldMultiplier = RAY + (reserve.annualYieldBps * RAY * elapsed) / (10000 * SECONDS_PER_YEAR);
        return (reserve.liquidityIndex * yieldMultiplier) / RAY;
    }

    /**
     * @notice Get user's assets using current index
     */
    function _getUserAssets(
        Reserve storage reserve,
        address user,
        uint256 reserveId
    ) internal view returns (uint256) {
        uint256 currentIndex = _currentIndex(reserve);
        return (userShares[reserveId][user] * currentIndex) / RAY;
    }
}
