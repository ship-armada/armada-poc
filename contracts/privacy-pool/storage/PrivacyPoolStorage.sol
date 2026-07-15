// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../../railgun/logic/Globals.sol";

/**
 * @title PrivacyPoolStorage
 * @notice Shared storage layout for Hub PrivacyPool and all modules
 * @dev ALL modules inherit this contract. Storage slots MUST remain stable.
 *
 *      CRITICAL: When adding new state variables:
 *      - Add at the END of the contract (before __gap)
 *      - Decrement __gap size by the number of slots used
 *      - NEVER remove or reorder existing variables
 *
 *      This contract is used with delegatecall - the Router holds all state,
 *      and modules execute logic against the Router's storage.
 */
abstract contract PrivacyPoolStorage {
    // ══════════════════════════════════════════════════════════════════════════
    // DELEGATECALL GUARD
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice The address of the contract itself, set at deploy time (immutable, stored in bytecode)
    /// @dev Used by onlyDelegatecall to distinguish direct calls from delegatecalls.
    ///      When called via delegatecall, address(this) is the caller (PrivacyPool router),
    ///      not the module — so address(this) != _self and the check passes.
    ///      When called directly on the module, address(this) == _self and it reverts.
    address private immutable _self = address(this);

    /// @notice Ensures the function is only callable via delegatecall (not directly)
    modifier onlyDelegatecall() {
        require(address(this) != _self, "PrivacyPoolStorage: Direct call not allowed");
        _;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MODULE ADDRESSES
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev The four module addresses below are set once in initialize() and are INTENTIONALLY
    ///      IMMUTABLE — there is deliberately no setter for any of them. Each module holds fund
    ///      custody (Shield/Transact) or proof/tree logic (Verifier/Merkle); a swappable module
    ///      would let the owner redirect funds or accept forged proofs, reintroducing the trust
    ///      assumption rejected in issue #55. Mutable configuration lives in the setters on
    ///      PrivacyPool (fees, treasury, privileged callers, hook routers, fee module, pause
    ///      controller). NOTE: the VerifierModule contract is immutable, but its verification KEYS
    ///      remain owner-settable via setVerificationKey (needed for circuit/key upgrades) — that
    ///      key-custody risk is tracked separately in issue #349. See .claude/ARCHITECTURE_NOTES.md.

    /// @notice Address of ShieldModule implementation
    address public shieldModule;

    /// @notice Address of TransactModule implementation
    address public transactModule;

    /// @notice Address of MerkleModule implementation
    address public merkleModule;

    /// @notice Address of VerifierModule implementation
    address public verifierModule;

    // ══════════════════════════════════════════════════════════════════════════
    // CCTP CONFIGURATION
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice CCTP TokenMessenger contract address (ITokenMessengerV2)
    address public tokenMessenger;

    /// @notice CCTP MessageTransmitter contract address (IMessageTransmitterV2)
    address public messageTransmitter;

    /// @notice USDC token address on this chain
    address public usdc;

    /// @notice This chain's CCTP domain ID
    uint32 public localDomain;

    /// @notice Mapping of remote CCTP domain -> remote PrivacyPool/Client address (as bytes32)
    /// @dev Addresses are stored as bytes32 for CCTP compatibility
    mapping(uint32 => bytes32) public remotePools;

    // ══════════════════════════════════════════════════════════════════════════
    // TREASURY & FEES (deferred for POC - all set to 0)
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Treasury address for fee collection
    address payable public treasury;

    /// @notice Shield fee in basis points (100 = 1%), default 0 for POC
    uint120 public shieldFee;

    /// @notice DEPRECATED — unshield is free per spec.
    /// @dev Slot retained for storage layout compatibility with the delegatecall modules
    ///      (removing it would shift `nftFee` and every subsequent slot). Always 0.
    uint120 public unshieldFee;

    /// @notice NFT fee in basis points, default 0 for POC (required for SDK compatibility)
    uint120 public nftFee;

    /// @notice Addresses that bypass shield/unshield fees (e.g. yield adapter)
    mapping(address => bool) public privilegedShieldCallers;

    // ══════════════════════════════════════════════════════════════════════════
    // TOKEN MANAGEMENT
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Blocklist of tokens that cannot be shielded
    mapping(address => bool) public tokenBlocklist;

    /// @notice Mapping from token ID hash to TokenData for NFTs
    mapping(bytes32 => TokenData) public tokenIDMapping;

    // ══════════════════════════════════════════════════════════════════════════
    // MERKLE TREE STATE (from Commitments.sol)
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Depth of the merkle tree
    uint256 internal constant TREE_DEPTH = 16;

    /// @notice Zero value for empty leaves
    bytes32 public constant ZERO_VALUE = bytes32(uint256(keccak256("Railgun")) % SNARK_SCALAR_FIELD);

    /// @notice Index of next leaf to be inserted
    uint256 public nextLeafIndex;

    /// @notice Current merkle root
    bytes32 public merkleRoot;

    /// @notice Cached root of a fresh tree (for tree rollover)
    bytes32 internal newTreeRoot;

    /// @notice Current tree number (increments when tree is full)
    uint256 public treeNumber;

    /// @notice Zero values for each level of the tree
    bytes32[TREE_DEPTH] public zeros;

    /// @notice Right-most elements at each level (for efficient updates)
    bytes32[TREE_DEPTH] internal filledSubTrees;

    /// @notice Historical merkle roots: treeNumber -> root -> isValid
    mapping(uint256 => mapping(bytes32 => bool)) public rootHistory;

    /// @notice Spent nullifiers: treeNumber -> nullifier -> isSpent
    mapping(uint256 => mapping(bytes32 => bool)) public nullifiers;

    // ══════════════════════════════════════════════════════════════════════════
    // VERIFIER STATE
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Verification keys: nullifierCount -> commitmentCount -> VerifyingKey
    mapping(uint256 => mapping(uint256 => VerifyingKey)) internal verificationKeys;

    /// @notice Testing mode flag - bypasses SNARK verification (POC only, DO NOT USE IN PRODUCTION)
    bool public testingMode;

    // ══════════════════════════════════════════════════════════════════════════
    // SAFETY & MISCELLANEOUS
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Safety vectors for SNARK verification
    mapping(uint256 => bool) public snarkSafetyVector;

    /// @notice Block number of last event (for wallet sync)
    uint256 public lastEventBlock;

    /// @notice Contract owner
    address public owner;

    /// @notice Whether the contract has been initialized
    bool public initialized;

    /// @notice CCTP Hook Router address (authorized to call handleReceiveFinalizedMessage)
    address public hookRouter;

    /// @notice Default finality threshold for outbound CCTP burns (STANDARD=2000, FAST=1000)
    /// @dev Used by TransactModule for cross-chain unshields. Shields use per-transaction choice.
    uint32 public defaultFinalityThreshold;

    /// @notice Shield pause controller contract address (governance concern, external to pool)
    /// @dev ShieldModule calls IShieldPauseController(shieldPauseContract).shieldsPaused()
    ///      to check if shields are paused. When address(0), shields are never paused.
    address public shieldPauseContract;

    /// @notice Fee module address (ArmadaFeeModule proxy) for centralized fee calculation.
    /// @dev When address(0), ShieldModule falls back to the flat shieldFee calculation.
    address public feeModule;

    /// @notice CCTP hook router on each remote (destination) domain, as bytes32.
    /// @dev Used as the CCTP `destinationCaller` for outbound unshield burns so the message can only be
    ///      delivered through that chain's CCTPHookRouter (which fires the mint hook). Pinning this at the
    ///      contract level removes the caller-supplied `destinationCaller` footgun: bytes32(0) would let
    ///      any third party call receiveMessage directly, skip the hook, and strand the funds.
    mapping(uint32 => bytes32) public remoteHookRouters;

    /// @notice Reentrancy guard status for the router's state-changing entry points.
    /// @dev 0 = NOT_ENTERED, 1 = ENTERED. 0-based so a fresh slot needs no constructor init and the
    ///      value lives in shared pool storage (per the "all pool state in PrivacyPoolStorage" rule).
    ///      Used by PrivacyPool's nonReentrant modifier on shield / transact / atomicCrossChainUnshield.
    uint256 internal _reentrancyStatus;

    // ══════════════════════════════════════════════════════════════════════════
    // RESERVED FOR FUTURE USE
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Reserved storage slots for future upgrades
    ///      When adding new state variables above, decrement this gap
    uint256[44] private __gap;
}
