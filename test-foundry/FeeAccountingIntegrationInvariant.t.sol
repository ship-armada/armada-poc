// ABOUTME: Invariant suite: the fee module's records match the fees the treasury and integrators
// ABOUTME: actually received, driven through the real pool, fee module and yield vault (#616).
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "../contracts/cctp/MockUSDCV2.sol";
import "../contracts/cctp/MockCCTPV2.sol";
import "../contracts/cctp/CCTPHookRouter.sol";
import "../contracts/fees/ArmadaFeeModule.sol";
import "../contracts/yield/ArmadaYieldVault.sol";
import "../contracts/aave-mock/MockAaveSpoke.sol";
import "./helpers/PoseidonLinker.sol";

/// @title FeeAccountingHandler — drives fee-generating actions and mirrors what was actually paid
/// @dev The "actual" side of every check is a token balance or an amount the handler itself
///      requested, never the fee module's own bookkeeping. The treasury and integrator addresses
///      receive tokens only as fees, so their USDC balances are the fees actually paid.
///      The handler is the fee module's owner, so it can also change rates mid-run.
contract FeeAccountingHandler is Test {
    uint32 public constant HUB_DOMAIN = 0;
    uint32 public constant CLIENT_DOMAIN = 1;

    PrivacyPool public pool;
    MockUSDCV2 public usdc;
    MockUSDCV2 public other;
    ArmadaFeeModule public feeModule;
    ArmadaYieldVault public vault;
    CCTPHookRouter public router;
    address public tokenMessenger;
    address public clientPool;

    address public shielder = address(0x5111E1D);
    address public lender = address(0x1E4D);
    address[3] public integrators = [address(0x1A1), address(0x1A2), address(0x1A3)];

    /// @notice Gross USDC each integrator routed while registered (what its volume must equal).
    mapping(address => uint256) public usdcVolume;

    /// @notice Times `cumulativeFeesCollected()` was seen to decrease. Must stay zero.
    uint256 public feeCounterDecreases;
    uint256 internal _lastFeeCounter;
    uint256 internal _nonce = 1;

    // Coverage counters (successful calls).
    uint256 public calls_shieldUsdc;
    uint256 public calls_shieldOther;
    uint256 public calls_shieldViaIntegrator;
    uint256 public calls_shieldIn;
    uint256 public calls_registerIntegrator;
    uint256 public calls_govern;
    uint256 public calls_lend;
    uint256 public calls_redeem;
    uint256 public calls_harvest;

    constructor(
        PrivacyPool _pool,
        MockUSDCV2 _usdc,
        MockUSDCV2 _other,
        ArmadaYieldVault _vault,
        CCTPHookRouter _router,
        address _tokenMessenger,
        address _clientPool
    ) {
        pool = _pool;
        usdc = _usdc;
        other = _other;
        vault = _vault;
        router = _router;
        tokenMessenger = _tokenMessenger;
        clientPool = _clientPool;
    }

    /// @dev Set after construction: the fee module is initialized with this handler as owner.
    function setFeeModule(ArmadaFeeModule _feeModule) external {
        require(address(feeModule) == address(0), "already set");
        feeModule = _feeModule;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ACTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Local shield of USDC or the other token, optionally through an integrator.
    function shield(uint256 tokenSeed, uint256 integratorSeed, uint256 amount) external {
        MockUSDCV2 token = tokenSeed % 2 == 0 ? usdc : other;
        address integrator = _integrator(integratorSeed);
        amount = bound(amount, 1, 1_000_000e6);
        bool registered = _registered(integrator);
        token.mint(shielder, amount);

        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage({npk: _npk(), token: _erc20(address(token)), value: uint120(amount)}),
            ciphertext: _emptyCiphertext()
        });
        vm.startPrank(shielder);
        token.approve(address(pool), amount);
        try pool.shield(requests, integrator) {
            if (token == usdc) {
                calls_shieldUsdc++;
                if (registered) usdcVolume[integrator] += amount;
            } else {
                calls_shieldOther++;
            }
            if (registered) calls_shieldViaIntegrator++;
        } catch {}
        vm.stopPrank();
        _checkFeeCounter();
    }

    /// @notice Cross-chain USDC shield-in (fee module's `_applyShieldFee` path).
    function shieldIn(uint256 integratorSeed, uint256 amount) external {
        address integrator = _integrator(integratorSeed);
        amount = bound(amount, 1, 1_000_000e6);
        bool registered = _registered(integrator);

        try router.relayWithHook(_shieldInMessage(amount, integrator), "") {
            calls_shieldIn++;
            if (registered) usdcVolume[integrator] += amount;
        } catch {}
        _checkFeeCounter();
    }

    /// @notice An integrator registers or changes its base fee.
    function registerIntegrator(uint256 integratorSeed, uint256 feeSeed) external {
        address integrator = integrators[bound(integratorSeed, 0, 2)];
        // Compute the argument first: vm.prank applies to the next external call, and the
        // MAX_INTEGRATOR_FEE_BPS() getter would otherwise consume it.
        uint256 feeBps = bound(feeSeed, 0, feeModule.MAX_INTEGRATOR_FEE_BPS());
        vm.prank(integrator);
        feeModule.setIntegratorFee(feeBps);
        calls_registerIntegrator++;
        _checkFeeCounter();
    }

    /// @notice Governance changes a rate: base take, a new tier, or an integrator's custom terms.
    function govern(uint256 actionSeed, uint256 valueSeed, uint256 integratorSeed) external {
        uint256 action = actionSeed % 3;
        uint256 bps = bound(valueSeed, 0, feeModule.MAX_BPS());
        if (action == 0) {
            feeModule.setBaseArmadaTake(bps);
        } else if (action == 1) {
            try feeModule.addTier(bound(valueSeed, 1, 2_000_000e6), bps) {} catch { return; }
        } else {
            feeModule.setIntegratorTerms(integrators[bound(integratorSeed, 0, 2)], bps, valueSeed % 2 == 0);
        }
        calls_govern++;
        _checkFeeCounter();
    }

    /// @notice The lender deposits USDC into the yield vault.
    function lend(uint256 amount) external {
        amount = bound(amount, 2e6, 1_000_000e6); // above the first-deposit share lock
        usdc.mint(lender, amount);
        vm.startPrank(lender);
        usdc.approve(address(vault), amount);
        try vault.deposit(amount, lender) {
            calls_lend++;
        } catch {}
        vm.stopPrank();
        _checkFeeCounter();
    }

    /// @notice The lender redeems some shares; this settles the vault's yield fee to the treasury.
    function redeem(uint256 sharesSeed) external {
        uint256 balance = vault.balanceOf(lender);
        if (balance == 0) return;
        vm.prank(lender);
        try vault.redeem(bound(sharesSeed, 1, balance), lender, lender) {
            calls_redeem++;
        } catch {}
        _checkFeeCounter();
    }

    /// @notice Time passes so the vault earns yield.
    function accrueYield(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 hours, 30 days));
    }

    /// @notice Permissionless harvest of the vault's yield fee (cadence-gated).
    function harvest() external {
        try vault.harvestProtocolFee() {
            calls_harvest++;
        } catch {}
        _checkFeeCounter();
    }

    // ═══════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev One of the three integrators, or address(0) (no integrator) for a quarter of seeds.
    function _integrator(uint256 seed) internal view returns (address) {
        uint256 i = seed % 4;
        return i == 3 ? address(0) : integrators[i];
    }

    function _registered(address integrator) internal view returns (bool) {
        return integrator != address(0) && feeModule.getIntegratorInfo(integrator).registered;
    }

    function _checkFeeCounter() internal {
        uint256 current = feeModule.cumulativeFeesCollected();
        if (current < _lastFeeCounter) feeCounterDecreases++;
        _lastFeeCounter = current;
    }

    function _npk() internal returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode("npk", _nonce++))) % SNARK_SCALAR_FIELD);
    }

    function _erc20(address token) internal pure returns (TokenData memory) {
        return TokenData({tokenType: TokenType.ERC20, tokenAddress: token, tokenSubID: 0});
    }

    function _emptyCiphertext() internal pure returns (ShieldCiphertext memory) {
        return ShieldCiphertext({encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)], shieldKey: bytes32(0)});
    }

    /// @dev A burn message from the client pool carrying a single-note SHIELD of `amount` USDC,
    ///      addressed to the hub TokenMessenger (as real CCTP delivers it), with no CCTP fee.
    function _shieldInMessage(uint256 amount, address integrator) internal returns (bytes memory) {
        ShieldData[] memory notes = new ShieldData[](1);
        notes[0] = ShieldData({
            npk: _npk(),
            value: uint120(amount),
            encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
            shieldKey: bytes32(0),
            integrator: integrator
        });
        bytes memory body = BurnMessageV2.encode(
            MessageV2.addressToBytes32(address(usdc)),
            MessageV2.addressToBytes32(address(pool)),
            amount,
            MessageV2.addressToBytes32(clientPool),
            0, // maxFee
            0, // feeExecuted
            0, // expirationBlock
            CCTPPayloadLib.encodeShield(notes)
        );
        return MessageV2.encode(
            CLIENT_DOMAIN,
            HUB_DOMAIN,
            bytes32(_nonce++),
            bytes32(uint256(0xC11E47)), // envelope sender (the mock TokenMessenger does not check it)
            MessageV2.addressToBytes32(tokenMessenger),
            MessageV2.addressToBytes32(address(router)),
            2000,
            2000,
            body
        );
    }
}

