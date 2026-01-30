// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "../cctp/ICCTPV2.sol";

/**
 * @title IArmadaYieldVault
 * @notice Interface for ArmadaYieldVault
 */
interface IArmadaYieldVault {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function convertToShares(uint256 assets) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title ArmadaYieldAdapter
 * @notice Adapter for lend/redeem operations between PrivacyPool and ArmadaYieldVault
 * @dev This contract bridges the privacy pool with the yield vault.
 *      It handles the conversion between shielded USDC and shielded yield positions.
 *
 * Flow:
 * - Lend: User unshields USDC → Adapter deposits to vault → Shield shares back to user
 * - Redeem: User unshields shares → Adapter redeems from vault → Shield USDC back to user
 *
 * For POC purposes, this adapter uses a simplified interface.
 * In production, it would integrate with the full Railgun proof system.
 */
contract ArmadaYieldAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Immutables ============

    /// @notice The USDC token
    IERC20 public immutable usdc;

    /// @notice The Armada Yield Vault
    IArmadaYieldVault public immutable vault;

    /// @notice The vault share token (same as vault for ERC-20)
    IERC20 public immutable shareToken;

    // ============ State ============

    /// @notice Contract owner
    address public owner;

    /// @notice Authorized relayers
    mapping(address => bool) public relayers;

    /// @notice Privacy Pool address (for future integration)
    address public privacyPool;

    /// @notice CCTP TokenMessenger address for cross-chain burns
    address public tokenMessenger;

    // ============ Events ============

    event Lend(
        address indexed user,
        uint256 usdcAmount,
        uint256 sharesMinted
    );

    event Redeem(
        address indexed user,
        uint256 sharesBurned,
        uint256 usdcRedeemed
    );

    event RedeemAndUnshield(
        address indexed user,
        uint256 sharesBurned,
        uint256 usdcRedeemed,
        address recipient
    );

    event RedeemAndUnshieldCCTP(
        address indexed user,
        uint256 sharesBurned,
        uint256 usdcRedeemed,
        uint32 destinationDomain,
        address finalRecipient,
        uint64 cctpNonce
    );

    event RelayerUpdated(address indexed relayer, bool authorized);
    event TokenMessengerUpdated(address indexed oldMessenger, address indexed newMessenger);
    event PrivacyPoolUpdated(address indexed oldPool, address indexed newPool);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ============ Modifiers ============

    modifier onlyOwner() {
        require(msg.sender == owner, "ArmadaYieldAdapter: not owner");
        _;
    }

    modifier onlyRelayer() {
        require(relayers[msg.sender], "ArmadaYieldAdapter: not relayer");
        _;
    }

    // ============ Constructor ============

    /**
     * @notice Initialize the adapter
     * @param _usdc USDC token address
     * @param _vault ArmadaYieldVault address
     */
    constructor(address _usdc, address _vault) {
        require(_usdc != address(0), "ArmadaYieldAdapter: zero usdc");
        require(_vault != address(0), "ArmadaYieldAdapter: zero vault");

        usdc = IERC20(_usdc);
        vault = IArmadaYieldVault(_vault);
        shareToken = IERC20(_vault);
        owner = msg.sender;

        // Approve vault to spend USDC
        usdc.approve(_vault, type(uint256).max);
    }

    // ============ Admin Functions ============

    /**
     * @notice Set relayer authorization
     * @param relayer Relayer address
     * @param authorized Whether authorized
     */
    function setRelayer(address relayer, bool authorized) external onlyOwner {
        relayers[relayer] = authorized;
        emit RelayerUpdated(relayer, authorized);
    }

    /**
     * @notice Set privacy pool address
     * @param _privacyPool Privacy pool address
     */
    function setPrivacyPool(address _privacyPool) external onlyOwner {
        emit PrivacyPoolUpdated(privacyPool, _privacyPool);
        privacyPool = _privacyPool;
    }

