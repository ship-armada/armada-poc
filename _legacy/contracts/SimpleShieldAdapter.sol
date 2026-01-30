// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SimpleShieldAdapter
 * @notice Stub MASP for POC - stores commitments, tracks nullifiers
 * @dev This simulates Railgun's core functionality without SNARKs.
 *      Replace with RailgunSmartWallet wrapper for full privacy.
 *
 * What this DOES:
 *   - Store commitments (simulates Merkle tree insertion)
 *   - Track nullifiers (prevents double-spend)
 *   - Hold USDC (the "vault")
 *   - Emit events compatible with Railgun
 *
 * What this DOES NOT do:
 *   - SNARK verification (no privacy)
 *   - Merkle proofs (just array storage)
 *   - Encrypted transfers (amounts visible)
 */
contract SimpleShieldAdapter {
    using SafeERC20 for IERC20;

    // Commitment storage (simulates Merkle tree)
    bytes32[] public commitments;
    mapping(bytes32 => bool) public commitmentExists;

    // Nullifier tracking
    mapping(bytes32 => bool) public nullifiers;

    // Token being tracked
    address public immutable usdc;

    // Total shielded balance (should equal USDC balance)
    uint256 public totalShielded;

    // Access control
    address public hubReceiver;  // Only HubCCTPReceiver can insert
    address public owner;

    // Events (compatible with Railgun for easier migration)
    event CommitmentInserted(
        uint256 indexed index,
        bytes32 indexed commitment,
        uint256 amount,
        bytes encryptedNote
    );

    event Nullified(
        bytes32 indexed nullifier
    );

    event Unshield(
        address indexed recipient,
        uint256 amount,
        bytes32 nullifier
    );

    constructor(address _usdc) {
        usdc = _usdc;
        owner = msg.sender;
    }

    /**
     * @notice Set the authorized hub receiver
     */
    function setHubReceiver(address _hubReceiver) external {
        require(msg.sender == owner, "Only owner");
        hubReceiver = _hubReceiver;
    }

    /**
     * @notice Insert commitment (called by HubCCTPReceiver after CCTP mint)
     * @param commitment The note commitment hash
     * @param amount Amount being shielded
     * @param encryptedNote Encrypted note data for wallet recovery
     */
    function insertCommitment(
        bytes32 commitment,
        uint256 amount,
        bytes calldata encryptedNote
    ) external {
        require(msg.sender == hubReceiver, "Only hub receiver");
        require(commitment != bytes32(0), "Invalid commitment");
        require(!commitmentExists[commitment], "Commitment already exists");

        // Verify USDC was received
        uint256 balance = IERC20(usdc).balanceOf(address(this));
        require(balance >= totalShielded + amount, "Insufficient USDC received");

        // Store commitment
        uint256 index = commitments.length;
        commitments.push(commitment);
        commitmentExists[commitment] = true;
        totalShielded += amount;

        emit CommitmentInserted(index, commitment, amount, encryptedNote);
    }

    /**
     * @notice Transfer within the shielded pool (private transfer)
     * @dev In stub version, this just nullifies inputs and adds outputs
     *      In real Railgun, this requires a SNARK proof
     * @param inputNullifiers Nullifiers for notes being spent
     * @param outputCommitments New commitments being created
     * @param encryptedNotes Encrypted note data for each output
     * @param proof Mock proof (not verified in stub)
     */
    function transfer(
        bytes32[] calldata inputNullifiers,
        bytes32[] calldata outputCommitments,
        bytes[] calldata encryptedNotes,
        bytes calldata proof
    ) external {
        require(inputNullifiers.length > 0, "No inputs");
        require(outputCommitments.length > 0, "No outputs");
        require(outputCommitments.length == encryptedNotes.length, "Mismatched outputs");

        // In a real implementation, we would verify the SNARK proof here
        // For the stub, we just check that proof is non-empty
        require(proof.length > 0, "Empty proof");

        // Nullify all inputs
        for (uint256 i = 0; i < inputNullifiers.length; i++) {
            require(!nullifiers[inputNullifiers[i]], "Already nullified");
            nullifiers[inputNullifiers[i]] = true;
            emit Nullified(inputNullifiers[i]);
        }

        // Add all output commitments
        // Note: In the stub we don't track amounts per commitment, so we can't verify
        // that inputs = outputs. A real implementation would verify this in the SNARK.
        for (uint256 i = 0; i < outputCommitments.length; i++) {
            require(outputCommitments[i] != bytes32(0), "Invalid commitment");
            require(!commitmentExists[outputCommitments[i]], "Commitment already exists");

            uint256 index = commitments.length;
            commitments.push(outputCommitments[i]);
            commitmentExists[outputCommitments[i]] = true;

            // Emit with amount=0 since we don't track individual amounts in stub
            emit CommitmentInserted(index, outputCommitments[i], 0, encryptedNotes[i]);
        }
    }

    /**
     * @notice Unshield USDC back to a recipient
     * @dev In stub version, anyone can call with valid nullifier
     *      In real Railgun, this requires a SNARK proof
     * @param nullifier The nullifier for the note being spent
     * @param recipient Address to receive USDC
     * @param amount Amount to unshield
     */
    function unshield(
        bytes32 nullifier,
        address recipient,
        uint256 amount
    ) external {
        require(!nullifiers[nullifier], "Already nullified");
        require(totalShielded >= amount, "Insufficient shielded balance");
        require(recipient != address(0), "Invalid recipient");

        // Mark nullifier as spent
        nullifiers[nullifier] = true;
        totalShielded -= amount;

        emit Nullified(nullifier);
        emit Unshield(recipient, amount, nullifier);

        // Transfer USDC to recipient
        IERC20(usdc).safeTransfer(recipient, amount);
    }

    /**
     * @notice Unshield and burn for cross-chain transfer back to client
     * @param nullifier The nullifier for the note being spent
     * @param amount Amount to unshield
     * @param destinationChainId Target chain ID
     * @param destinationAddress Recipient on target chain
     */
    function unshieldToBridge(
        bytes32 nullifier,
        uint256 amount,
        uint32 destinationChainId,
        address destinationAddress
    ) external {
        require(!nullifiers[nullifier], "Already nullified");
        require(totalShielded >= amount, "Insufficient shielded balance");

        // Mark nullifier as spent
        nullifiers[nullifier] = true;
        totalShielded -= amount;

        emit Nullified(nullifier);
        emit Unshield(destinationAddress, amount, nullifier);

        // Approve and burn via CCTP
        IERC20(usdc).safeApprove(usdc, amount);
        IMockUSDC(usdc).burnForDeposit(
            amount,
            destinationChainId,
            destinationAddress,
            bytes("")  // Empty payload - direct mint to user
        );
    }

    // ============ View Functions ============

    /**
     * @notice Get commitment count
     */
    function getCommitmentCount() external view returns (uint256) {
        return commitments.length;
    }

    /**
     * @notice Get commitment at index
     */
    function getCommitment(uint256 index) external view returns (bytes32) {
        require(index < commitments.length, "Index out of bounds");
        return commitments[index];
    }

    /**
     * @notice Check if nullifier has been used
     */
    function isNullified(bytes32 nullifier) external view returns (bool) {
        return nullifiers[nullifier];
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
 * @notice Interface for MockUSDC burn
 */
interface IMockUSDC {
    function burnForDeposit(
        uint256 amount,
        uint32 destinationChainId,
        address destinationAddress,
        bytes calldata payload
    ) external returns (uint64);
}