/// @title FeeAccountingIntegrationInvariantTest — fee module records vs fees actually paid
contract FeeAccountingIntegrationInvariantTest is Test, PoseidonLinker {
    address internal constant TREASURY = address(0x7EA5);

    PrivacyPool public pool;
    MockUSDCV2 public usdc;
    MockUSDCV2 public other;
    ArmadaFeeModule public feeModule;
    ArmadaYieldVault public vault;
    FeeAccountingHandler public handler;

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
            payable(TREASURY)
        );

        CCTPHookRouter router = new CCTPHookRouter(address(transmitter), address(messenger));
        pool.setHookRouter(address(router));
        transmitter.setRelayer(address(router));
        address clientPool = address(0xC11E);
        pool.setRemotePool(1, MessageV2.addressToBytes32(clientPool));

        MockAaveSpoke spoke = new MockAaveSpoke();
        usdc.addMinter(address(spoke));
        spoke.addReserve(address(usdc), 500, true); // 5% APY, yield minted on withdrawal
        vault = new ArmadaYieldVault(address(spoke), 0, TREASURY, "Armada Yield USDC", "ayUSDC");

        handler = new FeeAccountingHandler(pool, usdc, other, vault, router, address(messenger), clientPool);
        ArmadaFeeModule impl = new ArmadaFeeModule();
        feeModule = ArmadaFeeModule(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                ArmadaFeeModule.initialize,
                (address(handler), TREASURY, address(pool), address(vault), address(usdc))
            )
        )));
        handler.setFeeModule(feeModule);
        pool.setFeeModule(address(feeModule));
        vault.setFeeModule(address(feeModule));

        usdc.addMinter(address(handler));
        other.addMinter(address(handler));
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = FeeAccountingHandler.shield.selector;
        selectors[1] = FeeAccountingHandler.shieldIn.selector;
        selectors[2] = FeeAccountingHandler.registerIntegrator.selector;
        selectors[3] = FeeAccountingHandler.govern.selector;
        selectors[4] = FeeAccountingHandler.lend.selector;
        selectors[5] = FeeAccountingHandler.redeem.selector;
        selectors[6] = FeeAccountingHandler.accrueYield.selector;
        selectors[7] = FeeAccountingHandler.harvest.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice The fee module's protocol-fee total equals the USDC the treasury actually received.
    /// @dev WHY: `cumulativeFeesCollected()` is the revenue figure governance reads (IFeeCollector).
    ///      The treasury receives USDC only as protocol fees (shield takes and yield fees), so its
    ///      balance is the ground truth. Counting a non-USDC fee as USDC (#605) or missing a fee
    ///      path would make them differ.
    function invariant_feeCounterMatchesTreasuryUsdc() public view {
        assertEq(feeModule.cumulativeFeesCollected(), usdc.balanceOf(TREASURY), "fee counter != treasury USDC");
    }

    /// @notice Each integrator's recorded earnings equal the USDC it actually received.
    /// @dev WHY: integrator payouts and the earnings record come from separate code paths (the pool
    ///      pays, the fee module records). Integrators receive tokens only as fees.
    function invariant_integratorEarningsMatchUsdcReceived() public view {
        uint256 total;
        for (uint256 i = 0; i < 3; i++) {
            address integrator = handler.integrators(i);
            uint256 received = usdc.balanceOf(integrator);
            assertEq(feeModule.getIntegratorInfo(integrator).cumulativeEarnings, received, "integrator earnings");
            total += received;
        }
        assertEq(feeModule.cumulativeIntegratorFees(), total, "total integrator fees");
    }

    /// @notice Each integrator's recorded volume equals the USDC it routed while registered.
    /// @dev WHY: volume drives the tier discounts. Counting another token's amounts as USDC volume
    ///      (#605) or volume from before registration would hand out discounts nobody earned.
    function invariant_integratorVolumeMatchesUsdcShielded() public view {
        for (uint256 i = 0; i < 3; i++) {
            address integrator = handler.integrators(i);
            assertEq(
                feeModule.getIntegratorInfo(integrator).cumulativeVolume,
                handler.usdcVolume(integrator),
                "integrator volume"
            );
        }
    }

    /// @notice The protocol-fee total never decreases.
    /// @dev WHY: consumers treat it as a monotonic counter (IFeeCollector).
    function invariant_feeCounterNeverDecreases() public view {
        assertEq(handler.feeCounterDecreases(), 0, "cumulativeFeesCollected decreased");
    }

    /// @notice WHY: guards against vacuous invariants. Every fee path must be exercised: USDC and
    ///         other-token shields, integrator shields, cross-chain shield-ins, rate changes, and a
    ///         yield fee settled by both redeem and harvest.
    function test_handlerActionsAreLive() public {
        handler.registerIntegrator(0, 30);
        handler.shield(0, 0, 10_000e6); // USDC via integrator 0
        handler.shield(1, 0, 10_000e6); // other token via integrator 0
        handler.shield(0, 3, 10_000e6); // USDC, no integrator
        handler.shieldIn(0, 5_000e6);
        handler.govern(0, 40, 0);
        handler.govern(2, 20, 0);
        handler.lend(100_000e6);
        handler.accrueYield(30 days);
        handler.redeem(10_000e6);
        handler.accrueYield(30 days);
        vm.warp(block.timestamp + 8 days); // past the default 7-day harvest cadence
        handler.harvest();

        assertEq(handler.calls_shieldUsdc(), 2, "USDC shields");
        assertEq(handler.calls_shieldOther(), 1, "other-token shield");
        assertEq(handler.calls_shieldViaIntegrator(), 2, "integrator shields");
        assertEq(handler.calls_shieldIn(), 1, "shield-in");
        assertEq(handler.calls_govern(), 2, "rate changes");
        assertEq(handler.calls_redeem(), 1, "redeem");
        assertEq(handler.calls_harvest(), 1, "harvest");
        assertGt(other.balanceOf(TREASURY), 0, "other-token fee paid (but not counted)");
        assertGt(usdc.balanceOf(handler.integrators(0)), 0, "integrator paid in USDC");

        invariant_feeCounterMatchesTreasuryUsdc();
        invariant_integratorEarningsMatchUsdcReceived();
        invariant_integratorVolumeMatchesUsdcShielded();
        invariant_feeCounterNeverDecreases();
    }
}
