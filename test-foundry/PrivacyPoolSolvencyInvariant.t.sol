// ABOUTME: Invariant suite: for every token, the pool's balance covers the notes it treats as unspent.
// ABOUTME: Drives multi-asset shields, transfers, local and cross-chain unshields, CCTP shield-ins and yield (#608).
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/privacy-pool/CCTPBindingLib.sol";
import "../contracts/privacy-pool/types/PoseidonLibs.sol";
import "../contracts/cctp/MockUSDCV2.sol";
import "../contracts/cctp/MockCCTPV2.sol";
import "../contracts/cctp/CCTPHookRouter.sol";
import "../contracts/test/MockMessageHandlerV2.sol";
import "../contracts/yield/ArmadaYieldVault.sol";
import "../contracts/yield/ArmadaYieldAdapter.sol";
import "../contracts/yield/YieldAdaptParams.sol";
import "../contracts/aave-mock/MockAaveSpoke.sol";
import "../contracts/governance/MockAdapterRegistry.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "./helpers/PoseidonLinker.sol";

/// @title SolvencyHandler — drives the pool and mirrors the notes it treats as unspent
/// @dev The suite runs in testing mode, so proofs are not checked: the handler plays an honest
///      prover and only spends notes in its ghost ledger. Whenever the pool ACCEPTS an action, the
///      ledger is updated to match what the pool now treats as spent or unspent — including actions
///      that should be rejected (a non-USDC cross-chain unshield, a forged CCTP message). If one of
///      those were ever accepted, the per-token balance check in the invariant would fail.
///      Fees use the pool's flat shield fee; the fee-module branch is not driven here.
///      Yield runs through the real ArmadaYieldAdapter + ArmadaYieldVault + MockAaveSpoke, so value
///      moves between USDC notes and ayUSDC (vault share) notes. Those ghost notes take their values
///      from what the adapter reports (shares minted, assets redeemed), not from the pool's balance
///      change, so the per-token check verifies the pool really received what it credited.
contract SolvencyHandler is Test {
    struct Note {
        address token;
        uint120 value;
    }

    uint32 public constant HUB_DOMAIN = 0;
    uint32 public constant CLIENT_DOMAIN = 1;
    uint120 public constant SHIELD_FEE_BPS = 50;

    PrivacyPool public pool;
    MockUSDCV2 public usdc;
    MockUSDCV2 public other;
    CCTPHookRouter public router;
    ArmadaYieldAdapter public adapter;
    ArmadaYieldVault public vault;
    address public tokenMessenger;
    address public clientPool;
    address public forgedRecipient;

    address public shielder = address(0x5111E1D);
    address public recipient = address(0xBEEF);

    /// @notice Notes the pool currently treats as unspent (ghost ledger).
    Note[] public notes;
    uint256 internal _nonce = 1;

    // Coverage counters (successful calls).
    uint256 public calls_shield;
    uint256 public calls_transfer;
    uint256 public calls_unshieldLocal;
    uint256 public calls_unshieldCrossChain;
    uint256 public calls_shieldIn;
    uint256 public calls_lend;
    uint256 public calls_redeem;
    uint256 public calls_redeemWithFee;
    uint256 public calls_accrueYield;
    uint256 public rejected_crossChainNonUsdc;
    uint256 public rejected_forgedShieldIn;
    uint256 public rejected_tampered;

    /// @notice Tampered transactions (proof-unbound calldata changes, replays) the pool ACCEPTED.
    ///         Must stay zero.
    uint256 public tamperedAccepted;

    /// @notice Total of each token that honest local unshields paid to `recipient`.
    mapping(address => uint256) public paidToRecipient;

    /// @dev Nullifier of the most recent successful spend, for double-spend attempts.
    bytes32 internal _lastNullifier;
    bool internal _haveSpent;

    constructor(
        PrivacyPool _pool,
        MockUSDCV2 _usdc,
        MockUSDCV2 _other,
        CCTPHookRouter _router,
        ArmadaYieldAdapter _adapter,
        address _tokenMessenger,
        address _clientPool
    ) {
        pool = _pool;
        usdc = _usdc;
        other = _other;
        router = _router;
        adapter = _adapter;
        vault = ArmadaYieldVault(address(_adapter.vault()));
        tokenMessenger = _tokenMessenger;
        clientPool = _clientPool;
        forgedRecipient = address(new MockMessageHandlerV2());
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function noteCount() external view returns (uint256) {
        return notes.length;
    }

    /// @notice Sum of the values of unspent notes in `token`.
    function ghostTotal(address token) external view returns (uint256 total) {
        for (uint256 i = 0; i < notes.length; i++) {
            if (notes[i].token == token) total += notes[i].value;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ACTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Local shield of USDC or the other token.
    function shield(uint256 tokenSeed, uint256 amount) external {
        MockUSDCV2 token = tokenSeed % 2 == 0 ? usdc : other;
        amount = bound(amount, 1, 1_000_000e6);
        token.mint(shielder, amount);

        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage({npk: _npk(), token: _erc20(address(token)), value: uint120(amount)}),
            ciphertext: ShieldCiphertext({encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)], shieldKey: bytes32(0)})
        });

        uint256 before = token.balanceOf(address(pool));
        vm.startPrank(shielder);
        token.approve(address(pool), amount);
        try pool.shield(requests, address(0)) {
            // The note is worth exactly what stayed in the pool (amount minus the fee).
            notes.push(Note(address(token), uint120(token.balanceOf(address(pool)) - before)));
            calls_shield++;
        } catch {}
        vm.stopPrank();
    }

    /// @notice Private transfer: spend one note into two notes of the same token.
    function transfer(uint256 noteSeed, uint256 splitSeed) external {
        if (notes.length == 0) return;
        uint256 i = bound(noteSeed, 0, notes.length - 1);
        Note memory note = notes[i];
        uint120 first = uint120(bound(splitSeed, 0, note.value));

        bytes32[] memory commitments = new bytes32[](2);
        commitments[0] = keccak256(abi.encode("out", _nonce, 0));
        commitments[1] = keccak256(abi.encode("out", _nonce, 1));
        Transaction memory txn = _transaction(commitments, 2, UnshieldType.NONE, bytes32(0));

        if (_transact(txn)) {
            _recordSpend(txn);
            _removeNote(i);
            if (first > 0) notes.push(Note(note.token, first));
            if (note.value - first > 0) notes.push(Note(note.token, note.value - first));
            calls_transfer++;
        }
    }

    /// @notice Local unshield of part of a note, keeping the rest as change.
    function unshieldLocal(uint256 noteSeed, uint256 amountSeed) external {
        if (notes.length == 0) return;
        uint256 i = bound(noteSeed, 0, notes.length - 1);
        Note memory note = notes[i];
        uint120 value = uint120(bound(amountSeed, 1, note.value));

        CommitmentPreimage memory preimage = CommitmentPreimage({
            npk: bytes32(uint256(uint160(recipient))),
            token: _erc20(note.token),
            value: value
        });
        Transaction memory txn = _unshieldTransaction(note, preimage, bytes32(0));

        if (_transact(txn)) {
            _recordSpend(txn);
            _spendWithChange(i, note, value);
            paidToRecipient[note.token] += value;
            calls_unshieldLocal++;
        }
    }

    /// @notice Cross-chain unshield of part of a note. Must only succeed for USDC notes (#611).
    function unshieldCrossChain(uint256 noteSeed, uint256 amountSeed) external {
        if (notes.length == 0) return;
        uint256 i = bound(noteSeed, 0, notes.length - 1);
        Note memory note = notes[i];
        uint120 value = uint120(bound(amountSeed, 1, note.value));

        CommitmentPreimage memory preimage = CommitmentPreimage({
            npk: bytes32(uint256(uint160(address(pool)))),
            token: _erc20(note.token),
            value: value
        });
        Transaction memory txn = _unshieldTransaction(
            note, preimage, CCTPBindingLib.encode(recipient, CLIENT_DOMAIN, 0)
        );

        try pool.atomicCrossChainUnshield(txn, CLIENT_DOMAIN, recipient, 0, bytes32(0)) {
            // Mirror the pool even if it wrongly accepted a non-USDC note: it burned USDC and
            // spent this note, which the USDC balance check would then catch.
            _spendWithChange(i, note, value);
            calls_unshieldCrossChain++;
        } catch {
            if (note.token != address(usdc)) rejected_crossChainNonUsdc++;
        }
    }

    /// @notice Genuine cross-chain shield: a burn message addressed to the TokenMessenger.
    function shieldIn(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000e6);
        bytes memory message = _shieldInMessage(tokenMessenger, amount);

        uint256 before = usdc.balanceOf(address(pool));
        try router.relayWithHook(message, "") {
            notes.push(Note(address(usdc), uint120(usdc.balanceOf(address(pool)) - before)));
            calls_shieldIn++;
        } catch {}
    }

    /// @notice Forged shield: a generic message with a burn-shaped body that mints nothing (#613).
    function forgedShieldIn(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000e6);
        bytes memory message = _shieldInMessage(forgedRecipient, amount);

        try router.relayWithHook(message, "") {
            // Mirror the pool: it would have credited a note worth amount minus the shield fee
            // while receiving no USDC — the USDC balance check would then catch it.
            notes.push(Note(address(usdc), uint120(amount - (amount * SHIELD_FEE_BPS) / 10000)));
        } catch {
            rejected_forgedShieldIn++;
        }
    }

    /// @notice Yield lend: spend part of a USDC note into the vault; the adapter re-shields ayUSDC.
    function lend(uint256 noteSeed, uint256 amountSeed) external {
        (bool found, uint256 i) = _findNote(noteSeed, address(usdc));
        if (!found) return;
        Note memory note = notes[i];
        uint120 value = uint120(bound(amountSeed, 1, note.value));

        bytes32 npk = _npk();
        ShieldCiphertext memory ciphertext = _emptyCiphertext();
        Transaction memory txn = _adapterUnshield(
            note, value, YieldAdaptParams.encode(npk, ciphertext.encryptedBundle, ciphertext.shieldKey)
        );

        try adapter.lendAndShield(txn, npk, ciphertext) returns (uint256 shares) {
            _recordSpend(txn);
            _spendWithChange(i, note, value);
            notes.push(Note(address(vault), uint120(shares)));
            calls_lend++;
        } catch {}
    }

    /// @notice Yield redeem: spend part of an ayUSDC note; the adapter re-shields the USDC proceeds,
    ///         split between the user and (optionally) a relayer fee note bound in adaptParams.
    function redeem(uint256 noteSeed, uint256 sharesSeed, uint256 feeSeed) external {
        (bool found, uint256 i) = _findNote(noteSeed, address(vault));
        if (!found) return;
        Note memory note = notes[i];
        uint120 shares = uint120(bound(sharesSeed, 1, note.value));
        uint256 fee = bound(feeSeed, 0, adapter.previewRedeem(shares) / 2);

        bytes32 npk = _npk();
        bytes32 feeNpk = fee > 0 ? _npk() : bytes32(0);
        ShieldCiphertext memory ciphertext = _emptyCiphertext();
        Transaction memory txn = _adapterUnshield(
            note,
            shares,
            YieldAdaptParams.encode(
                npk, ciphertext.encryptedBundle, ciphertext.shieldKey,
                feeNpk, ciphertext.encryptedBundle, ciphertext.shieldKey, fee
            )
        );

        try adapter.redeemAndShield(txn, npk, ciphertext, feeNpk, ciphertext, fee) returns (uint256 assets) {
            _recordSpend(txn);
            _spendWithChange(i, note, shares);
            if (assets > fee) notes.push(Note(address(usdc), uint120(assets - fee)));
            if (fee > 0) {
                notes.push(Note(address(usdc), uint120(fee)));
                calls_redeemWithFee++;
            }
            calls_redeem++;
        } catch {}
    }

    /// @notice Let time pass so the mock Aave reserve accrues interest and redeems pay yield.
    function accrueYield(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 hours, 30 days));
        calls_accrueYield++;
    }

    // ═══════════════════════════════════════════════════════════════════
    // TAMPERED TRANSACTIONS (must all be rejected)
    // ═══════════════════════════════════════════════════════════════════
    // Each action builds an honest pending transaction for a ghost note, then changes something the
    // proof does not bind (or replays it on another path) the way a mempool watcher or relayer could.
    // If the pool accepts it, `tamperedAccepted` is bumped and the ledger mirrors what the pool did.

    /// @notice Local unshield with `npk + k·q`: same commitment hash, different payout address (#606).
    function tamperAliasedNpk(uint256 noteSeed, uint256 amountSeed, uint256 kSeed) external {
        if (notes.length == 0) return;
        uint256 i = bound(noteSeed, 0, notes.length - 1);
        Note memory note = notes[i];
        uint120 value = uint120(bound(amountSeed, 1, note.value));
        uint256 k = bound(kSeed, 1, 5);

        CommitmentPreimage memory honest = CommitmentPreimage({
            npk: bytes32(uint256(uint160(recipient))),
            token: _erc20(note.token),
            value: value
        });
        Transaction memory txn = _unshieldTransaction(note, honest, bytes32(0));
        txn.unshieldPreimage.npk = bytes32(uint256(uint160(recipient)) + k * SNARK_SCALAR_FIELD);

        if (_transact(txn)) {
            tamperedAccepted++;
            _spendWithChange(i, note, value); // paid to the aliased address, not `recipient`
        } else {
            rejected_tampered++;
        }
    }

    /// @notice A pending cross-chain proof (npk = pool) replayed through transact() (#364 / P1).
    function tamperReplayCrossChainAsLocal(uint256 noteSeed, uint256 amountSeed, bool aliasPool) external {
        if (notes.length == 0) return;
        uint256 i = bound(noteSeed, 0, notes.length - 1);
        Note memory note = notes[i];
        if (note.token != address(usdc)) return;
        uint120 value = uint120(bound(amountSeed, 1, note.value));

        CommitmentPreimage memory preimage = CommitmentPreimage({
            npk: bytes32(uint256(uint160(address(pool)))),
            token: _erc20(note.token),
            value: value
        });
        Transaction memory txn = _unshieldTransaction(
            note, preimage, CCTPBindingLib.encode(recipient, CLIENT_DOMAIN, 0)
        );
        if (aliasPool) {
            txn.unshieldPreimage.npk = bytes32(uint256(uint160(address(pool))) + SNARK_SCALAR_FIELD);
        }

        if (_transact(txn)) {
            tamperedAccepted++;
            _spendWithChange(i, note, value);
        } else {
            rejected_tampered++;
        }
    }

    /// @notice A pending cross-chain proof submitted with a different final recipient (#364 / #378).
    function tamperRedirectCrossChain(uint256 noteSeed, uint256 amountSeed) external {
        if (notes.length == 0) return;
        uint256 i = bound(noteSeed, 0, notes.length - 1);
        Note memory note = notes[i];
        if (note.token != address(usdc)) return;
        uint120 value = uint120(bound(amountSeed, 1, note.value));

        CommitmentPreimage memory preimage = CommitmentPreimage({
            npk: bytes32(uint256(uint160(address(pool)))),
            token: _erc20(note.token),
            value: value
        });
        Transaction memory txn = _unshieldTransaction(
            note, preimage, CCTPBindingLib.encode(recipient, CLIENT_DOMAIN, 0)
        );

        try pool.atomicCrossChainUnshield(txn, CLIENT_DOMAIN, address(0xA77AC4E5), 0, bytes32(0)) {
            tamperedAccepted++;
            _spendWithChange(i, note, value);
        } catch {
            rejected_tampered++;
        }
    }

    /// @notice Spends a nullifier that an earlier successful transaction already used.
    function tamperDoubleSpend(uint256 splitSeed) external {
        if (!_haveSpent) return;
        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = keccak256(abi.encode("double", _nonce, splitSeed));
        Transaction memory txn = _transaction(commitments, 1, UnshieldType.NONE, bytes32(0));
        txn.nullifiers[0] = _lastNullifier;
        // Same tree as the original spend: the handler never fills a tree, so this is tree 0.

        if (_transact(txn)) {
            tamperedAccepted++;
        } else {
            rejected_tampered++;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _recordSpend(Transaction memory txn) internal {
        _lastNullifier = txn.nullifiers[0];
        _haveSpent = true;
    }

    function _npk() internal returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode("npk", _nonce++))) % SNARK_SCALAR_FIELD);
    }

    function _erc20(address token) internal pure returns (TokenData memory) {
        return TokenData({tokenType: TokenType.ERC20, tokenAddress: token, tokenSubID: 0});
    }

    function _transaction(
        bytes32[] memory commitments,
        uint256 ciphertextCount,
        UnshieldType unshield,
        bytes32 adaptParams
    ) internal returns (Transaction memory txn) {
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = keccak256(abi.encode("nullifier", _nonce++));
        txn.merkleRoot = pool.merkleRoot();
        txn.nullifiers = nullifiers;
        txn.commitments = commitments;
        txn.boundParams.treeNumber = uint16(pool.treeNumber());
        txn.boundParams.unshield = unshield;
        txn.boundParams.chainID = uint64(block.chainid);
        txn.boundParams.adaptParams = adaptParams;
        txn.boundParams.commitmentCiphertext = new CommitmentCiphertext[](ciphertextCount);
    }

    /// @dev Unshield of `preimage` from `note`; a change commitment is added when value remains.
    function _unshieldTransaction(
        Note memory note,
        CommitmentPreimage memory preimage,
        bytes32 adaptParams
    ) internal returns (Transaction memory) {
        bool change = preimage.value < note.value;
        bytes32[] memory commitments = new bytes32[](change ? 2 : 1);
        if (change) commitments[0] = keccak256(abi.encode("change", _nonce));
        commitments[commitments.length - 1] = PoseidonT4.poseidon([
            preimage.npk,
            bytes32(uint256(uint160(preimage.token.tokenAddress))),
            bytes32(uint256(preimage.value))
        ]);
        Transaction memory txn = _transaction(commitments, commitments.length - 1, UnshieldType.NORMAL, adaptParams);
        txn.unshieldPreimage = preimage;
        return txn;
    }

    /// @dev First note in `token`, scanning from a fuzzed start index.
    function _findNote(uint256 seed, address token) internal view returns (bool, uint256) {
        if (notes.length == 0) return (false, 0);
        uint256 start = bound(seed, 0, notes.length - 1);
        for (uint256 k = 0; k < notes.length; k++) {
            uint256 i = (start + k) % notes.length;
            if (notes[i].token == token) return (true, i);
        }
        return (false, 0);
    }

    function _emptyCiphertext() internal pure returns (ShieldCiphertext memory) {
        return ShieldCiphertext({encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)], shieldKey: bytes32(0)});
    }

    /// @dev NORMAL unshield of `value` from `note` to the yield adapter, bound to it via adaptContract.
    function _adapterUnshield(Note memory note, uint120 value, bytes32 adaptParams)
        internal
        returns (Transaction memory txn)
    {
        CommitmentPreimage memory preimage = CommitmentPreimage({
            npk: bytes32(uint256(uint160(address(adapter)))),
            token: _erc20(note.token),
            value: value
        });
        txn = _unshieldTransaction(note, preimage, adaptParams);
        txn.boundParams.adaptContract = address(adapter);
    }

    function _transact(Transaction memory txn) internal returns (bool) {
        Transaction[] memory txns = new Transaction[](1);
        txns[0] = txn;
        try pool.transact(txns) {
            return true;
        } catch {
            return false;
        }
    }

    function _spendWithChange(uint256 i, Note memory note, uint120 spent) internal {
        _removeNote(i);
        if (note.value > spent) notes.push(Note(note.token, note.value - spent));
    }

    function _removeNote(uint256 i) internal {
        notes[i] = notes[notes.length - 1];
        notes.pop();
    }

    /// @dev A CCTP message from the client pool carrying a SHIELD of `amount` USDC, addressed to
    ///      `envelopeRecipient` (the TokenMessenger for a genuine burn; anything else is forged).
    function _shieldInMessage(address envelopeRecipient, uint256 amount) internal returns (bytes memory) {
        ShieldData[] memory shieldNotes = new ShieldData[](1);
        shieldNotes[0] = ShieldData({
            npk: _npk(),
            value: uint120(amount),
            encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
            shieldKey: bytes32(0),
            integrator: address(0)
        });
        bytes memory body = BurnMessageV2.encode(
            MessageV2.addressToBytes32(address(usdc)),
            MessageV2.addressToBytes32(address(pool)),
            amount,
            MessageV2.addressToBytes32(clientPool),
            0, // maxFee
            0, // feeExecuted
            0, // expirationBlock
            CCTPPayloadLib.encodeShield(shieldNotes)
        );
        return MessageV2.encode(
            CLIENT_DOMAIN,
            HUB_DOMAIN,
            bytes32(_nonce++),
            bytes32(uint256(0xC11E47)), // envelope sender (the mock TokenMessenger does not check it)
            MessageV2.addressToBytes32(envelopeRecipient),
            MessageV2.addressToBytes32(address(router)),
            2000,
            2000,
            body
        );
    }
}

