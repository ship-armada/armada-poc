// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/privacy-pool/interfaces/IPrivacyPool.sol";
import "../contracts/privacy-pool/storage/PrivacyPoolStorage.sol";
import "../contracts/cctp/MockUSDCV2.sol";
import "../contracts/cctp/MockCCTPV2.sol";
import "../contracts/railgun/logic/Poseidon.sol";

// ══════════════════════════════════════════════════════════════════════════
// INV-B1: pool.USDC.balanceOf() = sum(shieldBase) - sum(unshieldGross)
// INV-B2: pool.USDC + treasury.USDC + recipients.USDC = sum(shieldGross)
// INV-B3: pool.USDC >= 0 (never goes negative / underflows)
// ══════════════════════════════════════════════════════════════════════════

/// @title PrivacyPoolBalanceHandler — Exercises shield + unshield with USDC balance tracking
/// @dev Tracks ghost variables for both shield and unshield flows to verify
///      the fundamental accounting invariant: pool USDC = shielded - unshielded.
contract PrivacyPoolBalanceHandler is Test {
    PrivacyPool public pool;
    MockUSDCV2 public usdc;
    address public treasury;

    // Ghost variables — shield side
    uint256 public ghost_totalShieldedGross;  // Total USDC passed to shield() (before fee)
    uint256 public ghost_totalShieldedBase;   // Total USDC that entered pool (after fee)
    uint256 public ghost_totalShieldFees;     // Total shield fees sent to treasury

    // Ghost variables — unshield side
    uint256 public ghost_totalUnshieldedGross; // Total value in unshield preimages
    uint256 public ghost_totalUnshieldedBase;  // Total USDC sent to recipients
    uint256 public ghost_totalUnshieldFees;    // Total unshield fees sent to treasury

    // Call counters
    uint256 public ghost_shieldCallCount;
    uint256 public ghost_unshieldCallCount;

    // Nullifier counter (to generate unique nullifiers)
    uint256 internal _nullifierNonce;

    // Actors
    address[] public shielders;
    uint256 constant USDC_PER_SHIELDER = 10_000_000 * 1e6; // 10M USDC each

    // Fee config (mirrors pool config)
    uint120 public shieldFeeBps;
    uint120 public unshieldFeeBps;

    uint120 private constant BASIS_POINTS = 10000;

    constructor(
        PrivacyPool _pool,
        MockUSDCV2 _usdc,
        address _treasury,
        address[] memory _shielders,
        uint120 _shieldFeeBps,
        uint120 _unshieldFeeBps
    ) {
        pool = _pool;
        usdc = _usdc;
        treasury = _treasury;
        shielders = _shielders;
        shieldFeeBps = _shieldFeeBps;
        unshieldFeeBps = _unshieldFeeBps;
    }

    // ═══════════════════════════════════════════════════════════════════
    // HANDLER ACTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Shield a random USDC amount into the privacy pool
    function shieldRandom(uint256 shielderIdx, uint256 amount, bytes32 npkSeed) external {
        if (shielders.length == 0) return;
        shielderIdx = bound(shielderIdx, 0, shielders.length - 1);
        amount = bound(amount, 1000, 1_000_000 * 1e6); // $0.001 to 1M USDC

        address shielder = shielders[shielderIdx];
        if (usdc.balanceOf(shielder) < amount) return;

        // Generate valid npk
        bytes32 npk = bytes32(uint256(keccak256(abi.encode(npkSeed, shielder))) % SNARK_SCALAR_FIELD);
        if (uint256(npk) == 0) npk = bytes32(uint256(1));

        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: npk,
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: address(usdc),
                    tokenSubID: 0
                }),
                value: uint120(amount)
            }),
            ciphertext: ShieldCiphertext({
                encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
                shieldKey: bytes32(0)
            })
        });

        // Calculate expected fee split (must match ShieldModule._getFee logic)
        uint120 expectedBase = uint120(amount - (amount * shieldFeeBps) / BASIS_POINTS);
        uint120 expectedFee = uint120(amount) - expectedBase;

        vm.startPrank(shielder);
        usdc.approve(address(pool), amount);

        try pool.shield(requests) {
            ghost_totalShieldedGross += amount;
            ghost_totalShieldedBase += expectedBase;
            ghost_totalShieldFees += expectedFee;
            ghost_shieldCallCount++;
        } catch {}
        vm.stopPrank();
    }

    /// @notice Unshield USDC from the privacy pool via transact()
    /// @dev Constructs a valid Transaction struct for a pure unshield (no change output).
    ///      Testing mode bypasses SNARK verification so we only need valid structural data.
    function unshieldRandom(uint256 recipientIdx, uint256 amount, bytes32 nullifierSeed) external {
        if (shielders.length == 0) return;
        recipientIdx = bound(recipientIdx, 0, shielders.length - 1);

        // Calculate max unshieldable: the pool's current USDC balance
        uint256 poolBalance = usdc.balanceOf(address(pool));
        if (poolBalance == 0) return;

        // Bound amount to pool balance (can't unshield more than pool holds)
        amount = bound(amount, 1, poolBalance);

        address recipient = shielders[recipientIdx];

        // Calculate expected fee split (must match TransactModule._getFee logic)
        uint120 expectedBase = uint120(amount - (amount * unshieldFeeBps) / BASIS_POINTS);
        uint120 expectedFee = uint120(amount) - expectedBase;

        // Build valid Transaction struct for unshield
        Transaction[] memory txs = new Transaction[](1);
        txs[0] = _buildUnshieldTransaction(recipient, uint120(amount), nullifierSeed);

        try pool.transact(txs) {
            ghost_totalUnshieldedGross += amount;
            ghost_totalUnshieldedBase += expectedBase;
            ghost_totalUnshieldFees += expectedFee;
            ghost_unshieldCallCount++;
        } catch {}
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Build a valid Transaction struct for a pure unshield
    function _buildUnshieldTransaction(
        address recipient,
        uint120 amount,
        bytes32 seed
    ) internal returns (Transaction memory) {
        // Generate unique nullifier
        _nullifierNonce++;
        bytes32 nullifier = keccak256(abi.encode(seed, _nullifierNonce));

        // Unshield preimage: npk encodes the recipient address
        CommitmentPreimage memory unshieldPreimage = CommitmentPreimage({
            npk: bytes32(uint256(uint160(recipient))),
            token: TokenData({
                tokenType: TokenType.ERC20,
                tokenAddress: address(usdc),
                tokenSubID: 0
            }),
            value: amount
        });

        // Hash the unshield preimage (this must be the last commitment)
        bytes32 unshieldHash = PoseidonT4.poseidon([
            unshieldPreimage.npk,
            bytes32(uint256(uint160(address(usdc)))), // tokenID for ERC20
            bytes32(uint256(amount))
        ]);

        // Build nullifiers array (1 nullifier for the spent note)
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = nullifier;

        // Build commitments array (1 commitment = the unshield hash)
        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = unshieldHash;

        // Empty ciphertext array (commitments.length - 1 = 0 for pure unshield)
        CommitmentCiphertext[] memory emptyCiphertext = new CommitmentCiphertext[](0);

        // Bound params
        BoundParams memory boundParams = BoundParams({
            treeNumber: uint16(pool.treeNumber()),
            minGasPrice: 0,
            unshield: UnshieldType.NORMAL,
            chainID: uint64(block.chainid),
            adaptContract: address(0),
            adaptParams: bytes32(0),
            commitmentCiphertext: emptyCiphertext
        });

        // Dummy SNARK proof (bypassed in testing mode)
        SnarkProof memory proof = SnarkProof({
            a: G1Point(0, 0),
            b: G2Point([uint256(0), uint256(0)], [uint256(0), uint256(0)]),
            c: G1Point(0, 0)
        });

        return Transaction({
            proof: proof,
            merkleRoot: pool.merkleRoot(),
            nullifiers: nullifiers,
            commitments: commitments,
            boundParams: boundParams,
            unshieldPreimage: unshieldPreimage
        });
    }
}

