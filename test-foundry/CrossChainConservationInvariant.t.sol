// ABOUTME: Invariant suite: USDC is conserved across a hub pool and a client pool on two mock CCTP
// ABOUTME: chains, with burns relayed in any order, replays and forged messages rejected (#616).
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/PrivacyPoolClient.sol";
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
import "./helpers/PoseidonLinker.sol";

/// @dev One chain's CCTP stack.
struct CctpChain {
    MockUSDCV2 usdc;
    MockMessageTransmitterV2 transmitter;
    MockTokenMessengerV2 messenger;
    CCTPHookRouter router;
}

/// @title CrossChainHandler — moves USDC between the hub and a client and relays the messages
/// @dev Genuine messages come only from the real burn paths (`PrivacyPoolClient.crossChainShield`,
///      `PrivacyPool.atomicCrossChainUnshield`): the handler captures each `MessageSent` and keeps it
///      pending until a relay action delivers it, in any order. Forged messages take the #613 shape:
///      a generic CCTP message (`sendMessage` is permissionless) addressed to a permissive handler,
///      whose burn-shaped body names the destination pool as mint recipient, so nothing is minted.
///      The mock TokenMessenger does not yet check the envelope sender (TODO in MockCCTPV2), so the
///      handler never sends a generic message to it: real CCTP would reject that, the mock would not.
///      The hub runs in testing mode (no proofs) with a 50 bps flat shield fee and no fee module.
contract CrossChainHandler is Test {
    uint32 public constant HUB_DOMAIN = 0;
    uint32 public constant CLIENT_DOMAIN = 1;
    uint120 public constant SHIELD_FEE_BPS = 50;
    bytes32 internal constant MESSAGE_SENT = keccak256("MessageSent(bytes)");

    struct Pending {
        bytes message;
        uint256 amount; // burned on the source chain
        uint256 fee;    // CCTP fee (the mock executes the full maxFee)
    }

    PrivacyPool public hubPool;
    PrivacyPoolClient public clientPool;
    CctpChain internal hub;
    CctpChain internal client;

    address public user = address(0x05E2);
    /// @notice Accepts any generic message: the envelope recipient of forged messages.
    address public permissiveHandler;
    /// @notice Client-chain recipient of every cross-chain unshield.
    address public recipient = address(0xBEEF);

    Pending[] internal _toHub;
    Pending[] internal _toClient;
    bytes[] internal _deliveredToHub;
    bytes[] internal _deliveredToClient;

    /// @notice USDC the handler minted to users, across both chains.
    uint256 public minted;
    /// @notice USDC burned on one chain and not yet minted on the other.
    uint256 public inFlight;
    /// @notice USDC that delivered hub→client unshields should have paid `recipient`.
    uint256 public paidToRecipient;
    /// @notice Hub notes the pool treats as unspent (USDC only).
    uint120[] public notes;

    /// @notice Replayed or forged messages that were accepted. Must stay zero.
    uint256 public replaysAccepted;
    uint256 public forgeriesAccepted;

    uint256 internal _nonce = 1;

    // Coverage counters (successful calls / rejections).
    uint256 public calls_clientShield;
    uint256 public calls_relayToHub;
    uint256 public calls_hubUnshield;
    uint256 public calls_relayToClient;
    uint256 public calls_outOfOrderRelay;
    uint256 public rejected_replay;
    uint256 public rejected_forgery;

    constructor(PrivacyPool _hubPool, PrivacyPoolClient _clientPool, CctpChain memory _hub, CctpChain memory _client) {
        hubPool = _hubPool;
        clientPool = _clientPool;
        hub = _hub;
        client = _client;
        permissiveHandler = address(new MockMessageHandlerV2());
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function pendingToHub() external view returns (uint256) { return _toHub.length; }
    function pendingToClient() external view returns (uint256) { return _toClient.length; }
    function noteCount() external view returns (uint256) { return notes.length; }

    function ghostNotesTotal() external view returns (uint256 total) {
        for (uint256 i = 0; i < notes.length; i++) total += notes[i];
    }

    // ═══════════════════════════════════════════════════════════════════
    // ACTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A user shields USDC from the client chain into the hub pool (burn on the client).
    function clientShield(uint256 amount, uint256 feeSeed, bool fast) external {
        amount = bound(amount, 2, 1_000_000e6);
        uint256 maxFee = bound(feeSeed, 0, amount / 100); // keep most of it: < amount, as CCTP requires
        client.usdc.mint(user, amount);
        minted += amount;

        vm.startPrank(user);
        client.usdc.approve(address(clientPool), amount);
        vm.recordLogs();
        clientPool.crossChainShield(
            amount, maxFee, fast ? 1000 : 2000, _npk(), [bytes32(0), bytes32(0), bytes32(0)], bytes32(0), address(0)
        );
        vm.stopPrank();

        _toHub.push(Pending(_lastMessageSent(address(client.transmitter)), amount, maxFee));
        inFlight += amount;
        calls_clientShield++;
    }

    /// @notice Deliver a pending client→hub shield, chosen from anywhere in the queue.
    function relayToHub(uint256 indexSeed) external {
        if (_toHub.length == 0) return;
        uint256 i = bound(indexSeed, 0, _toHub.length - 1);
        Pending memory p = _toHub[i];

        hub.router.relayWithHook(p.message, "");
        // The note is worth what arrived (amount - CCTP fee) less the hub's flat shield fee.
        uint256 arrived = p.amount - p.fee;
        notes.push(uint120(arrived - (arrived * SHIELD_FEE_BPS) / 10000));
        inFlight -= p.amount;
        _deliveredToHub.push(p.message);
        if (i != _toHub.length - 1) calls_outOfOrderRelay++;
        _removePending(_toHub, i);
        calls_relayToHub++;
    }

    /// @notice Unshield part of a hub note to `recipient` on the client chain (burn on the hub).
    function hubUnshield(uint256 noteSeed, uint256 amountSeed, uint256 feeSeed) external {
        if (notes.length == 0) return;
        uint256 i = bound(noteSeed, 0, notes.length - 1);
        uint120 note = notes[i];
        if (note < 2) return;
        uint120 value = uint120(bound(amountSeed, 2, note));
        uint256 maxFee = bound(feeSeed, 0, value / 100);

        Transaction memory txn = _unshieldTransaction(note, value, maxFee);
        vm.recordLogs();
        hubPool.atomicCrossChainUnshield(txn, CLIENT_DOMAIN, recipient, maxFee, bytes32(0));

        _spendWithChange(i, note, value);
        _toClient.push(Pending(_lastMessageSent(address(hub.transmitter)), value, maxFee));
        inFlight += value;
        calls_hubUnshield++;
    }

    /// @notice Deliver a pending hub→client unshield, chosen from anywhere in the queue.
    function relayToClient(uint256 indexSeed) external {
        if (_toClient.length == 0) return;
        uint256 i = bound(indexSeed, 0, _toClient.length - 1);
        Pending memory p = _toClient[i];

        client.router.relayWithHook(p.message, "");
        inFlight -= p.amount;
        paidToRecipient += p.amount - p.fee;
        _deliveredToClient.push(p.message);
        if (i != _toClient.length - 1) calls_outOfOrderRelay++;
        _removePending(_toClient, i);
        calls_relayToClient++;
    }

    /// @notice Re-deliver a message that was already delivered. Must be rejected.
    function replay(bool toHub, uint256 indexSeed) external {
        bytes[] storage delivered = toHub ? _deliveredToHub : _deliveredToClient;
        if (delivered.length == 0) return;
        bytes memory message = delivered[bound(indexSeed, 0, delivered.length - 1)];
        CCTPHookRouter router = toHub ? hub.router : client.router;
        try router.relayWithHook(message, "") {
            replaysAccepted++;
        } catch {
            rejected_replay++;
        }
    }

    /// @notice A burn-shaped generic message that mints nothing (#613): sent permissionlessly to a
    ///         permissive handler, with the destination pool as the body's mint recipient. If the
    ///         hook router dispatched it, the pool would act on USDC that never arrived. Must be
    ///         rejected.
    function forgeMessage(bool toHub, uint256 amount) external {
        amount = bound(amount, 1, 1_000_000e6);
        CctpChain memory source = toHub ? client : hub;
        address destinationPool = toHub ? address(hubPool) : address(clientPool);
        bytes memory hookData = toHub
            ? CCTPPayloadLib.encodeShield(_shieldNotes(amount))
            : CCTPPayloadLib.encodeUnshield(UnshieldData({recipient: recipient, uniqueNonce: bytes32(0)}));
        bytes memory body = BurnMessageV2.encode(
            MessageV2.addressToBytes32(address(source.usdc)),
            MessageV2.addressToBytes32(destinationPool),
            amount,
            MessageV2.addressToBytes32(toHub ? address(clientPool) : address(hubPool)),
            0, 0, 0,
            hookData
        );
        vm.recordLogs();
        source.transmitter.sendMessage(
            toHub ? HUB_DOMAIN : CLIENT_DOMAIN,
            MessageV2.addressToBytes32(permissiveHandler),
            bytes32(0),
            2000,
            body
        );
        bytes memory message = _lastMessageSent(address(source.transmitter));

        CCTPHookRouter router = toHub ? hub.router : client.router;
        try router.relayWithHook(message, "") {
            forgeriesAccepted++;
        } catch {
            rejected_forgery++;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev The full CCTP message from the most recent `MessageSent` emitted by `transmitter`.
    function _lastMessageSent(address transmitter) internal returns (bytes memory message) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory log = logs[i - 1];
            if (log.emitter == transmitter && log.topics[0] == MESSAGE_SENT) {
                return abi.decode(log.data, (bytes));
            }
        }
        revert("no MessageSent");
    }

    function _shieldNotes(uint256 amount) internal returns (ShieldData[] memory notes_) {
        notes_ = new ShieldData[](1);
        notes_[0] = ShieldData({
            npk: _npk(),
            value: uint120(amount),
            encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
            shieldKey: bytes32(0),
            integrator: address(0)
        });
    }

    /// @dev Cross-chain unshield of `value` from a note, bound to (recipient, CLIENT_DOMAIN, maxFee).
    function _unshieldTransaction(uint120 note, uint120 value, uint256 maxFee)
        internal
        returns (Transaction memory txn)
    {
        CommitmentPreimage memory preimage = CommitmentPreimage({
            npk: bytes32(uint256(uint160(address(hubPool)))),
            token: TokenData({tokenType: TokenType.ERC20, tokenAddress: address(hub.usdc), tokenSubID: 0}),
            value: value
        });
        bool change = value < note;
        bytes32[] memory commitments = new bytes32[](change ? 2 : 1);
        if (change) commitments[0] = keccak256(abi.encode("change", _nonce));
        commitments[commitments.length - 1] = PoseidonT4.poseidon([
            preimage.npk,
            bytes32(uint256(uint160(preimage.token.tokenAddress))),
            bytes32(uint256(preimage.value))
        ]);
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = keccak256(abi.encode("nullifier", _nonce++));
        txn.merkleRoot = hubPool.merkleRoot();
        txn.nullifiers = nullifiers;
        txn.commitments = commitments;
        txn.boundParams.treeNumber = uint16(hubPool.treeNumber());
        txn.boundParams.unshield = UnshieldType.NORMAL;
        txn.boundParams.chainID = uint64(block.chainid);
        txn.boundParams.adaptParams = CCTPBindingLib.encode(recipient, CLIENT_DOMAIN, maxFee);
        txn.boundParams.commitmentCiphertext = new CommitmentCiphertext[](commitments.length - 1);
        txn.unshieldPreimage = preimage;
    }

    function _spendWithChange(uint256 i, uint120 note, uint120 spent) internal {
        notes[i] = notes[notes.length - 1];
        notes.pop();
        if (note > spent) notes.push(note - spent);
    }

    function _removePending(Pending[] storage queue, uint256 i) internal {
        queue[i] = queue[queue.length - 1];
        queue.pop();
    }

    function _npk() internal returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode("npk", _nonce++))) % SNARK_SCALAR_FIELD);
    }
}

