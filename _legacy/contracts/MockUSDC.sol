// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Simulated CCTP USDC contract for POC
 * @dev Deployed on BOTH chains:
 *      - Chain A: Users burn via ClientShieldProxy
 *      - Chain H: Receives relay messages and mints to HubCCTPReceiver
 */
contract MockUSDC is ERC20 {

    // Events
    event BurnForDeposit(
        uint64 indexed nonce,
        address indexed sender,
        uint256 amount,
        uint32 destinationChainId,
        address destinationAddress,
        bytes payload
    );

    event MessageReceived(
        uint64 indexed nonce,
        address indexed recipient,
        uint256 amount
    );

    // State
    uint64 public burnNonce;
    // Keyed by sourceChainId => sourceNonce => processed
    mapping(uint32 => mapping(uint64 => bool)) public processedNonces;
    address public relayer;  // Simple access control

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        relayer = msg.sender;  // Deployer is relayer for simplicity
    }

    /**
     * @notice Mint tokens (for initial funding only)
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Set relayer address
     */
    function setRelayer(address _relayer) external {
        require(msg.sender == relayer, "Only relayer");
        relayer = _relayer;
    }

    /**
     * @notice Burn tokens to initiate cross-chain transfer (CCTP burn)
     * @param amount Amount to burn
     * @param destinationChainId Target chain ID
     * @param destinationAddress Recipient on target chain
     * @param payload Arbitrary data (commitment for shield, empty for unshield)
     */
    function burnForDeposit(
        uint256 amount,
        uint32 destinationChainId,
        address destinationAddress,
        bytes calldata payload
    ) external returns (uint64) {
        require(amount > 0, "Amount must be > 0");
        require(destinationAddress != address(0), "Invalid destination");

        // Burn tokens from sender
        _burn(msg.sender, amount);

        // Increment and emit nonce
        uint64 nonce = burnNonce++;

        emit BurnForDeposit(
            nonce,
            msg.sender,
            amount,
            destinationChainId,
            destinationAddress,
            payload
        );

        return nonce;
    }

    /**
     * @notice Receive cross-chain message and mint (CCTP mint)
     * @param sourceChainId Chain ID where the burn originated
     * @param sourceNonce Nonce from source chain burn
     * @param recipient Address to receive tokens (or contract to call)
     * @param amount Amount to mint
     * @param payload Original payload from burn
     */
    function receiveMessage(
        uint32 sourceChainId,
        uint64 sourceNonce,
        address recipient,
        uint256 amount,
        bytes calldata payload
    ) external {
        require(msg.sender == relayer, "Only relayer can relay");
        require(!processedNonces[sourceChainId][sourceNonce], "Nonce already processed");
        require(recipient != address(0), "Invalid recipient");

        // Mark nonce as processed (replay protection)
        processedNonces[sourceChainId][sourceNonce] = true;

        // Mint tokens to recipient
        _mint(recipient, amount);

        emit MessageReceived(sourceNonce, recipient, amount);

        // If recipient is a contract, call onCCTPReceive
        if (_isContract(recipient) && payload.length > 0) {
            ICCTPReceiver(recipient).onCCTPReceive(amount, payload);
        }
    }

    /**
     * @notice Check if address is contract
     */
    function _isContract(address addr) internal view returns (bool) {
        uint256 size;
        assembly { size := extcodesize(addr) }
        return size > 0;
    }

    /**
     * @notice Override decimals to match USDC (6 decimals)
     */
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/**
 * @notice Interface for CCTP receivers
 */
interface ICCTPReceiver {
    function onCCTPReceive(uint256 amount, bytes calldata payload) external;
}