    /**
     * @notice Set CCTP TokenMessenger address
     * @param _tokenMessenger TokenMessenger address
     */
    function setTokenMessenger(address _tokenMessenger) external onlyOwner {
        emit TokenMessengerUpdated(tokenMessenger, _tokenMessenger);
        tokenMessenger = _tokenMessenger;
        // Approve TokenMessenger to spend USDC for cross-chain burns
        if (_tokenMessenger != address(0)) {
            usdc.approve(_tokenMessenger, type(uint256).max);
        }
    }

    /**
     * @notice Transfer ownership
     * @param newOwner New owner address
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ArmadaYieldAdapter: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ============ User Functions (POC Simplified) ============

    /**
     * @notice Lend USDC to receive vault shares
     * @dev POC version: Direct deposit without privacy proof
     *      Production: Would verify unshield proof and re-shield shares
     * @param amount USDC amount to lend
     * @return shares Amount of vault shares received
     */
    function lend(uint256 amount) external nonReentrant returns (uint256 shares) {
        require(amount > 0, "ArmadaYieldAdapter: zero amount");

        // Transfer USDC from user
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Deposit to vault
        shares = vault.deposit(amount, msg.sender);

        emit Lend(msg.sender, amount, shares);
    }

    /**
     * @notice Redeem vault shares for USDC
     * @dev POC version: Direct redemption without privacy proof
     *      Production: Would verify unshield proof and re-shield USDC
     *      User must approve this adapter to spend their vault shares.
     * @param shares Amount of shares to redeem
     * @return assets Amount of USDC received
     */
    function redeemShares(uint256 shares) external nonReentrant returns (uint256 assets) {
        require(shares > 0, "ArmadaYieldAdapter: zero shares");

        // Redeem from vault on behalf of user
        // User must have approved this adapter to spend their shares
        // This preserves principal tracking since owner_ = msg.sender
        assets = vault.redeem(shares, msg.sender, msg.sender);

        emit Redeem(msg.sender, shares, assets);
    }

    // ============ Relayer Functions (Privacy-Preserving) ============

    /**
     * @notice Lend with privacy - relayer executes on behalf of user
     * @dev In production, this would:
     *      1. Verify unshield proof for USDC
     *      2. Deposit to vault
     *      3. Generate shield commitment for shares
     * @param amount USDC amount
     * @param user User address (for event)
     * @return shares Shares minted
     */
    function lendPrivate(
        uint256 amount,
        address user
    ) external onlyRelayer nonReentrant returns (uint256 shares) {
        require(amount > 0, "ArmadaYieldAdapter: zero amount");

        // In production: verify unshield proof
        // For POC: USDC should already be in this contract from unshield

        // Deposit to vault (shares go to adapter for re-shielding)
        shares = vault.deposit(amount, address(this));

        // In production: shield shares to user's npk
        // For POC: transfer shares to user
        shareToken.transfer(user, shares);

        emit Lend(user, amount, shares);
    }

    /**
     * @notice Redeem with privacy - relayer executes on behalf of user
     * @dev In production, this would:
     *      1. Verify unshield proof for shares
     *      2. Redeem from vault (yield fee applied)
     *      3. Generate shield commitment for USDC
     * @param shares Shares to redeem
     * @param user User address (for event)
     * @return assets USDC redeemed
     */
    function redeemPrivate(
        uint256 shares,
        address user
    ) external onlyRelayer nonReentrant returns (uint256 assets) {
        require(shares > 0, "ArmadaYieldAdapter: zero shares");

        // In production: verify unshield proof
        // For POC: shares should already be in this contract from unshield

        // Approve vault
        shareToken.approve(address(vault), shares);

        // Redeem from vault (USDC goes to adapter for re-shielding)
        assets = vault.redeem(shares, address(this), address(this));

        // In production: shield USDC to user's npk
        // For POC: transfer USDC to user
        usdc.safeTransfer(user, assets);

        emit Redeem(user, shares, assets);
    }

