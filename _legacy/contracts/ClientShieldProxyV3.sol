// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./cctp/ICCTPV2.sol";

/**
 * @title ClientShieldProxyV3
 * @notice User-facing contract for shield operations using CCTP V2
 * @dev Compatible with both mock CCTP (testing) and real Circle CCTP V2 (production)
 *
 * Shield flow:
 *   1. User generates ShieldRequest data off-chain (npk, ciphertext)
 *   2. User approves this contract to spend USDC
 *   3. User calls shield(amount, npk, encryptedBundle, shieldKey)
 *   4. This contract transfers USDC from user
 *   5. This contract calls TokenMessengerV2.depositForBurnWithHook()
 *   6. CCTP attestation service attests the message
 *   7. Relayer calls receiveMessage() on destination MessageTransmitter
 *   8. MessageTransmitter mints USDC and calls HubCCTPReceiverV3.handleReceiveFinalizedMessage()
 *   9. HubCCTPReceiverV3 shields to Railgun
 *
 * Key differences from V2:
 *   - Uses ITokenMessengerV2.depositForBurnWithHook() instead of custom burn
 *   - Uses Circle domain IDs instead of EVM chain IDs
 *   - hookData contains the shield parameters
 */
contract ClientShieldProxyV3 {
    using SafeERC20 for IERC20;

    // CCTP V2 contracts
    address public immutable tokenMessenger;  // TokenMessengerV2
    address public immutable usdc;            // USDC token

    // Destination configuration
    uint32 public immutable hubDomain;        // Circle domain ID of hub chain
    bytes32 public hubReceiver;               // HubCCTPReceiverV3 address (as bytes32)

    // CCTP settings
    uint256 public maxFee;                    // Max fee for fast finality (0 = no fast)
    uint32 public minFinalityThreshold;       // 1000=fast, 2000=standard

    // Events
    event ShieldInitiated(
        address indexed user,
        uint256 amount,
        bytes32 indexed npk,
        uint64 nonce,
        uint32 destinationDomain
    );

    event ConfigUpdated(
        bytes32 hubReceiver,
        uint256 maxFee,
        uint32 minFinalityThreshold
    );

    // Owner for configuration
    address public owner;

    constructor(
        address _tokenMessenger,
        address _usdc,
        uint32 _hubDomain,
        address _hubReceiver
    ) {
        tokenMessenger = _tokenMessenger;
        usdc = _usdc;
        hubDomain = _hubDomain;
        hubReceiver = bytes32(uint256(uint160(_hubReceiver)));
        maxFee = 0;                              // No fast finality by default
        minFinalityThreshold = CCTPFinality.STANDARD;  // Standard finality
        owner = msg.sender;
    }

    /**
     * @notice Shield USDC into the hub MASP (Railgun-compatible)
     * @param amount Amount of USDC to shield
     * @param npk Note Public Key - Poseidon hash representing note ownership
     * @param encryptedBundle Shield ciphertext encrypted bundle [3 x bytes32]
     * @param shieldKey Public key for shared secret derivation
     * @return nonce The CCTP nonce for tracking
     *
     * The npk, encryptedBundle, and shieldKey should be generated off-chain using
     * the Railgun SDK, which uses Poseidon hashing.
     */
    function shield(
        uint256 amount,
        bytes32 npk,
        bytes32[3] calldata encryptedBundle,
        bytes32 shieldKey
    ) external returns (uint64 nonce) {
        require(amount > 0, "Amount must be > 0");
        require(npk != bytes32(0), "Invalid npk");
        require(hubReceiver != bytes32(0), "Hub receiver not set");

        // Transfer USDC from user to this contract
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);

        // Approve TokenMessenger to spend USDC
        IERC20(usdc).safeApprove(tokenMessenger, 0);
        IERC20(usdc).safeApprove(tokenMessenger, amount);

        // Encode hook data (shield parameters for hub)
        // This matches what HubCCTPReceiverV3 expects to decode
        bytes memory hookData = abi.encode(
            npk,
            uint120(amount),
            encryptedBundle,
            shieldKey
        );

        // Call CCTP V2 depositForBurnWithHook
        nonce = ITokenMessengerV2(tokenMessenger).depositForBurnWithHook(
            amount,
            hubDomain,
            hubReceiver,
            usdc,
            bytes32(0),              // destinationCaller: anyone can relay
            maxFee,
            minFinalityThreshold,
            hookData
        );

        emit ShieldInitiated(msg.sender, amount, npk, nonce, hubDomain);

        return nonce;
    }

    /**
     * @notice Update hub receiver address
     * @param _hubReceiver New HubCCTPReceiverV3 address
     */
    function setHubReceiver(address _hubReceiver) external {
        require(msg.sender == owner, "Only owner");
        hubReceiver = bytes32(uint256(uint160(_hubReceiver)));
        emit ConfigUpdated(hubReceiver, maxFee, minFinalityThreshold);
    }

    /**
     * @notice Update CCTP finality settings
     * @param _maxFee Maximum fee for fast finality
     * @param _minFinalityThreshold Minimum finality threshold (1000 or 2000)
     */
    function setFinalitySettings(uint256 _maxFee, uint32 _minFinalityThreshold) external {
        require(msg.sender == owner, "Only owner");
        require(
            _minFinalityThreshold == CCTPFinality.FAST ||
            _minFinalityThreshold == CCTPFinality.STANDARD,
            "Invalid threshold"
        );
        maxFee = _maxFee;
        minFinalityThreshold = _minFinalityThreshold;
        emit ConfigUpdated(hubReceiver, maxFee, minFinalityThreshold);
    }

    /**
     * @notice Transfer ownership
     */
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "Only owner");
        owner = newOwner;
    }

    /**
     * @notice Emergency withdraw stuck funds (should not be needed)
     */
    function emergencyWithdraw(address token, address to, uint256 amount) external {
        require(msg.sender == owner, "Only owner");
        IERC20(token).safeTransfer(to, amount);
    }
}
