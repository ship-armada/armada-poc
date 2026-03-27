// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "../privacy-pool/interfaces/IPrivacyPool.sol";
import "../railgun/logic/Globals.sol";
import "./YieldAdaptParams.sol";
import "../governance/IArmadaGovernance.sol";

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

    /// @notice Adapter registry for governance-managed authorization checks
    IAdapterRegistry public immutable adapterRegistry;

    // ============ State ============

    /// @notice Contract owner
    address public owner;

    /// @notice Privacy Pool address for trustless lend/redeem
    address public privacyPool;

    // ============ Events ============

    event PrivacyPoolUpdated(address indexed oldPool, address indexed newPool);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    /// @notice Emitted when shielded USDC is lent and ayUSDC is re-shielded (trustless)
    event LendAndShield(
        bytes32 indexed npk,
        uint256 usdcAmount,
        uint256 sharesMinted
    );

    /// @notice Emitted when shielded ayUSDC is redeemed and USDC is re-shielded (trustless)
    event RedeemAndShield(
        bytes32 indexed npk,
        uint256 sharesBurned,
        uint256 usdcRedeemed
    );

    // ============ Modifiers ============

    modifier onlyOwner() {
        require(msg.sender == owner, "ArmadaYieldAdapter: not owner");
        _;
    }

    // ============ Constructor ============

    /**
     * @notice Initialize the adapter
     * @param _usdc USDC token address
     * @param _vault ArmadaYieldVault address
     * @param _governor Governor address (implements IAdapterRegistry)
     */
    constructor(address _usdc, address _vault, address _governor) {
        require(_usdc != address(0), "ArmadaYieldAdapter: zero usdc");
        require(_vault != address(0), "ArmadaYieldAdapter: zero vault");
        require(_governor != address(0), "ArmadaYieldAdapter: zero governor");

        usdc = IERC20(_usdc);
        vault = IArmadaYieldVault(_vault);
        shareToken = IERC20(_vault);
        adapterRegistry = IAdapterRegistry(_governor);
        owner = msg.sender;

        // Approve vault to spend USDC
        usdc.approve(_vault, type(uint256).max);
    }

    // ============ Admin Functions ============

    /**
     * @notice Set privacy pool address
     * @param _privacyPool Privacy pool address
     */
    function setPrivacyPool(address _privacyPool) external onlyOwner {
        emit PrivacyPoolUpdated(privacyPool, _privacyPool);
        privacyPool = _privacyPool;
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

    // ============ Adapter Registry Enforcement ============

    /// @dev Reverts if this adapter is not fully authorized in the governance registry.
    function _requireAuthorized() internal view {
        require(
            adapterRegistry.authorizedAdapters(address(this)),
            "ArmadaYieldAdapter: not authorized"
        );
    }

    /// @dev Reverts if this adapter is neither authorized nor in withdraw-only mode.
    function _requireAuthorizedOrWithdrawOnly() internal view {
        require(
            adapterRegistry.authorizedAdapters(address(this)) ||
            adapterRegistry.withdrawOnlyAdapters(address(this)),
            "ArmadaYieldAdapter: not authorized or withdraw-only"
        );
    }

    // ============ Trustless Shielded Operations ============

    /**
     * @notice Atomic lend: unshield USDC → deposit → shield ayUSDC
     * @dev Trustless execution via Railgun's adaptContract/adaptParams pattern:
     *
     *      1. User generates unshield proof with:
     *         - boundParams.adaptContract = address(this)
     *         - boundParams.adaptParams = hash(npk, encryptedBundle, shieldKey)
     *         - unshieldPreimage with USDC going to this adapter
     *
     *      2. Adapter verifies adaptParams match provided shield parameters
     *         - If mismatch → revert (adapter cannot change destination)
     *
     *      3. PrivacyPool.transact() verifies:
     *         - SNARK proof validity
     *         - adaptContract == msg.sender (this adapter)
     *
     *      Result: Adapter MUST shield ayUSDC to user's committed npk
     *
     * @param _transaction Unshield transaction (proof verified by PrivacyPool)
     * @param _npk User's note public key for re-shielding ayUSDC
     * @param _shieldCiphertext Ciphertext for recipient to decrypt
     * @return shares Amount of ayUSDC shares minted and shielded
     */
    function lendAndShield(
        Transaction calldata _transaction,
        bytes32 _npk,
        ShieldCiphertext calldata _shieldCiphertext
    ) external nonReentrant returns (uint256 shares) {
        _requireAuthorized();
        require(privacyPool != address(0), "ArmadaYieldAdapter: no privacyPool");

        // 1. Verify this transaction is bound to this adapter
        require(
            _transaction.boundParams.adaptContract == address(this),
            "ArmadaYieldAdapter: invalid adaptContract"
        );

        // 2. Verify adaptParams binds the npk and ciphertext
        //    This ensures adapter MUST use user's committed shield destination
        require(
            YieldAdaptParams.verify(
                _transaction.boundParams.adaptParams,
                _npk,
                _shieldCiphertext.encryptedBundle,
                _shieldCiphertext.shieldKey
            ),
            "ArmadaYieldAdapter: adaptParams mismatch"
        );

        // 3. Verify this is an unshield for USDC
        require(
            _transaction.unshieldPreimage.token.tokenAddress == address(usdc),
            "ArmadaYieldAdapter: not USDC unshield"
        );

        // 4. Execute unshield via PrivacyPool
        //    - PrivacyPool verifies SNARK proof
        //    - PrivacyPool checks adaptContract == msg.sender
        //    - USDC is transferred to this adapter
        Transaction[] memory txs = new Transaction[](1);
        txs[0] = _transaction;
        IPrivacyPool(privacyPool).transact(txs);

        // 5. Get amount from unshield preimage
        uint256 amount = _transaction.unshieldPreimage.value;
        require(amount > 0, "ArmadaYieldAdapter: zero amount");

        // 6. Deposit USDC to vault, receive shares to this adapter
        shares = vault.deposit(amount, address(this));

        // 7. Build shield request for ayUSDC
        ShieldRequest[] memory shieldRequests = new ShieldRequest[](1);
        shieldRequests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: _npk,  // User's npk from verified adaptParams
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: address(shareToken),
                    tokenSubID: 0
                }),
                value: uint120(shares)
            }),
            ciphertext: _shieldCiphertext
        });

        // 8. Shield ayUSDC to user's npk
        shareToken.approve(privacyPool, shares);
        IPrivacyPool(privacyPool).shield(shieldRequests, address(0));

        emit LendAndShield(_npk, amount, shares);
    }

    /**
     * @notice Atomic redeem: unshield ayUSDC → redeem → shield USDC
     * @dev Trustless execution via Railgun's adaptContract/adaptParams pattern.
     *      Same security model as lendAndShield - adapter cannot deviate from
     *      user's committed re-shield destination.
     *
     * @param _transaction Unshield transaction for ayUSDC
     * @param _npk User's note public key for re-shielding USDC
     * @param _shieldCiphertext Ciphertext for recipient to decrypt
     * @return assets Amount of USDC redeemed and shielded (after yield fee)
     */
    function redeemAndShield(
        Transaction calldata _transaction,
        bytes32 _npk,
        ShieldCiphertext calldata _shieldCiphertext
    ) external nonReentrant returns (uint256 assets) {
        _requireAuthorizedOrWithdrawOnly();
        require(privacyPool != address(0), "ArmadaYieldAdapter: no privacyPool");

        // 1. Verify this transaction is bound to this adapter
        require(
            _transaction.boundParams.adaptContract == address(this),
            "ArmadaYieldAdapter: invalid adaptContract"
        );

        // 2. Verify adaptParams binds the npk and ciphertext
        require(
            YieldAdaptParams.verify(
                _transaction.boundParams.adaptParams,
                _npk,
                _shieldCiphertext.encryptedBundle,
                _shieldCiphertext.shieldKey
            ),
            "ArmadaYieldAdapter: adaptParams mismatch"
        );

        // 3. Verify this is an unshield for vault shares
        require(
            _transaction.unshieldPreimage.token.tokenAddress == address(shareToken),
            "ArmadaYieldAdapter: not share token unshield"
        );

        // 4. Execute unshield via PrivacyPool
        Transaction[] memory txs = new Transaction[](1);
        txs[0] = _transaction;
        IPrivacyPool(privacyPool).transact(txs);

        // 5. Get shares from unshield preimage
        uint256 shares = _transaction.unshieldPreimage.value;
        require(shares > 0, "ArmadaYieldAdapter: zero shares");

        // 6. Redeem shares from vault (10% yield fee applied by vault)
        shareToken.approve(address(vault), shares);
        assets = vault.redeem(shares, address(this), address(this));

        // 7. Build shield request for USDC
        ShieldRequest[] memory shieldRequests = new ShieldRequest[](1);
        shieldRequests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: _npk,  // User's npk from verified adaptParams
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: address(usdc),
                    tokenSubID: 0
                }),
                value: uint120(assets)
            }),
            ciphertext: _shieldCiphertext
        });

        // 8. Shield USDC to user's npk
        usdc.approve(privacyPool, assets);
        IPrivacyPool(privacyPool).shield(shieldRequests, address(0));

        emit RedeemAndShield(_npk, shares, assets);
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