    /**
     * @notice Redeem and unshield in one step - pay directly from yield
     * @dev Converts yield position to unshielded USDC for the recipient
     * @param shares Shares to redeem
     * @param recipient Address to receive USDC
     * @return assets USDC sent to recipient
     */
    function redeemAndUnshield(
        uint256 shares,
        address recipient
    ) external onlyRelayer nonReentrant returns (uint256 assets) {
        require(shares > 0, "ArmadaYieldAdapter: zero shares");
        require(recipient != address(0), "ArmadaYieldAdapter: zero recipient");

        // In production: verify unshield proof for shares
        // For POC: shares should already be in this contract

        // Approve vault
        shareToken.approve(address(vault), shares);

        // Redeem directly to recipient
        assets = vault.redeem(shares, recipient, address(this));

        emit RedeemAndUnshield(msg.sender, shares, assets, recipient);
    }

    /**
     * @notice Redeem yield position and bridge USDC to another chain via CCTP
     * @dev Converts yield position to USDC and burns it via CCTP for cross-chain transfer.
     *      The USDC will be minted on the destination chain to the finalRecipient.
     *
     * Flow:
     *   1. Relayer calls this with shares (already in adapter from unshield)
     *   2. Adapter redeems shares from vault → receives USDC
     *   3. Adapter burns USDC via CCTP TokenMessenger
     *   4. Relayer delivers message on destination chain
     *   5. finalRecipient receives USDC on destination chain
     *
     * @param shares Amount of ayUSDC shares to redeem
     * @param destinationDomain CCTP domain ID of destination chain
     * @param finalRecipient Address to receive USDC on destination chain
     * @param destinationCaller Address allowed to call receiveMessage (or 0 for any)
     * @return assets Amount of USDC redeemed
     * @return nonce CCTP nonce for tracking the cross-chain transfer
     */
    function redeemAndUnshieldCCTP(
        uint256 shares,
        uint32 destinationDomain,
        address finalRecipient,
        bytes32 destinationCaller
    ) external onlyRelayer nonReentrant returns (uint256 assets, uint64 nonce) {
        require(shares > 0, "ArmadaYieldAdapter: zero shares");
        require(finalRecipient != address(0), "ArmadaYieldAdapter: zero recipient");
        require(tokenMessenger != address(0), "ArmadaYieldAdapter: no tokenMessenger");

        // In production: verify unshield proof for shares
        // For POC: shares should already be in this contract from unshield

        // Approve vault to take shares
        shareToken.approve(address(vault), shares);

        // Redeem from vault - USDC comes to this contract
        assets = vault.redeem(shares, address(this), address(this));

        // Burn USDC via CCTP to bridge to destination chain
        // Using standard finality (2000) and no fee (0) for POC
        nonce = ITokenMessengerV2(tokenMessenger).depositForBurn(
            assets,
            destinationDomain,
            MessageV2.addressToBytes32(finalRecipient),  // mintRecipient on destination
            address(usdc),
            destinationCaller,
            0,                          // maxFee - no fee for POC
            CCTPFinality.STANDARD       // minFinalityThreshold
        );

        emit RedeemAndUnshieldCCTP(
            msg.sender,
            shares,
            assets,
            destinationDomain,
            finalRecipient,
            nonce
        );
    }

    // ============ View Functions ============

    /**
     * @notice Preview lend - get shares for USDC amount
     * @param amount USDC amount
     * @return shares Vault shares
     */
    function previewLend(uint256 amount) external view returns (uint256) {
        return vault.convertToShares(amount);
    }

    /**
     * @notice Preview redeem - get USDC for shares amount
     * @param shares Vault shares
     * @return assets USDC amount (before yield fee)
     */
    function previewRedeem(uint256 shares) external view returns (uint256) {
        return vault.convertToAssets(shares);
    }

    // ============ Emergency Functions ============

    /**
     * @notice Rescue stuck tokens
     * @param token Token address
     * @param to Recipient address
     * @param amount Amount to rescue
     */
    function rescueTokens(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }
}