/// @title CrossChainConservationInvariantTest — hub ↔ client USDC conservation over mock CCTP
contract CrossChainConservationInvariantTest is Test, PoseidonLinker {
    uint32 internal constant HUB_DOMAIN = 0;
    uint32 internal constant CLIENT_DOMAIN = 1;

    PrivacyPool public hubPool;
    PrivacyPoolClient public clientPool;
    CctpChain internal hub;
    CctpChain internal client;
    CrossChainHandler public handler;

    function _chain(string memory name, uint32 domain) internal returns (CctpChain memory c) {
        c.usdc = new MockUSDCV2(name, "USDC");
        c.transmitter = new MockMessageTransmitterV2(domain, address(this));
        c.messenger = new MockTokenMessengerV2(address(c.transmitter), address(c.usdc), domain);
        c.transmitter.setTokenMessenger(address(c.messenger));
        c.usdc.addMinter(address(c.messenger));
        c.router = new CCTPHookRouter(address(c.transmitter), address(c.messenger));
        c.transmitter.setRelayer(address(c.router));
    }

    function setUp() public {
        _linkRealPoseidon();
        hub = _chain("Hub USDC", HUB_DOMAIN);
        client = _chain("Client USDC", CLIENT_DOMAIN);
        hub.messenger.setRemoteTokenMessenger(CLIENT_DOMAIN, MessageV2.addressToBytes32(address(client.messenger)));
        client.messenger.setRemoteTokenMessenger(HUB_DOMAIN, MessageV2.addressToBytes32(address(hub.messenger)));

        hubPool = new PrivacyPool();
        hubPool.initialize(
            address(new ShieldModule()),
            address(new TransactModule()),
            address(new MerkleModule()),
            address(new VerifierModule()),
            address(hub.messenger),
            address(hub.transmitter),
            address(hub.usdc),
            HUB_DOMAIN,
            address(this),
            payable(address(0xFEE))
        );
        hubPool.setTestingMode(true);
        hubPool.setShieldFee(50);
        hubPool.setHookRouter(address(hub.router));

        clientPool = new PrivacyPoolClient();
        clientPool.initialize(
            address(client.messenger),
            address(client.transmitter),
            address(client.usdc),
            CLIENT_DOMAIN,
            HUB_DOMAIN,
            MessageV2.addressToBytes32(address(hubPool)),
            address(this)
        );
        clientPool.setHookRouter(address(client.router));
        clientPool.setHubHookRouter(MessageV2.addressToBytes32(address(hub.router)));

        hubPool.setRemotePool(CLIENT_DOMAIN, MessageV2.addressToBytes32(address(clientPool)));
        hubPool.setRemoteHookRouter(CLIENT_DOMAIN, MessageV2.addressToBytes32(address(client.router)));

        handler = new CrossChainHandler(hubPool, clientPool, hub, client);
        client.usdc.addMinter(address(handler));
        targetContract(address(handler));
    }

    /// @notice USDC is conserved across both chains: supply on each plus what is in flight equals
    ///         what users were given.
    /// @dev WHY: a burn must mint exactly once, for exactly the burned amount (recipient plus CCTP
    ///      fee to the relayer). A double delivery, a mint without a burn, or a lost message would
    ///      break this. Fees stay inside each chain's supply (treasury, router).
    function invariant_usdcConservedAcrossChains() public view {
        assertEq(
            hub.usdc.totalSupply() + client.usdc.totalSupply() + handler.inFlight(),
            handler.minted(),
            "USDC not conserved"
        );
    }

    /// @notice The hub pool holds exactly the value of its unspent notes.
    /// @dev WHY: every delivered shield must credit a note worth what arrived, and every
    ///      cross-chain unshield must take from the pool exactly what it burns.
    function invariant_hubPoolBacksNotes() public view {
        assertEq(hub.usdc.balanceOf(address(hubPool)), handler.ghostNotesTotal(), "hub notes not backed");
    }

    /// @notice The client pool never pays out without a matching delivered hub burn.
    /// @dev WHY: the recipient may receive only what delivered hub→client unshields carried, and the
    ///      client pool must forward everything it is minted (it never holds USDC between actions).
    function invariant_clientPaysOnlyDeliveredBurns() public view {
        assertEq(client.usdc.balanceOf(handler.recipient()), handler.paidToRecipient(), "recipient paid wrongly");
        assertEq(client.usdc.balanceOf(address(clientPool)), 0, "client pool holds USDC");
    }

    /// @notice Every delivered message matches exactly one burn: no replay or forgery is accepted.
    /// @dev WHY: CCTP's nonce check stops replays, and the hook routers dispatch only messages
    ///      addressed to the TokenMessenger (which mints), so a generic message with a burn-shaped
    ///      body never reaches a pool's hook (#613).
    function invariant_noReplayOrForgeryAccepted() public view {
        assertEq(handler.replaysAccepted(), 0, "replay accepted");
        assertEq(handler.forgeriesAccepted(), 0, "forgery accepted");
    }

    /// @notice WHY: guards against vacuous invariants. Both directions must round-trip, a later
    ///         message must be deliverable before an earlier one, and replays, forged messages
    ///         and direct handler calls must all be rejected.
    function test_handlerActionsAreLive() public {
        handler.clientShield(1_000e6, 1e6, false);
        handler.clientShield(2_000e6, 0, true);
        handler.relayToHub(0); // the earlier message, delivered after the later one is still queued
        handler.relayToHub(0);
        assertEq(handler.calls_relayToHub(), 2, "both shields delivered");
        assertGt(handler.calls_outOfOrderRelay(), 0, "out-of-order delivery");

        handler.hubUnshield(0, 500e6, 2e6);
        handler.relayToClient(0);
        assertEq(handler.calls_relayToClient(), 1, "unshield delivered");
        assertGt(client.usdc.balanceOf(handler.recipient()), 0, "recipient paid");

        handler.replay(true, 0);
        handler.replay(false, 0);
        handler.forgeMessage(true, 100e6);
        handler.forgeMessage(false, 100e6);
        assertEq(handler.rejected_replay(), 2, "replays rejected");
        assertEq(handler.rejected_forgery(), 2, "forgeries rejected");

        // Calling a pool's CCTP handler directly (not via its hook router) is rejected.
        bytes memory body = BurnMessageV2.encode(bytes32(0), bytes32(0), 1, bytes32(0), 0, 0, 0, "");
        vm.expectRevert();
        hubPool.handleReceiveFinalizedMessage(CLIENT_DOMAIN, bytes32(0), 2000, body);
        vm.expectRevert("PrivacyPoolClient: Unauthorized caller");
        clientPool.handleReceiveFinalizedMessage(HUB_DOMAIN, bytes32(0), 2000, body);

        invariant_usdcConservedAcrossChains();
        invariant_hubPoolBacksNotes();
        invariant_clientPaysOnlyDeliveredBurns();
        invariant_noReplayOrForgeryAccepted();
    }
}
