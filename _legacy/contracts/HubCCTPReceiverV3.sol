// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./cctp/ICCTPV2.sol";
import "./railgun/logic/Globals.sol";

/**
 * @title HubCCTPReceiverV3
 * @notice Receives CCTP V2 messages and forwards to RailgunSmartWallet
 * @dev Implements IMessageHandlerV2 to receive cross-chain shield requests
 *
 * This contract is the mintRecipient for all shield operations:
 *   1. TokenMessenger mints USDC to this contract
 *   2. TokenMessenger calls handleReceiveFinalizedMessage()
 *   3. We decode the hookData to get shield parameters
 *   4. We call RailgunSmartWallet.shield()
 *
 * Compatible with:
 *   - Mock CCTP V2 (for local testing)
 *   - Real Circle CCTP V2 (for testnets/mainnet)
 *
 * Key differences from V2:
 *   - Implements IMessageHandlerV2 interface
 *   - Receives callback from TokenMessenger after it mints USDC
 *   - Uses domain IDs instead of chain IDs for source validation
 */
contract HubCCTPReceiverV3 is IMessageHandlerV2 {
    using SafeERC20 for IERC20;

    // CCTP contracts
    // In CCTP V2, TokenMessenger (not MessageTransmitter) calls the hook handler
    address public immutable tokenMessenger;      // Only this can call handlers
    address public immutable usdc;                // USDC token on hub

    // Railgun
    address public railgunSmartWallet;

    // Allowed source domains (client chains that can shield)
    mapping(uint32 => bool) public allowedSourceDomains;

    // Events
    event CCTPMessageReceived(
        uint32 indexed sourceDomain,
        bytes32 sender,
        uint256 amount,
        bytes32 npk
    );

    event ShieldForwarded(
        uint256 amount,
        bytes32 npk,
        address tokenAddress
    );

    event SourceDomainUpdated(uint32 indexed domain, bool allowed);
    event RailgunWalletUpdated(address indexed oldWallet, address indexed newWallet);

    // Owner for configuration
    address public owner;

    constructor(
        address _tokenMessenger,
        address _usdc,
        address _railgunSmartWallet
    ) {
        tokenMessenger = _tokenMessenger;
        usdc = _usdc;
        railgunSmartWallet = _railgunSmartWallet;
        owner = msg.sender;
    }

    /**
     * @notice Add or remove an allowed source domain
     * @param domain Circle domain ID to configure
     * @param allowed Whether shields from this domain are allowed
     */
    function setSourceDomain(uint32 domain, bool allowed) external {
        require(msg.sender == owner, "Only owner");
        allowedSourceDomains[domain] = allowed;
        emit SourceDomainUpdated(domain, allowed);
    }

    /**
     * @inheritdoc IMessageHandlerV2
     * @notice Handle finalized CCTP message (main entry point)
     */
    function handleReceiveFinalizedMessage(
        uint32 remoteDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external override returns (bool success) {
        require(msg.sender == tokenMessenger, "Only TokenMessenger");
        require(allowedSourceDomains[remoteDomain], "Source domain not allowed");

        return _processMessage(remoteDomain, sender, messageBody);
    }

    /**
     * @inheritdoc IMessageHandlerV2
     * @notice Handle unfinalized (fast) CCTP message
     * @dev We treat this the same as finalized for simplicity
     */
    function handleReceiveUnfinalizedMessage(
        uint32 remoteDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external override returns (bool success) {
        require(msg.sender == tokenMessenger, "Only TokenMessenger");
        require(allowedSourceDomains[remoteDomain], "Source domain not allowed");

        return _processMessage(remoteDomain, sender, messageBody);
    }

    /**
     * @notice Process incoming CCTP message and shield to Railgun
     */
    function _processMessage(
        uint32 remoteDomain,
        bytes32 sender,
        bytes calldata messageBody
    ) internal returns (bool) {
        // Decode the burn message to get amount and hookData
        (
            address burnToken,
            bytes32 mintRecipient,
            uint256 amount,
            bytes memory hookData
        ) = BurnMessage.decode(messageBody);

        // Verify we're the intended recipient
        require(
            mintRecipient == bytes32(uint256(uint160(address(this)))),
            "Wrong recipient"
        );

        // hookData contains the shield parameters
        require(hookData.length > 0, "No hook data");

        // Decode shield parameters from hookData
        (
            bytes32 npk,
            uint120 value,
            bytes32[3] memory encryptedBundle,
            bytes32 shieldKey
        ) = abi.decode(hookData, (bytes32, uint120, bytes32[3], bytes32));

        // Sanity check - value in hookData should match CCTP amount
        require(uint256(value) == amount, "Amount mismatch");

        emit CCTPMessageReceived(remoteDomain, sender, amount, npk);

        // Shield to Railgun
        _shieldToRailgun(npk, value, encryptedBundle, shieldKey);

        return true;
    }

    /**
     * @notice Construct ShieldRequest and call RailgunSmartWallet.shield()
     */
    function _shieldToRailgun(
        bytes32 npk,
        uint120 value,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey
    ) internal {
        // Construct ShieldRequest struct
        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: npk,
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: usdc,
                    tokenSubID: 0
                }),
                value: value
            }),
            ciphertext: ShieldCiphertext({
                encryptedBundle: encryptedBundle,
                shieldKey: shieldKey
            })
        });

        // Approve RailgunSmartWallet to pull tokens
        IERC20(usdc).safeApprove(railgunSmartWallet, 0);
        IERC20(usdc).safeApprove(railgunSmartWallet, uint256(value));

        // Call shield()
        IRailgunSmartWallet(railgunSmartWallet).shield(requests);

        emit ShieldForwarded(uint256(value), npk, usdc);
    }

    /**
     * @notice Update RailgunSmartWallet address
     */
    function setRailgunSmartWallet(address _railgunSmartWallet) external {
        require(msg.sender == owner, "Only owner");
        emit RailgunWalletUpdated(railgunSmartWallet, _railgunSmartWallet);
        railgunSmartWallet = _railgunSmartWallet;
    }

    /**
     * @notice Emergency withdraw stuck funds
     */
    function emergencyWithdraw(address token, address to, uint256 amount) external {
        require(msg.sender == owner, "Only owner");
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Transfer ownership
     */
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "Only owner");
        owner = newOwner;
    }
}

/**
 * @notice Interface for RailgunSmartWallet
 */
interface IRailgunSmartWallet {
    function shield(ShieldRequest[] calldata _shieldRequests) external;
}
