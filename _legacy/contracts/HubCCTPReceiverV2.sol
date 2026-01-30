// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./railgun/logic/Globals.sol";

/**
 * @title HubCCTPReceiverV2
 * @notice Receives CCTP mints and forwards to RailgunSmartWallet
 * @dev This contract is the recipient of all CCTP messages on the Hub chain.
 *      It decodes the payload, constructs ShieldRequest structs, and calls
 *      RailgunSmartWallet.shield().
 *
 * Key changes from V1:
 * - Accepts full ShieldRequest data in payload (not just commitment hash)
 * - Calls RailgunSmartWallet.shield() instead of SimpleShieldAdapter.insertCommitment()
 * - Approves Railgun contract before calling shield()
 */
contract HubCCTPReceiverV2 {
    using SafeERC20 for IERC20;

    // Addresses
    address public immutable mockUSDC;
    address public railgunSmartWallet;

    // Events
    event CCTPReceived(
        uint256 amount,
        bytes32 npk,
        address tokenAddress
    );

    event ShieldForwarded(
        uint256 amount,
        bytes32 npk
    );

    event RailgunWalletUpdated(address indexed oldWallet, address indexed newWallet);

    // Owner for configuration
    address public owner;

    constructor(address _mockUSDC, address _railgunSmartWallet) {
        mockUSDC = _mockUSDC;
        railgunSmartWallet = _railgunSmartWallet;
        owner = msg.sender;
    }

    /**
     * @notice Called by MockUSDC when receiving CCTP message
     * @param amount Amount of USDC received (minted to this contract)
     * @param payload Encoded shield request data from ClientShieldProxy
     *
     * Payload format (V2):
     *   - bytes32 npk: Note public key (Poseidon hash)
     *   - uint120 value: Amount being shielded
     *   - bytes32[3] encryptedBundle: Shield ciphertext encrypted bundle
     *   - bytes32 shieldKey: Public key for shared secret derivation
     */
    function onCCTPReceive(uint256 amount, bytes calldata payload) external {
        require(msg.sender == mockUSDC, "Only MockUSDC");

        if (payload.length == 0) {
            // Empty payload - shouldn't happen in normal flow
            // USDC stays in this contract
            return;
        }

        // Decode ShieldRequest components from payload
        (
            bytes32 npk,
            uint120 value,
            bytes32[3] memory encryptedBundle,
            bytes32 shieldKey
        ) = abi.decode(payload, (bytes32, uint120, bytes32[3], bytes32));

        // Sanity check
        require(uint256(value) == amount, "Amount mismatch");

        emit CCTPReceived(amount, npk, mockUSDC);

        // Construct ShieldRequest struct
        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: npk,
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: mockUSDC,
                    tokenSubID: 0
                }),
                value: value
            }),
            ciphertext: ShieldCiphertext({
                encryptedBundle: encryptedBundle,
                shieldKey: shieldKey
            })
        });

        // Approve RailgunSmartWallet to pull tokens (reset to 0 first for SafeERC20)
        // Note: RailgunSmartWallet.shield() uses safeTransferFrom(msg.sender, ...)
        IERC20(mockUSDC).safeApprove(railgunSmartWallet, 0);
        IERC20(mockUSDC).safeApprove(railgunSmartWallet, amount);

        // Call shield() - this will pull tokens from this contract
        IRailgunSmartWallet(railgunSmartWallet).shield(requests);

        emit ShieldForwarded(amount, npk);
    }

    /**
     * @notice Update RailgunSmartWallet address (owner only)
     */
    function setRailgunSmartWallet(address _railgunSmartWallet) external {
        require(msg.sender == owner, "Only owner");
        emit RailgunWalletUpdated(railgunSmartWallet, _railgunSmartWallet);
        railgunSmartWallet = _railgunSmartWallet;
    }

    /**
     * @notice Emergency withdraw stuck funds (POC only)
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