/// @title PrivacyPoolSolvencyInvariantTest — per-token solvency of the shielded pool
contract PrivacyPoolSolvencyInvariantTest is Test, PoseidonLinker {
    PrivacyPool public pool;
    MockUSDCV2 public usdc;
    MockUSDCV2 public other;
    ArmadaYieldVault public vault;
    SolvencyHandler public handler;

    function setUp() public {
        _linkRealPoseidon();

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        other = new MockUSDCV2("Other", "OTH");

        MockMessageTransmitterV2 transmitter = new MockMessageTransmitterV2(0, address(this));
        MockTokenMessengerV2 messenger = new MockTokenMessengerV2(address(transmitter), address(usdc), 0);
        transmitter.setTokenMessenger(address(messenger));
        usdc.addMinter(address(messenger));

        pool = new PrivacyPool();
        pool.initialize(
            address(new ShieldModule()),
            address(new TransactModule()),
            address(new MerkleModule()),
            address(new VerifierModule()),
            address(messenger),
            address(transmitter),
            address(usdc),
            0, // localDomain
            address(this),
            payable(address(0xFEE))
        );
        pool.setTestingMode(true);
        pool.setShieldFee(50);

        CCTPHookRouter router = new CCTPHookRouter(address(transmitter), address(messenger));
        pool.setHookRouter(address(router));
        transmitter.setRelayer(address(router));

        address clientPool = address(0xC11E);
        pool.setRemotePool(1, MessageV2.addressToBytes32(clientPool));
        pool.setRemoteHookRouter(1, MessageV2.addressToBytes32(address(0xC11E4007)));

        // Yield stack, wired as in production: the adapter is authorized in the registry the pool
        // reads, so its re-shields are fee-exempt.
        MockAaveSpoke spoke = new MockAaveSpoke();
        usdc.addMinter(address(spoke));
        spoke.addReserve(address(usdc), 500, true); // 5% APY, yield minted on withdrawal
        vault = new ArmadaYieldVault(
            address(spoke), 0, address(new ArmadaTreasuryGov(address(this))), "Armada Yield USDC", "ayUSDC"
        );
        MockAdapterRegistry registry = new MockAdapterRegistry();
        ArmadaYieldAdapter adapter = new ArmadaYieldAdapter(address(usdc), address(vault), address(registry));
        registry.setAuthorized(address(adapter), true);
        adapter.setPrivacyPool(address(pool));
        pool.setAdapterRegistry(address(registry));

        handler = new SolvencyHandler(pool, usdc, other, router, adapter, address(messenger), clientPool);
        usdc.addMinter(address(handler));
        other.addMinter(address(handler));
        targetContract(address(handler));
    }

    /// @notice For every token, the pool holds exactly the value of the notes it treats as unspent.
    /// @dev WHY: the pool is multi-asset, so every outflow must be paid in the token of the note being
    ///      spent and every credited note must be backed by tokens actually received. A path that pays
    ///      USDC for another token's note (OQ-9, #611) or credits a note for a forged CCTP message
    ///      (#613) breaks this for USDC; both regressions were confirmed to fail this invariant.
    ///      Equality (not just >=) also catches value stuck in the pool with no note to spend it,
    ///      e.g. a cross-chain proof replayed as a pool->pool local unshield (#364).
    ///      The ayUSDC leg covers yield: a lend must leave the pool holding exactly the shares it
    ///      credited, and a redeem must bring back exactly the USDC it credited to the user and relayer.
    function invariant_poolCoversUnspentNotesPerToken() public view {
        assertEq(usdc.balanceOf(address(pool)), handler.ghostTotal(address(usdc)), "USDC notes not backed");
        assertEq(other.balanceOf(address(pool)), handler.ghostTotal(address(other)), "OTH notes not backed");
        assertEq(vault.balanceOf(address(pool)), handler.ghostTotal(address(vault)), "ayUSDC notes not backed");
    }

    /// @notice No tampered transaction is ever accepted.
    /// @dev WHY: changing what the proof does not bind — an aliased npk (#606), a cross-chain proof
    ///      replayed as a local unshield (#364/P1), a redirected cross-chain recipient (#378), or a
    ///      spent nullifier — must always revert, whatever its economic effect.
    function invariant_tamperedTransactionsRejected() public view {
        assertEq(handler.tamperedAccepted(), 0, "tampered transaction accepted");
    }

    /// @notice The honest recipient receives exactly what honest local unshields paid it, per token.
    /// @dev WHY: a payout redirected away from the intended recipient (or paid twice) leaves the pool
    ///      balanced but the recipient wrong; this ledger catches it.
    function invariant_recipientPaidExactly() public view {
        address r = handler.recipient();
        assertEq(usdc.balanceOf(r), handler.paidToRecipient(address(usdc)), "USDC recipient ledger");
        assertEq(other.balanceOf(r), handler.paidToRecipient(address(other)), "OTH recipient ledger");
        assertEq(vault.balanceOf(r), handler.paidToRecipient(address(vault)), "ayUSDC recipient ledger");
    }

    /// @notice WHY: guards against a vacuous invariant — if the handler's actions all reverted, the
    ///         ghost ledger would stay empty and the invariant would pass trivially. Every action must
    ///         be able to succeed here, and the two forbidden ones must be rejected.
    function test_handlerActionsAreLive() public {
        handler.shield(0, 1_000e6);          // USDC
        handler.shield(1, 1_000e6);          // other token
        handler.shieldIn(500e6);
        handler.transfer(0, 400e6);
        handler.unshieldLocal(0, 100e6);
        assertEq(handler.calls_shield(), 2, "shield");
        assertEq(handler.calls_shieldIn(), 1, "shieldIn");
        assertEq(handler.calls_transfer(), 1, "transfer");
        assertEq(handler.calls_unshieldLocal(), 1, "unshieldLocal");

        // A USDC cross-chain unshield succeeds; a non-USDC one is rejected.
        for (uint256 i = 0; i < handler.noteCount(); i++) {
            handler.unshieldCrossChain(i, 1);
        }
        assertGt(handler.calls_unshieldCrossChain(), 0, "cross-chain USDC unshield");
        assertGt(handler.rejected_crossChainNonUsdc(), 0, "cross-chain non-USDC rejected");

        handler.forgedShieldIn(100e6);
        assertEq(handler.rejected_forgedShieldIn(), 1, "forged shield-in rejected");

        // Every tampering action is rejected.
        handler.shield(0, 1_000e6);
        uint256 last = handler.noteCount() - 1;
        handler.tamperAliasedNpk(last, 10e6, 1);
        handler.tamperReplayCrossChainAsLocal(last, 10e6, false);
        handler.tamperReplayCrossChainAsLocal(last, 10e6, true);
        handler.tamperRedirectCrossChain(last, 10e6);
        handler.tamperDoubleSpend(0);
        assertEq(handler.rejected_tampered(), 5, "tampered transactions rejected");
        assertEq(handler.tamperedAccepted(), 0, "no tampered transaction accepted");

        // Yield: lend part of a USDC note, accrue interest, then redeem with and without a relayer fee.
        handler.shield(0, 1_000e6);
        handler.lend(handler.noteCount() - 1, 600e6);
        assertEq(handler.calls_lend(), 1, "lend");
        handler.accrueYield(30 days);
        assertEq(handler.calls_accrueYield(), 1, "accrueYield");
        handler.redeem(0, 100e6, 0);
        handler.redeem(0, 100e6, 1e6);
        assertEq(handler.calls_redeem(), 2, "redeem");
        assertEq(handler.calls_redeemWithFee(), 1, "redeem with relayer fee");
        assertGt(vault.balanceOf(address(pool)), 0, "pool holds ayUSDC for the unredeemed shares");

        invariant_poolCoversUnspentNotesPerToken();
        invariant_recipientPaidExactly();
    }
}
