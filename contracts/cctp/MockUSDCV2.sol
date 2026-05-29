// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC20Permit.sol";

/**
 * @title MockUSDCV2
 * @notice Simple USDC mock for CCTP V2 testing with EIP-2612 permit support
 * @dev ERC20 token with mint/burn + permit (gasless approvals).
 *      The CCTP logic has been moved to MockTokenMessengerV2 and MockMessageTransmitterV2
 *      to match Circle's real architecture.
 *
 * Permit support is required for Phase B's GaslessShieldWrapper (see
 * `.claude/RELAYER_MEDIATION_PLAN.md`). Real Sepolia USDC + mainnet USDC v2.2+ both implement
 * EIP-2612, so this mock matches the real interface for production drop-in replacement —
 * non-permit callers see zero behaviour change.
 *
 * In production:
 *   - Replace with real USDC address on each chain
 *   - No code changes needed in other contracts
 */
contract MockUSDCV2 is ERC20, ERC20Permit {
    // Addresses allowed to mint (TokenMessenger on this chain)
    mapping(address => bool) public minters;

    // Owner for configuration
    address public owner;

    event MinterAdded(address indexed minter);
    event MinterRemoved(address indexed minter);

    constructor(string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        owner = msg.sender;
        minters[msg.sender] = true; // Deployer can mint for initial funding
    }

    modifier onlyMinter() {
        require(minters[msg.sender], "Not a minter");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    /**
     * @notice Add a minter (e.g., TokenMessenger)
     */
    function addMinter(address minter) external onlyOwner {
        minters[minter] = true;
        emit MinterAdded(minter);
    }

    /**
     * @notice Remove a minter
     */
    function removeMinter(address minter) external onlyOwner {
        minters[minter] = false;
        emit MinterRemoved(minter);
    }

    /**
     * @notice Mint tokens
     * @dev Called by TokenMessenger when receiving cross-chain transfers
     */
    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from caller
     * @dev Called by TokenMessenger when initiating cross-chain transfers
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /**
     * @notice Burn tokens from an address (requires approval)
     */
    function burnFrom(address account, uint256 amount) external {
        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
    }

    /**
     * @notice Override decimals to match USDC (6 decimals)
     */
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @notice Transfer ownership
     */
    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