/// @title PrivacyPoolBalanceInvariantTest — Verifies USDC conservation across shield + unshield
/// @dev The core property: at any point, the pool's USDC balance equals the total USDC
///      shielded (base, after fee) minus the total USDC unshielded (gross, before fee split).
///      Fees always go to treasury. This is the fundamental safety property that ensures
///      the pool is always solvent.
contract PrivacyPoolBalanceInvariantTest is Test {
    PrivacyPool public pool;
    ShieldModule public shieldModule;
    TransactModule public transactModule;
    MerkleModule public merkleModule;
    VerifierModule public verifierModule;
    MockUSDCV2 public usdc;
    MockTokenMessengerV2 public tokenMessenger;
    MockMessageTransmitterV2 public messageTransmitter;
    PrivacyPoolBalanceHandler public handler;

    address public treasury;
    address public owner;
    address[] public shielders;

    uint256 constant USDC_PER_SHIELDER = 10_000_000 * 1e6;
    uint120 constant SHIELD_FEE_BPS = 50;   // 0.5%
    uint120 constant UNSHIELD_FEE_BPS = 50; // 0.5%

    function setUp() public {
        owner = address(this);
        treasury = address(0xFEE);

        // Deploy tokens
        usdc = new MockUSDCV2("Mock USDC", "USDC");

        // Deploy CCTP mocks
        messageTransmitter = new MockMessageTransmitterV2(0, address(this));
        tokenMessenger = new MockTokenMessengerV2(address(messageTransmitter), address(usdc), 0);
        messageTransmitter.setTokenMessenger(address(tokenMessenger));

        // Deploy modules
        shieldModule = new ShieldModule();
        transactModule = new TransactModule();
        merkleModule = new MerkleModule();
        verifierModule = new VerifierModule();

        // Deploy pool
        pool = new PrivacyPool();
        pool.initialize(
            address(shieldModule),
            address(transactModule),
            address(merkleModule),
            address(verifierModule),
            address(tokenMessenger),
            address(messageTransmitter),
            address(usdc),
            0, // localDomain
            owner
        );

        // Enable testing mode (bypass SNARK verification)
        pool.setTestingMode(true);

        // Set treasury and fees
        pool.setTreasury(payable(treasury));
        pool.setShieldFee(SHIELD_FEE_BPS);
        pool.setUnshieldFee(UNSHIELD_FEE_BPS);

        // Create shielders and fund them
        for (uint256 i = 0; i < 10; i++) {
            address shielder = address(uint160(0xB000 + i));
            shielders.push(shielder);
            usdc.mint(shielder, USDC_PER_SHIELDER);
        }

        // Create handler
        handler = new PrivacyPoolBalanceHandler(
            pool, usdc, treasury, shielders,
            SHIELD_FEE_BPS, UNSHIELD_FEE_BPS
        );

        // Target the handler
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = PrivacyPoolBalanceHandler.shieldRandom.selector;
        selectors[1] = PrivacyPoolBalanceHandler.unshieldRandom.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-B1: Pool USDC balance = shielded base - unshielded gross
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Pool balance tracks exactly: sum of shield base amounts minus sum of unshield gross amounts
    /// @dev shield(amount) → pool gets base = amount - fee
    ///      unshield(value) → pool loses value (base goes to recipient, fee goes to treasury)
    function invariant_poolBalanceEquation() public view {
        uint256 poolBalance = usdc.balanceOf(address(pool));
        uint256 expectedBalance = handler.ghost_totalShieldedBase() - handler.ghost_totalUnshieldedGross();

        assertEq(
            poolBalance,
            expectedBalance,
            "INV-B1: Pool USDC balance != shieldedBase - unshieldedGross"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-B2: Total USDC conservation (pool + treasury + recipients = gross shielded)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice All USDC is conserved across pool, treasury, and recipient balances
    /// @dev The total USDC that entered the system (from shielders) must equal the sum
    ///      of pool balance + treasury balance + total sent to recipients.
    function invariant_totalUsdcConservation() public view {
        uint256 poolBalance = usdc.balanceOf(address(pool));
        uint256 treasuryBalance = usdc.balanceOf(treasury);
        uint256 totalRecipientReceived = handler.ghost_totalUnshieldedBase();

        assertEq(
            poolBalance + treasuryBalance + totalRecipientReceived,
            handler.ghost_totalShieldedGross(),
            "INV-B2: USDC not conserved (pool + treasury + recipients != shieldedGross)"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-B3: Treasury balance = sum of all fees (shield + unshield)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Treasury receives exactly the sum of all shield and unshield fees
    function invariant_treasuryFeeAccumulation() public view {
        uint256 treasuryBalance = usdc.balanceOf(treasury);
        uint256 expectedTreasury = handler.ghost_totalShieldFees() + handler.ghost_totalUnshieldFees();

        assertEq(
            treasuryBalance,
            expectedTreasury,
            "INV-B3: Treasury balance != totalShieldFees + totalUnshieldFees"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-B4: Pool is always solvent (balance >= 0, implied by uint256)
    //         More specifically: shieldedBase >= unshieldedGross
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Pool never becomes insolvent — total shielded base always >= total unshielded
    function invariant_poolSolvency() public view {
        assertGe(
            handler.ghost_totalShieldedBase(),
            handler.ghost_totalUnshieldedGross(),
            "INV-B4: Pool insolvent (shieldedBase < unshieldedGross)"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-B5: Fee math consistency — fees are always non-negative
    //         and base + fee = gross for each operation type
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Shield fee accounting: shieldedBase + shieldFees = shieldedGross
    function invariant_shieldFeeConsistency() public view {
        assertEq(
            handler.ghost_totalShieldedBase() + handler.ghost_totalShieldFees(),
            handler.ghost_totalShieldedGross(),
            "INV-B5a: shieldedBase + shieldFees != shieldedGross"
        );
    }

    /// @notice Unshield fee accounting: unshieldedBase + unshieldFees = unshieldedGross
    function invariant_unshieldFeeConsistency() public view {
        assertEq(
            handler.ghost_totalUnshieldedBase() + handler.ghost_totalUnshieldFees(),
            handler.ghost_totalUnshieldedGross(),
            "INV-B5b: unshieldedBase + unshieldFees != unshieldedGross"
        );
    }
}
