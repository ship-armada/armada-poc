/**
 * Golden-vector capture harness — Phase 1 of the clean-room contract rewrite plan.
 *
 * Captures golden behavioral vectors for the deployed privacy pool system
 * (specs/PRIVACY_POOL_CONTRACT.md) against a FRESH local fixturenet (Anvil hub
 * chain only, mock CCTP). Each vector records full calldata, ordered events,
 * pre/post invariant state reads (spec §12), return data or exact revert
 * reason, and gas used. Output: test-foundry/fixtures/contract-vectors/.
 *
 * Proof policy: the capture enables the pool's testingMode proof bypass
 * (spec §5.6 step 1) as one of the first admin vectors, so the full 19-shape
 * transact matrix is captured with dummy proofs. Every transact/unshield
 * vector is marked `proofsBypassed: true`. Shield vectors need no proofs.
 * Real-proof captures already exist separately (scripts/capture/) for circuit
 * differential testing.
 *
 * Prerequisites (see README.md):
 *   npm run chains                                  # terminal 1
 *   source config/local.env                         # terminal 2
 *   npm run compile
 *   npm run deploy:cctp:hub && npm run deploy:aave:hub && npm run deploy:governance \
 *     && npm run deploy:privacy-pool:hub && npm run deploy:gasless-wrapper:hub \
 *     && npm run deploy:yield:hub && npm run deploy:fee-module
 *
 * Run:
 *   npx hardhat run scripts/contract-vectors/capture.ts --network hub
 */

import { ethers } from "hardhat";
import { Interface } from "ethers";
import * as path from "path";

import {
  d32,
  npkFromSeed,
  toHex,
  writeJSON,
  SNARK_SCALAR_FIELD,
} from "./lib/util";
import { Recorder, StateRead } from "./lib/recorder";
import { deployMock } from "./lib/mock-contracts";
import {
  encodeBurnMessageV2,
  encodeMessageV2,
  encodeShieldHookData,
  encodeUnshieldHookData,
} from "./lib/cctp-message";
import {
  UnshieldType,
  commitmentHash,
  erc20Token,
  initPoseidon,
  makeShieldRequest,
  makeTransaction,
  signPermit,
} from "./lib/builders";

const OUT_DIR = path.join(__dirname, "..", "..", "test-foundry", "fixtures", "contract-vectors");

const ONE_USDC = 1_000_000n;
const HUB_DOMAIN = 100;
const CLIENT_DOMAIN = 101;
const CLIENT_POOL_DUMMY = "0x0000000000000000000000000000000000C11EA7";

const BALANCE_TRACKED = (book: Record<string, string>) =>
  (["POOL", "ALICE", "BOB", "CAROL", "TREASURY", "DEPLOYER", "HOOK_ROUTER", "GASLESS_WRAPPER"] as const)
    .filter((l) => book[l])
    .map((l) => [l, book[l]] as [string, string]);

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, alice, bob, carol] = signers;
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== 31337) {
    throw new Error(`capture must run on the local hub fixturenet (chainId 31337), got ${chainId}`);
  }

  // ── Load deployment manifests ──────────────────────────────────────────────
  const poolDeployment = require("../../deployments/privacy-pool-hub.json");
  const cctpDeployment = require("../../deployments/hub-v3.json");
  const feeModuleDeployment = require("../../deployments/fee-module-hub.json");
  const govDeployment = require("../../deployments/governance-hub.json");

  const book: Record<string, string> = {
    DEPLOYER: deployer.address,
    ALICE: alice.address,
    BOB: bob.address,
    CAROL: carol.address,
    TREASURY: govDeployment.contracts.treasury,
    POOL: poolDeployment.contracts.privacyPool,
    SHIELD_MODULE: poolDeployment.contracts.shieldModule,
    TRANSACT_MODULE: poolDeployment.contracts.transactModule,
    MERKLE_MODULE: poolDeployment.contracts.merkleModule,
    VERIFIER_MODULE: poolDeployment.contracts.verifierModule,
    HOOK_ROUTER: poolDeployment.contracts.hookRouter,
    GASLESS_WRAPPER: poolDeployment.contracts.gaslessShieldWrapper,
    TOKEN_MESSENGER: poolDeployment.cctp.tokenMessenger,
    MESSAGE_TRANSMITTER: poolDeployment.cctp.messageTransmitter,
    USDC: poolDeployment.cctp.usdc,
    FEE_MODULE: feeModuleDeployment.contracts.feeModuleProxy,
    CLIENT_POOL: CLIENT_POOL_DUMMY,
  };
  void cctpDeployment;

  const pool = await ethers.getContractAt("PrivacyPool", book.POOL);
  const shieldModule = await ethers.getContractAt("ShieldModule", book.SHIELD_MODULE);
  const transactModule = await ethers.getContractAt("TransactModule", book.TRANSACT_MODULE);
  const verifierModule = await ethers.getContractAt("VerifierModule", book.VERIFIER_MODULE);
  const usdc = await ethers.getContractAt("MockUSDCV2", book.USDC);
  const transmitter = await ethers.getContractAt("MockMessageTransmitterV2", book.MESSAGE_TRANSMITTER);
  const tokenMessenger = await ethers.getContractAt("MockTokenMessengerV2", book.TOKEN_MESSENGER);
  const hookRouter = await ethers.getContractAt("CCTPHookRouter", book.HOOK_ROUTER);
  const wrapper = await ethers.getContractAt("GaslessShieldWrapper", book.GASLESS_WRAPPER);
  const feeModule = await ethers.getContractAt("ArmadaFeeModule", book.FEE_MODULE);

  // Untyped interfaces: typechain's per-function encodeFunctionData overloads
  // reject plain-object struct args, so all calldata encoding goes through these.
  const poolIface = pool.interface as Interface;
  const txIface = transmitter.interface as Interface;
  const wrapperIface = wrapper.interface as Interface;
  const hookRouterIface = hookRouter.interface as Interface;
  const shieldModuleIface = shieldModule.interface as Interface;

  // Sanity: deployer must be a USDC minter for funding setup steps.
  if (!(await usdc.minters(deployer.address))) {
    throw new Error("deployer is not a USDC minter on this fixturenet — cannot fund accounts");
  }

  await initPoseidon();

  // ── Deploy capture-only helper mocks (runtime-compiled, not part of the SUT) ──
  const mockPause = await deployMock(deployer, "MockShieldPauseController");
  const mockFee = await deployMock(deployer, "MockConfigurableFeeModule");
  book.MOCK_PAUSE = mockPause.address;
  book.MOCK_FEE_MODULE = mockFee.address;

  // ── Funding + approvals (setup prerequisites, not vectors) ─────────────────
  console.log("Funding accounts and setting approvals (setup, not captured as vectors)...");
  await (await usdc.mint(alice.address, 10_000n * ONE_USDC)).wait();
  await (await usdc.mint(bob.address, 1_000n * ONE_USDC)).wait();
  await (await usdc.mint(carol.address, 1_000n * ONE_USDC)).wait();
  await (await usdc.connect(alice).approve(book.POOL, ethers.MaxUint256)).wait();
  await (await usdc.connect(bob).approve(book.POOL, ethers.MaxUint256)).wait();
  await (await usdc.connect(carol).approve(book.POOL, ethers.MaxUint256)).wait();

  const FUNDING_SETUP = [
    "MockUSDCV2.mint(ALICE, 10_000 USDC), mint(BOB, 1_000 USDC), mint(CAROL, 1_000 USDC) by DEPLOYER (minter)",
    "USDC.approve(POOL, uint256.max) from ALICE, BOB and CAROL",
  ];

  const recorder = new Recorder({
    outDir: OUT_DIR,
    pool,
    usdc,
    decoders: [
      pool.interface,
      // Module interfaces declare the user-facing events (Shield / Transact /
      // Nullified / Unshield / VerifyingKeySet) — they are emitted under
      // delegatecall from the POOL address but absent from the router ABI.
      shieldModule.interface,
      transactModule.interface,
      verifierModule.interface,
      usdc.interface,
      transmitter.interface,
      tokenMessenger.interface,
      hookRouter.interface,
      wrapper.interface,
      feeModule.interface,
    ],
    addressBook: book,
    chainId,
    deployments: {
      privacyPool: "deployments/privacy-pool-hub.json",
      cctp: "deployments/hub-v3.json",
      feeModule: "deployments/fee-module-hub.json",
      governance: "deployments/governance-hub.json",
    },
  });

  const balances = () => BALANCE_TRACKED(book);

  /** Current root/tree for transact builders. */
  const treePos = async () => ({
    merkleRoot: await pool.merkleRoot(),
    treeNumber: Number(await pool.treeNumber()),
  });

  /** Invariant reads for a transact vector: nullifiers + root history touched. */
  const transactReads = (treeNumber: number, merkleRoot: string, nullifiers: string[]): StateRead[] => [
    { key: `pool.rootHistory[${treeNumber}][${merkleRoot}]`, read: () => pool.rootHistory(treeNumber, merkleRoot) },
    ...nullifiers.map((n) => ({
      key: `pool.nullifiers[${treeNumber}][${n}]`,
      read: () => pool.nullifiers(treeNumber, n),
    })),
  ];

  const postRootRead = (): StateRead[] => [
    {
      key: "pool.rootHistory[postTree][postRoot]",
      read: async () => pool.rootHistory(await pool.treeNumber(), await pool.merkleRoot()),
    },
  ];

  // Impersonated signers must go through a raw JSON-RPC provider: hardhat wraps
  // the Anvil connection with an HD-wallet account provider that refuses to
  // sign for addresses it doesn't hold keys for, even when the node itself
  // would accept the impersonated eth_sendTransaction.
  const rawProvider = new ethers.JsonRpcProvider(process.env.HUB_RPC || "http://localhost:8545");
  const impersonate = async (addr: string) => {
    try {
      await rawProvider.send("anvil_impersonateAccount", [addr]);
      await rawProvider.send("anvil_setBalance", [addr, "0x56BC75E2D63100000"]);
    } catch {
      await rawProvider.send("hardhat_impersonateAccount", [addr]);
      await rawProvider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
    }
    return rawProvider.getSigner(addr);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE A — admin / configuration vectors
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Phase A: admin / config vectors ===");

  await recorder.capture({
    meta: {
      id: "admin-set-hook-router",
      category: "admin",
      description: "Owner wires the CCTPHookRouter into the pool (required for inbound cross-chain shields; deploy script leaves this unset).",
      specRefs: ["§5.4", "§1.3"],
      setup: ["Hub deployment complete (privacy-pool-hub.json)", "HOOK_ROUTER deployed by deploy_privacy_pool.ts"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setHookRouter", [book.HOOK_ROUTER]),
    decodedCall: { function: "setHookRouter", args: { hookRouter: book.HOOK_ROUTER } },
    balancesOf: balances(),
    postReads: [{ key: "pool.hookRouter", read: () => pool.hookRouter() }],
  });

  await recorder.capture({
    meta: {
      id: "cctp-set-mock-relayer",
      category: "cctp-config",
      description: "Mock-CCTP wiring (not a pool call): point the hub MockMessageTransmitterV2's relayer at the CCTPHookRouter so relayWithHook can call receiveMessage. Recorded for replay completeness; identical in old/new deployments.",
      setup: ["Deployer is the transmitter's current relayer (constructor arg in deploy_cctp_v3.ts)"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.MESSAGE_TRANSMITTER, toLabel: "MESSAGE_TRANSMITTER",
    calldata: txIface.encodeFunctionData("setRelayer", [book.HOOK_ROUTER]),
    decodedCall: { function: "setRelayer", args: { relayer: book.HOOK_ROUTER } },
    postReads: [{ key: "transmitter.relayer", read: () => transmitter.relayer() }],
  });

  await recorder.capture({
    meta: {
      id: "admin-set-remote-pool",
      category: "admin",
      description: "Owner registers a remote pool for CCTP domain 101 (dummy client-pool address; required by atomicCrossChainUnshield). Emits RemotePoolSet.",
      specRefs: ["§5.4", "§11"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setRemotePool", [
      CLIENT_DOMAIN, ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32),
    ]),
    decodedCall: { function: "setRemotePool", args: { domain: CLIENT_DOMAIN, poolAddress: ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32) } },
    postReads: [{ key: "pool.remotePools[101]", read: () => pool.remotePools(CLIENT_DOMAIN) }],
  });

  await recorder.capture({
    meta: {
      id: "admin-set-default-finality-threshold",
      category: "admin",
      description: "Owner sets defaultFinalityThreshold to 1000 (FAST). Emits DefaultFinalityThresholdSet. Affects atomicCrossChainUnshield's depositForBurnWithHook finality argument.",
      specRefs: ["§5.4", "§8.2"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setDefaultFinalityThreshold", [1000]),
    decodedCall: { function: "setDefaultFinalityThreshold", args: { threshold: 1000 } },
    postReads: [{ key: "pool.defaultFinalityThreshold", read: () => pool.defaultFinalityThreshold() }],
  });

  await recorder.capture({
    meta: {
      id: "admin-set-shield-fee-100",
      category: "admin",
      description: "Owner raises the flat shield fee 50 -> 100 bps. No event is emitted (spec §5.4).",
      specRefs: ["§5.4", "I-10"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setShieldFee", [100]),
    decodedCall: { function: "setShieldFee", args: { feeBps: 100 } },
    postReads: [{ key: "pool.shieldFee", read: () => pool.shieldFee() }],
  });

  await recorder.capture({
    meta: {
      id: "admin-set-shield-fee-too-high-revert",
      category: "admin",
      description: "setShieldFee(10001) exceeds the 10000 bps cap and reverts (I-10, OQ-10).",
      specRefs: ["§5.4", "I-10"],
      dependsOn: ["admin-set-shield-fee-100"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setShieldFee", [10001]),
    decodedCall: { function: "setShieldFee", args: { feeBps: 10001 } },
    expectRevert: true, expectReason: "PrivacyPool: Fee too high",
    postReads: [{ key: "pool.shieldFee", read: () => pool.shieldFee() }],
  });

  await recorder.capture({
    meta: {
      id: "admin-set-shield-fee-50",
      category: "admin",
      description: "Owner restores the flat shield fee to 50 bps for the shield vectors.",
      specRefs: ["§5.4"],
      dependsOn: ["admin-set-shield-fee-100"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setShieldFee", [50]),
    decodedCall: { function: "setShieldFee", args: { feeBps: 50 } },
    postReads: [{ key: "pool.shieldFee", read: () => pool.shieldFee() }],
  });

  await recorder.capture({
    meta: {
      id: "admin-set-fee-module-zero",
      category: "admin",
      description: "Owner detaches ArmadaFeeModule (deploy_fee_module.ts wired it in) so flat-fee shield paths can be captured. Emits FeeModuleSet.",
      specRefs: ["§5.4", "§7.3"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setFeeModule", [ethers.ZeroAddress]),
    decodedCall: { function: "setFeeModule", args: { feeModule: ethers.ZeroAddress } },
    postReads: [{ key: "pool.feeModule", read: () => pool.feeModule() }],
  });

  await recorder.capture({
    meta: {
      id: "admin-set-testing-mode-true",
      category: "admin",
      description: "Owner enables the testingMode proof bypass. Emits TestingModeSet TWICE per call (module delegatecall + router — OQ-8). All subsequent transact/unshield vectors run with proofs bypassed (spec §5.6 step 1).",
      specRefs: ["§5.4", "§5.6", "OQ-8", "OQ-11"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setTestingMode", [true]),
    decodedCall: { function: "setTestingMode", args: { enabled: true } },
    postReads: [{ key: "pool.testingMode", read: () => pool.testingMode() }],
  });

  const dummyVk = {
    artifactsIPFSHash: "QmPOC_capture_9x9",
    alpha1: { x: 1, y: 2 },
    beta2: { x: [1, 2], y: [3, 4] },
    gamma2: { x: [5, 6], y: [7, 8] },
    delta2: { x: [9, 10], y: [11, 12] },
    ic: Array.from({ length: 21 }, (_, i) => ({ x: i + 1, y: i + 2 })), // 3 + 9 + 9 public inputs + 1
  };
  await recorder.capture({
    meta: {
      id: "admin-set-verifying-key",
      category: "admin",
      description: "Owner registers a dummy verifying key for the unused (9,9) shape via the VerifierModule delegatecall. Emits VerifyingKeySet; no structural validation (spec §9.1).",
      specRefs: ["§5.4", "§9.1", "§11"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setVerificationKey", [9, 9, dummyVk]),
    decodedCall: { function: "setVerificationKey", args: { n: 9, m: 9, key: dummyVk } },
    postReads: [
      { key: "pool.getVerificationKey(9,9).alpha1.x", read: async () => (await pool.getVerificationKey(9, 9)).alpha1.x },
    ],
  });

  await recorder.capture({
    meta: {
      id: "admin-set-privileged-shield-caller",
      category: "admin",
      description: "Owner marks CAROL as a privileged shield caller (fee-free shields, spec §7.3). No event.",
      specRefs: ["§5.4", "§7.3"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setPrivilegedShieldCaller", [carol.address, true]),
    decodedCall: { function: "setPrivilegedShieldCaller", args: { caller: carol.address, privileged: true } },
    postReads: [{ key: "pool.privilegedShieldCallers[CAROL]", read: () => pool.privilegedShieldCallers(carol.address) }],
  });

  await recorder.capture({
    meta: {
      id: "admin-only-owner-revert",
      category: "admin",
      description: "Non-owner (ALICE) calling an admin setter reverts with the router-level owner guard.",
      specRefs: ["§5.4", "§1.3"],
    },
    from: alice, fromLabel: "ALICE", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setShieldFee", [50]),
    decodedCall: { function: "setShieldFee", args: { feeBps: 50 } },
    expectRevert: true, expectReason: "PrivacyPool: Only owner",
    postReads: [{ key: "pool.shieldFee", read: () => pool.shieldFee() }],
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE B — shield vectors (flat-fee mode: feeModule = 0, shieldFee = 50 bps)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Phase B: shield vectors ===");

  const shieldVector = async (
    id: string,
    description: string,
    requests: any[],
    opts: {
      from?: typeof alice; fromLabel?: string; integrator?: string;
      specRefs?: string[]; dependsOn?: string[]; extraSetup?: string[];
      expectRevert?: boolean; expectReason?: string;
    } = {}
  ) => {
    const from = opts.from ?? alice;
    await recorder.capture({
      meta: {
        id, category: "shield", description,
        specRefs: opts.specRefs ?? ["§7.1", "I-5"],
        dependsOn: opts.dependsOn ?? ["admin-set-fee-module-zero", "admin-set-shield-fee-50"],
        setup: [...FUNDING_SETUP, ...(opts.extraSetup ?? [])],
      },
      from, fromLabel: opts.fromLabel ?? "ALICE", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("shield", [requests, opts.integrator ?? ethers.ZeroAddress]),
      decodedCall: { function: "shield", args: { requests, integrator: opts.integrator ?? ethers.ZeroAddress } },
      expectRevert: opts.expectRevert, expectReason: opts.expectReason,
      balancesOf: balances(),
      postReads: postRootRead(),
    });
  };

  await shieldVector(
    "shield-direct-erc20",
    "Direct ERC20 shield of 100 USDC with the flat 50 bps fee: base 99.5 USDC to pool, 0.5 USDC fee to treasury (I-5, I-10).",
    [makeShieldRequest("shield-direct-erc20", erc20Token(book.USDC), 100n * ONE_USDC)]
  );

  await shieldVector(
    "shield-fee-below-threshold",
    "Shield of 199 base units at 50 bps: floor division makes the fee exactly 0 (I-10, Lean fee_zero_below_threshold).",
    [makeShieldRequest("shield-fee-below-threshold", erc20Token(book.USDC), 199n)],
    { dependsOn: ["shield-direct-erc20"] }
  );

  await shieldVector(
    "shield-batch-two-requests",
    "Two shield requests in one call (5 + 7 USDC): single Shield event with two entries, two leaves inserted atomically.",
    [
      makeShieldRequest("shield-batch-two-requests:0", erc20Token(book.USDC), 5n * ONE_USDC),
      makeShieldRequest("shield-batch-two-requests:1", erc20Token(book.USDC), 7n * ONE_USDC),
    ],
    { dependsOn: ["shield-direct-erc20"] }
  );

  await shieldVector(
    "shield-privileged-caller",
    "Privileged caller (CAROL) shields 10 USDC: full value committed, zero fee (spec §7.3 privileged branch).",
    [makeShieldRequest("shield-privileged-caller", erc20Token(book.USDC), 10n * ONE_USDC)],
    {
      from: carol, fromLabel: "CAROL",
      dependsOn: ["admin-set-privileged-shield-caller"],
      specRefs: ["§7.3"],
    }
  );

  // Gasless shield via the wrapper: BOB signs an EIP-2612 permit, relayer submits.
  {
    const total = 20n * ONE_USDC;
    const relayerFee = 1n * ONE_USDC;
    const shieldAmount = total - relayerFee;
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + 3600n;
    const sig = await signPermit(bob, usdc as any, book.GASLESS_WRAPPER, total, deadline, chainId);
    const req = makeShieldRequest("shield-gasless-wrapper", erc20Token(book.USDC), shieldAmount);
    await recorder.capture({
      meta: {
        id: "shield-gasless-wrapper",
        category: "shield",
        description: "Gasless shield: BOB signs an EIP-2612 permit for 20 USDC; the relayer (DEPLOYER) calls GaslessShieldWrapper.gaslessShield, which pulls 1 USDC relayer fee and shields 19 USDC into the pool (flat 50 bps pool fee applies).",
        specRefs: ["§7.1"],
        dependsOn: ["admin-set-fee-module-zero"],
        setup: [...FUNDING_SETUP, "BOB signs EIP-2612 permit (owner=BOB, spender=GASLESS_WRAPPER, value=20 USDC, deadline=now+1h)"],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.GASLESS_WRAPPER, toLabel: "GASLESS_WRAPPER",
      calldata: wrapperIface.encodeFunctionData("gaslessShield", [
        bob.address, total, relayerFee, deadline, sig.v, sig.r, sig.s, req, ethers.ZeroAddress,
      ]),
      decodedCall: {
        function: "gaslessShield",
        args: { user: bob.address, totalAmount: toHex(total), fee: toHex(relayerFee), deadline: toHex(deadline), v: sig.v, r: sig.r, s: sig.s, shieldRequest: req, integrator: ethers.ZeroAddress },
        permitNote: "deadline is block.timestamp+3600 at capture time — re-capture or use a long deadline window when replaying on a new fixturenet",
      },
      balancesOf: balances(),
      postReads: postRootRead(),
    });
  }

  // Fee-module path.
  await recorder.capture({
    meta: {
      id: "admin-set-fee-module-restore",
      category: "admin",
      description: "Owner re-attaches ArmadaFeeModule so the fee-module shield path (spec §7.3) can be captured. Emits FeeModuleSet.",
      specRefs: ["§5.4"],
      dependsOn: ["admin-set-fee-module-zero"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setFeeModule", [book.FEE_MODULE]),
    decodedCall: { function: "setFeeModule", args: { feeModule: book.FEE_MODULE } },
    postReads: [{ key: "pool.feeModule", read: () => pool.feeModule() }],
  });

  await shieldVector(
    "shield-fee-module-active",
    "Shield of 1000 USDC with ArmadaFeeModule active (integrator=0): base tier 50 bps armadaTake to treasury, recordShieldFee bookkeeping call (spec §7.3 fee-module branch).",
    [makeShieldRequest("shield-fee-module-active", erc20Token(book.USDC), 1000n * ONE_USDC)],
    { dependsOn: ["admin-set-fee-module-restore"], specRefs: ["§7.3", "§2.4", "I-5"] }
  );

  // Shield revert paths (fee-module state is irrelevant — validation happens first).
  await shieldVector(
    "shield-npk-boundary-revert",
    "npk exactly equal to SNARK_SCALAR_FIELD is rejected (I-7 boundary: npk must be < field).",
    [makeShieldRequest("shield-npk-boundary-revert", erc20Token(book.USDC), ONE_USDC, ethers.zeroPadValue(ethers.toBeHex(SNARK_SCALAR_FIELD), 32))],
    { expectRevert: true, expectReason: "ShieldModule: Invalid npk", specRefs: ["§7.1", "I-7"], dependsOn: ["shield-direct-erc20"] }
  );

  await shieldVector(
    "shield-erc721-revert",
    "ERC721 token type passes preimage validation (value==1, npk valid) but the token pull requires ERC20 (OQ-6 dead NFT path).",
    [{ ...makeShieldRequest("shield-erc721-revert", { tokenType: 1, tokenAddress: book.USDC, tokenSubID: 0 }, 1n) }],
    { expectRevert: true, expectReason: "ShieldModule: Only ERC20 supported", specRefs: ["§7.1", "§7.3", "OQ-6"], dependsOn: ["shield-direct-erc20"] }
  );

  await shieldVector(
    "shield-zero-value-revert",
    "Zero-value shield is rejected before any token movement.",
    [makeShieldRequest("shield-zero-value-revert", erc20Token(book.USDC), 0n)],
    { expectRevert: true, expectReason: "ShieldModule: Invalid value", specRefs: ["§7.1"], dependsOn: ["shield-direct-erc20"] }
  );

  await shieldVector(
    "shield-no-requests-revert",
    "Empty request batch is rejected.",
    [],
    { expectRevert: true, expectReason: "ShieldModule: No requests", specRefs: ["§7.1"], dependsOn: ["shield-direct-erc20"] }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE C — transact shape matrix (testingMode proof bypass active)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Phase C: transact shape matrix (proofs bypassed via testingMode) ===");

  const BYPASS_NOTE_DEPENDS = ["admin-set-testing-mode-true", "shield-direct-erc20"];

  const transactVector = async (
    id: string,
    description: string,
    txs: any[],
    opts: {
      category?: string;
      specRefs?: string[]; dependsOn?: string[];
      expectRevert?: boolean; expectReason?: string;
      skipNullifierReads?: boolean;
    } = {}
  ) => {
    const pos = await treePos();
    const allNullifiers = txs.flatMap((t) => t.nullifiers);
    await recorder.capture({
      meta: {
        id, category: opts.category ?? "transact", description,
        specRefs: opts.specRefs ?? ["§8.1"],
        proofsBypassed: true,
        dependsOn: opts.dependsOn ?? BYPASS_NOTE_DEPENDS,
        setup: [
          "testingMode = true (vector admin-set-testing-mode-true) — router verify() returns true without reading the proof; proof struct is zeros",
          "Merkle root read fresh from pool before calldata construction",
        ],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("transact", [txs]),
      decodedCall: { function: "transact", args: { txs } },
      expectRevert: opts.expectRevert, expectReason: opts.expectReason,
      balancesOf: balances(),
      preReads: opts.skipNullifierReads ? [] : transactReads(pos.treeNumber, txs[0].merkleRoot, allNullifiers),
      postReads: postRootRead(),
    });
  };

  // The 19 registered circuit shapes (lib/artifacts.ts TESTING_ARTIFACT_CONFIGS).
  const SHAPES: Array<[number, number]> = [
    [1, 1], [1, 2], [2, 2], [2, 3], [8, 4],
    [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1],
    [3, 2], [4, 2], [5, 2], [6, 2],
    [1, 3], [3, 3], [4, 3],
  ];

  for (const [n, m] of SHAPES) {
    const pos = await treePos();
    const tx = makeTransaction({
      seed: `transact-${n}x${m}`,
      nullifierCount: n,
      commitmentCount: m,
      merkleRoot: pos.merkleRoot,
      treeNumber: pos.treeNumber,
      chainId,
    });
    await transactVector(
      `transact-${n}x${m}`,
      `Transact shape (${n},${m}): ${n} nullifier(s), ${m} commitment(s) inserted; Nullified + Transact events. Dummy proof — testingMode bypass active.`,
      [tx]
    );
  }

  {
    const pos = await treePos();
    const tx1 = makeTransaction({ seed: "transact-batch-1x1-plus-1x1:0", nullifierCount: 1, commitmentCount: 1, merkleRoot: pos.merkleRoot, treeNumber: pos.treeNumber, chainId });
    const tx2 = makeTransaction({ seed: "transact-batch-1x1-plus-1x1:1", nullifierCount: 1, commitmentCount: 1, merkleRoot: pos.merkleRoot, treeNumber: pos.treeNumber, chainId });
    await transactVector(
      "transact-batch-1x1-plus-1x1",
      "Two 1x1 transactions in one transact call: two Nullified events, single batched Transact event with both commitments (spec §8.1 steps 5-7).",
      [tx1, tx2],
      { dependsOn: ["transact-1x1"] }
    );
  }

  // Double-spend: re-send the EXACT calldata of transact-1x1. The old merkle
  // root remains valid in rootHistory (I-2), so validation reaches the
  // nullifier check and reverts there.
  {
    const pos0 = await treePos();
    const recorded = require(path.join(OUT_DIR, "transact-1x1.json"));
    const recordedTx = recorded.tx.decodedCall.args.txs[0];
    await recorder.capture({
      meta: {
        id: "transact-double-spend-revert",
        category: "transact",
        description: "Replaying the exact calldata of transact-1x1 reverts: its nullifier is already marked (I-4). The old merkle root remains valid in rootHistory (I-2), so validation reaches the nullifier check.",
        specRefs: ["§8.4", "I-4"],
        proofsBypassed: true,
        dependsOn: ["transact-1x1"],
        setup: ["Calldata byte-identical to vector transact-1x1"],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
      calldata: recorded.tx.calldata,
      decodedCall: { function: "transact", args: { txs: [recordedTx] } },
      expectRevert: true, expectReason: "TransactModule: Note already spent",
      balancesOf: balances(),
      preReads: transactReads(pos0.treeNumber, recordedTx.merkleRoot, recordedTx.nullifiers),
      postReads: postRootRead(),
    });
  }

  {
    const pos = await treePos();
    const tx = makeTransaction({
      seed: "transact-invalid-merkle-root-revert",
      nullifierCount: 1, commitmentCount: 1,
      merkleRoot: d32("transact-invalid-merkle-root-revert:root"),
      treeNumber: pos.treeNumber, chainId,
    });
    await transactVector(
      "transact-invalid-merkle-root-revert",
      "Transaction over a root that was never inserted reverts at validation step 4 (spec §8.3).",
      [tx],
      { expectRevert: true, expectReason: "TransactModule: Invalid Merkle Root", skipNullifierReads: true }
    );
  }

  {
    const pos = await treePos();
    const tx = makeTransaction({
      seed: "transact-chainid-mismatch-revert",
      nullifierCount: 1, commitmentCount: 1,
      merkleRoot: pos.merkleRoot, treeNumber: pos.treeNumber,
      chainId: 999999,
    });
    await transactVector(
      "transact-chainid-mismatch-revert",
      "boundParams.chainID != block.chainid reverts at validation step 3 (spec §8.3).",
      [tx],
      { expectRevert: true, expectReason: "TransactModule: ChainID mismatch", skipNullifierReads: true }
    );
  }

  await transactVector(
    "transact-no-transactions-revert",
    "Empty transaction batch is rejected (spec §8.1 step 1).",
    [],
    { expectRevert: true, expectReason: "TransactModule: No transactions", skipNullifierReads: true }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE D — unshield vectors
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Phase D: unshield vectors ===");

  const unshieldVector = async (
    id: string,
    description: string,
    opts: {
      seed: string; recipient: string; recipientLabel: string; value: bigint;
      unshieldType: number;
      specRefs?: string[]; dependsOn?: string[];
    }
  ) => {
    const pos = await treePos();
    // For REDIRECT the on-chain hash check substitutes msg.sender (DEPLOYER)
    // for the preimage npk; payout still goes to the npk-encoded address.
    const hashNpk =
      opts.unshieldType === UnshieldType.REDIRECT
        ? ethers.zeroPadValue(deployer.address, 32)
        : ethers.zeroPadValue(opts.recipient, 32);
    const tx = makeTransaction({
      seed: opts.seed,
      nullifierCount: 1,
      commitmentCount: 2,
      merkleRoot: pos.merkleRoot,
      treeNumber: pos.treeNumber,
      chainId,
      unshield: opts.unshieldType,
      unshieldPreimage: {
        npk: ethers.zeroPadValue(opts.recipient, 32),
        token: erc20Token(book.USDC),
        value: opts.value,
      },
    });
    // makeTransaction hashes the preimage npk; for REDIRECT rebuild with the
    // msg.sender-bound hash.
    if (opts.unshieldType === UnshieldType.REDIRECT) {
      tx.commitments[1] = commitmentHash(hashNpk, book.USDC, opts.value);
    }
    await transactVector(
      id, description, [tx],
      {
        category: "unshield",
        specRefs: opts.specRefs ?? ["§8.1", "§8.5", "I-6"],
        dependsOn: opts.dependsOn ?? ["transact-1x2", "shield-direct-erc20"],
      }
    );
  };

  await unshieldVector(
    "unshield-local-normal",
    "Local unshield of 25 USDC to BOB (1x2 shape, unshield=NORMAL): last commitment is the unshield-output note hash (not inserted); Unshield event with fee=0 (D-2).",
    {
      seed: "unshield-local-normal",
      recipient: bob.address, recipientLabel: "BOB",
      value: 25n * ONE_USDC,
      unshieldType: UnshieldType.NORMAL,
    }
  );

  await unshieldVector(
    "unshield-local-redirect",
    "Local unshield with unshield=REDIRECT: hash check binds msg.sender (DEPLOYER), but the 30 USDC payout goes to the npk-encoded address (BOB) — spec §8.3 step 6 note.",
    {
      seed: "unshield-local-redirect",
      recipient: bob.address, recipientLabel: "BOB",
      value: 30n * ONE_USDC,
      unshieldType: UnshieldType.REDIRECT,
      specRefs: ["§8.3", "§8.5"],
      dependsOn: ["unshield-local-normal"],
    }
  );

  await unshieldVector(
    "unshield-to-contract-recipient",
    "Local unshield of 5 USDC to a contract recipient (GASLESS_WRAPPER): plain ERC20 transfer, no callback expected or attempted (D-4).",
    {
      seed: "unshield-to-contract-recipient",
      recipient: book.GASLESS_WRAPPER, recipientLabel: "GASLESS_WRAPPER",
      value: 5n * ONE_USDC,
      unshieldType: UnshieldType.NORMAL,
      specRefs: ["§8.5"],
      dependsOn: ["unshield-local-normal"],
    }
  );

  // Atomic cross-chain unshield via the mock CCTP TokenMessenger.
  {
    const pos = await treePos();
    const base = 50n * ONE_USDC;
    const maxFee = 1n * ONE_USDC;
    const tx = makeTransaction({
      seed: "unshield-atomic-crosschain",
      nullifierCount: 1,
      commitmentCount: 2,
      merkleRoot: pos.merkleRoot,
      treeNumber: pos.treeNumber,
      chainId,
      unshield: UnshieldType.NORMAL,
      unshieldPreimage: {
        npk: ethers.zeroPadValue(bob.address, 32),
        token: erc20Token(book.USDC),
        value: base,
      },
    });
    await recorder.capture({
      meta: {
        id: "unshield-atomic-crosschain",
        category: "unshield",
        description: "Atomic cross-chain unshield of 50 USDC to BOB on domain 101 via mock CCTP depositForBurnWithHook (maxFee 1 USDC, finality from defaultFinalityThreshold=1000). Burns pool USDC, emits CrossChainUnshieldInitiated + Unshield, returns nonce=0 (spec §8.2).",
        specRefs: ["§8.2", "I-6"],
        proofsBypassed: true,
        dependsOn: ["admin-set-remote-pool", "admin-set-default-finality-threshold", "unshield-local-normal"],
        setup: [
          "testingMode = true (proof bypass)",
          "remotePools[101] registered (vector admin-set-remote-pool)",
          "Pool USDC balance >= 50 USDC from prior shields",
        ],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("atomicCrossChainUnshield", [
        tx, CLIENT_DOMAIN, bob.address, ethers.ZeroHash, maxFee,
      ]),
      decodedCall: {
        function: "atomicCrossChainUnshield",
        args: { tx, destinationDomain: CLIENT_DOMAIN, finalRecipient: bob.address, destinationCaller: ethers.ZeroHash, maxFee: toHex(maxFee) },
      },
      captureReturnData: true,
      balancesOf: balances(),
      preReads: transactReads(pos.treeNumber, pos.merkleRoot, tx.nullifiers),
      postReads: postRootRead(),
    });
  }

  // Unknown-destination revert.
  {
    const pos = await treePos();
    const tx = makeTransaction({
      seed: "unshield-crosschain-unknown-dest-revert",
      nullifierCount: 1,
      commitmentCount: 2,
      merkleRoot: pos.merkleRoot,
      treeNumber: pos.treeNumber,
      chainId,
      unshield: UnshieldType.NORMAL,
      unshieldPreimage: {
        npk: ethers.zeroPadValue(bob.address, 32),
        token: erc20Token(book.USDC),
        value: ONE_USDC,
      },
    });
    await recorder.capture({
      meta: {
        id: "unshield-crosschain-unknown-dest-revert",
        category: "unshield",
        description: "atomicCrossChainUnshield to unregistered domain 199 reverts before proof validation (spec §8.2 check 4).",
        specRefs: ["§8.2"],
        proofsBypassed: true,
        dependsOn: ["unshield-atomic-crosschain"],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("atomicCrossChainUnshield", [
        tx, 199, bob.address, ethers.ZeroHash, 0n,
      ]),
      decodedCall: {
        function: "atomicCrossChainUnshield",
        args: { tx, destinationDomain: 199, finalRecipient: bob.address, destinationCaller: ethers.ZeroHash, maxFee: "0x0" },
      },
      expectRevert: true, expectReason: "TransactModule: Unknown destination",
      balancesOf: balances(),
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE E — cross-chain shield-in via the CCTP hook handlers (mock router)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Phase E: cross-chain shield-in vectors ===");

  /** Fabricate a full MessageV2 carrying a SHIELD burn from the "client" chain. */
  const shieldInMessage = (
    seed: string,
    gross: bigint,
    cctpFee: bigint,
    finality: number,
    integrator: string = ethers.ZeroAddress
  ) => {
    const hookData = encodeShieldHookData({
      npk: npkFromSeed(seed),
      value: gross,
      encryptedBundle: [d32(`${seed}:eb0`), d32(`${seed}:eb1`), d32(`${seed}:eb2`)],
      shieldKey: d32(`${seed}:sk`),
      integrator,
    });
    const body = encodeBurnMessageV2({
      burnToken: book.USDC,
      mintRecipient: book.POOL,
      amount: gross,
      messageSender: ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32),
      maxFee: cctpFee,
      feeExecuted: cctpFee,
      expirationBlock: 0n,
      hookData,
    });
    return encodeMessageV2({
      sourceDomain: CLIENT_DOMAIN,
      destinationDomain: HUB_DOMAIN,
      nonce: d32(`${seed}:nonce`),
      sender: ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32),
      recipient: ethers.zeroPadValue(book.TOKEN_MESSENGER, 32),
      destinationCaller: ethers.ZeroHash,
      minFinalityThreshold: finality,
      finalityThresholdExecuted: finality,
      messageBody: body,
    });
  };

  const shieldInVector = async (
    id: string,
    description: string,
    seed: string,
    gross: bigint,
    cctpFee: bigint,
    finality: number,
    dependsOn: string[],
    specRefs: string[] = ["§5.3", "§7.2", "I-5"]
  ) => {
    const message = shieldInMessage(seed, gross, cctpFee, finality);
    await recorder.capture({
      meta: {
        id, category: "shield-in", description, specRefs,
        dependsOn: ["admin-set-hook-router", "cctp-set-mock-relayer", ...dependsOn],
        setup: [
          "hookRouter wired (vector admin-set-hook-router) and registered as mock transmitter relayer (vector cctp-set-mock-relayer)",
          "MessageV2/BurnMessageV2 bytes fabricated off-chain per ICCTPV2.sol offsets (same bytes a client-chain MessageSent event would carry)",
        ],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.HOOK_ROUTER, toLabel: "HOOK_ROUTER",
      calldata: hookRouterIface.encodeFunctionData("relayWithHook", [message, "0x"]),
      decodedCall: { function: "relayWithHook", args: { message, attestation: "0x" } },
      balancesOf: balances(),
      postReads: postRootRead(),
    });
  };

  await shieldInVector(
    "shieldin-finalized-fee-module",
    "Inbound cross-chain shield at STANDARD finality (2000) routed to handleReceiveFinalizedMessage, fee module active: 500 USDC gross, 2 USDC CCTP fee minted to hookRouter, 498 USDC minted to pool; armadaTake (50 bps of 498) paid to treasury OUT OF the pool's own balance (spec §7.2 note).",
    "shieldin-finalized-fee-module", 500n * ONE_USDC, 2n * ONE_USDC, 2000,
    ["admin-set-fee-module-restore", "shield-fee-module-active"]
  );

  await recorder.capture({
    meta: {
      id: "admin-set-fee-module-zero-2",
      category: "admin",
      description: "Owner detaches the fee module again so the fast-finality shield-in vector exercises the flat-fee path.",
      specRefs: ["§5.4"],
      dependsOn: ["shieldin-finalized-fee-module"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setFeeModule", [ethers.ZeroAddress]),
    decodedCall: { function: "setFeeModule", args: { feeModule: ethers.ZeroAddress } },
    postReads: [{ key: "pool.feeModule", read: () => pool.feeModule() }],
  });

  await shieldInVector(
    "shieldin-fast-flat-fee",
    "Inbound cross-chain shield at FAST finality (1000) routed to handleReceiveUnfinalizedMessage, flat 50 bps fee: 300 USDC gross, 1 USDC CCTP fee to hookRouter, 299 USDC minted to pool; shield fee paid from the pool's own balance to treasury.",
    "shieldin-fast-flat-fee", 300n * ONE_USDC, 1n * ONE_USDC, 1000,
    ["admin-set-fee-module-zero-2"]
  );

  // Handler revert paths (direct calls; hookRouter impersonated where required).
  {
    const message = shieldInMessage("shieldin-insufficient-finality-revert", ONE_USDC, 0n, 1000);
    // Extract the burn-message body (strip the 148-byte MessageV2 header).
    const body = "0x" + message.slice(2 + 148 * 2);
    const hrSigner = await impersonate(book.HOOK_ROUTER);
    await recorder.capture({
      meta: {
        id: "shieldin-insufficient-finality-revert",
        category: "shield-in",
        description: "handleReceiveFinalizedMessage with finalityThresholdExecuted=1000 (< STANDARD 2000) reverts (spec §5.3 step 2).",
        specRefs: ["§5.3"],
        dependsOn: ["admin-set-hook-router"],
        requiresImpersonation: "HOOK_ROUTER",
        setup: ["Caller must be HOOK_ROUTER or TOKEN_MESSENGER — replay via account impersonation"],
      },
      from: hrSigner, fromLabel: "HOOK_ROUTER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("handleReceiveFinalizedMessage", [
        CLIENT_DOMAIN, ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32), 1000, body,
      ]),
      decodedCall: { function: "handleReceiveFinalizedMessage", args: { remoteDomain: CLIENT_DOMAIN, sender: ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32), finalityThresholdExecuted: 1000, messageBody: body } },
      expectRevert: true, expectReason: "PrivacyPool: Insufficient finality",
      balancesOf: balances(),
    });
  }

  {
    const message = shieldInMessage("shieldin-unauthorized-caller-revert", ONE_USDC, 0n, 1000);
    const body = "0x" + message.slice(2 + 148 * 2);
    await recorder.capture({
      meta: {
        id: "shieldin-unauthorized-caller-revert",
        category: "shield-in",
        description: "handleReceiveUnfinalizedMessage from an EOA that is neither hookRouter nor tokenMessenger reverts (spec §5.3 step 1).",
        specRefs: ["§5.3", "§1.3"],
        dependsOn: ["admin-set-hook-router"],
      },
      from: alice, fromLabel: "ALICE", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("handleReceiveUnfinalizedMessage", [
        CLIENT_DOMAIN, ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32), 1000, body,
      ]),
      decodedCall: { function: "handleReceiveUnfinalizedMessage", args: { remoteDomain: CLIENT_DOMAIN, sender: ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32), finalityThresholdExecuted: 1000, messageBody: body } },
      expectRevert: true, expectReason: "PrivacyPool: Unauthorized caller",
      balancesOf: balances(),
    });
  }

  {
    // UNSHIELD payloads are never accepted inbound on the hub (spec §5.3 step 5).
    const hookData = encodeUnshieldHookData(bob.address);
    const body = encodeBurnMessageV2({
      burnToken: book.USDC,
      mintRecipient: book.POOL,
      amount: ONE_USDC,
      messageSender: ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32),
      maxFee: 0n, feeExecuted: 0n, expirationBlock: 0n,
      hookData,
    });
    const hrSigner = await impersonate(book.HOOK_ROUTER);
    await recorder.capture({
      meta: {
        id: "shieldin-invalid-message-type-revert",
        category: "shield-in",
        description: "Inbound CCTP payload with messageType=UNSHIELD reverts on the hub — it only accepts SHIELD payloads (spec §5.3 step 5).",
        specRefs: ["§5.3"],
        dependsOn: ["admin-set-hook-router"],
        requiresImpersonation: "HOOK_ROUTER",
        setup: ["Caller must be HOOK_ROUTER or TOKEN_MESSENGER — replay via account impersonation"],
      },
      from: hrSigner, fromLabel: "HOOK_ROUTER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("handleReceiveUnfinalizedMessage", [
        CLIENT_DOMAIN, ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32), 1000, body,
      ]),
      decodedCall: { function: "handleReceiveUnfinalizedMessage", args: { remoteDomain: CLIENT_DOMAIN, sender: ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32), finalityThresholdExecuted: 1000, messageBody: body } },
      expectRevert: true, expectReason: "PrivacyPool: Invalid message type",
      balancesOf: balances(),
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE F — pause-contract interactions (MockShieldPauseController)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Phase F: pause-path vectors ===");

  await recorder.capture({
    meta: {
      id: "admin-set-shield-pause-contract",
      category: "admin",
      description: "Owner points shieldPauseContract at a MockShieldPauseController (capture-only mock with permissionless flag setters; the real ShieldPauseController is security-council gated). Emits ShieldPauseContractSet.",
      specRefs: ["§5.4"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setShieldPauseContract", [book.MOCK_PAUSE]),
    decodedCall: { function: "setShieldPauseContract", args: { shieldPauseContract: book.MOCK_PAUSE } },
    postReads: [{ key: "pool.shieldPauseContract", read: () => pool.shieldPauseContract() }],
  });

  const mockSetupTx = (
    target: "MOCK_PAUSE" | "MOCK_FEE_MODULE",
    contract: any,
    method: string,
    arg: boolean | number,
    description: string
  ) => ({
    from: deployer,
    fromLabel: "DEPLOYER",
    to: book[target],
    toLabel: target,
    calldata: contract.interface.encodeFunctionData(method, [arg]),
    description,
  });

  const pauseReads = (): StateRead[] => [
    { key: "mockPause.shieldsPaused", read: () => mockPause.contract.shieldsPaused() },
    { key: "mockPause.withdrawOnlyMode", read: () => mockPause.contract.withdrawOnlyMode() },
    { key: "mockPause.emergencyPaused", read: () => mockPause.contract.emergencyPaused() },
  ];

  {
    const req = makeShieldRequest("shield-paused-revert", erc20Token(book.USDC), ONE_USDC);
    await recorder.capture({
      meta: {
        id: "shield-paused-revert",
        category: "pause",
        description: "Shield while shieldsPaused()=true reverts before any token movement (spec §7.1 step 1).",
        specRefs: ["§7.1"],
        dependsOn: ["admin-set-shield-pause-contract"],
        setup: [...FUNDING_SETUP, "MockShieldPauseController.setShieldsPaused(true)"],
      },
      setupTxs: [mockSetupTx("MOCK_PAUSE", mockPause.contract, "setShieldsPaused", true, "pause shields")],
      from: alice, fromLabel: "ALICE", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("shield", [[req], ethers.ZeroAddress]),
      decodedCall: { function: "shield", args: { requests: [req], integrator: ethers.ZeroAddress } },
      expectRevert: true, expectReason: "ShieldModule: shields paused",
      balancesOf: balances(),
      preReads: pauseReads(),
    });
  }
  {
    const pos = await treePos();
    const tx = makeTransaction({
      seed: "transact-withdraw-only-revert", nullifierCount: 1, commitmentCount: 1,
      merkleRoot: pos.merkleRoot, treeNumber: pos.treeNumber, chainId,
    });
    await recorder.capture({
      meta: {
        id: "transact-withdraw-only-revert",
        category: "pause",
        description: "Transact with unshield=NONE while withdrawOnlyMode()=true reverts (spec §8.1 step 3).",
        specRefs: ["§8.1"],
        proofsBypassed: true,
        dependsOn: ["admin-set-shield-pause-contract"],
        setup: ["MockShieldPauseController.setShieldsPaused(false) + setWithdrawOnlyMode(true)", "testingMode = true"],
      },
      setupTxs: [
        mockSetupTx("MOCK_PAUSE", mockPause.contract, "setShieldsPaused", false, "unpause shields"),
        mockSetupTx("MOCK_PAUSE", mockPause.contract, "setWithdrawOnlyMode", true, "enable withdraw-only mode"),
      ],
      from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("transact", [[tx]]),
      decodedCall: { function: "transact", args: { txs: [tx] } },
      expectRevert: true, expectReason: "TransactModule: withdraw only",
      balancesOf: balances(),
      preReads: pauseReads(),
    });
  }

  {
    // Withdraw-only mode still allows unshield transactions.
    const pos = await treePos();
    const tx = makeTransaction({
      seed: "transact-withdraw-only-unshield-ok", nullifierCount: 1, commitmentCount: 2,
      merkleRoot: pos.merkleRoot, treeNumber: pos.treeNumber, chainId,
      unshield: UnshieldType.NORMAL,
      unshieldPreimage: {
        npk: ethers.zeroPadValue(bob.address, 32),
        token: erc20Token(book.USDC),
        value: ONE_USDC,
      },
    });
    await recorder.capture({
      meta: {
        id: "transact-withdraw-only-unshield-ok",
        category: "pause",
        description: "Unshield transaction SUCCEEDS while withdrawOnlyMode()=true — the mode only blocks unshield=NONE (spec §8.1 step 3).",
        specRefs: ["§8.1"],
        proofsBypassed: true,
        dependsOn: ["transact-withdraw-only-revert"],
        setup: ["MockShieldPauseController.setWithdrawOnlyMode(true)", "testingMode = true"],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("transact", [[tx]]),
      decodedCall: { function: "transact", args: { txs: [tx] } },
      balancesOf: balances(),
      preReads: [...pauseReads(), ...transactReads(pos.treeNumber, pos.merkleRoot, tx.nullifiers)],
      postReads: postRootRead(),
    });
  }
  {
    const pos = await treePos();
    const tx = makeTransaction({
      seed: "transact-emergency-paused-revert", nullifierCount: 1, commitmentCount: 2,
      merkleRoot: pos.merkleRoot, treeNumber: pos.treeNumber, chainId,
      unshield: UnshieldType.NORMAL,
      unshieldPreimage: {
        npk: ethers.zeroPadValue(bob.address, 32),
        token: erc20Token(book.USDC),
        value: ONE_USDC,
      },
    });
    await recorder.capture({
      meta: {
        id: "transact-emergency-paused-revert",
        category: "pause",
        description: "Any transact — including unshields — reverts while emergencyPaused()=true (spec §8.1 step 2).",
        specRefs: ["§8.1", "§8.2"],
        proofsBypassed: true,
        dependsOn: ["admin-set-shield-pause-contract"],
        setup: ["MockShieldPauseController.setWithdrawOnlyMode(false) + setEmergencyPaused(true)", "testingMode = true"],
      },
      setupTxs: [
        mockSetupTx("MOCK_PAUSE", mockPause.contract, "setWithdrawOnlyMode", false, "disable withdraw-only mode"),
        mockSetupTx("MOCK_PAUSE", mockPause.contract, "setEmergencyPaused", true, "enable emergency pause"),
      ],
      from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("transact", [[tx]]),
      decodedCall: { function: "transact", args: { txs: [tx] } },
      expectRevert: true, expectReason: "TransactModule: emergency paused",
      balancesOf: balances(),
      preReads: pauseReads(),
    });
  }
  await recorder.capture({
    meta: {
      id: "admin-clear-shield-pause-contract",
      category: "admin",
      description: "Owner clears shieldPauseContract back to address(0), disabling all three pause checks (spec §10).",
      specRefs: ["§5.4", "§10"],
      dependsOn: ["shield-paused-revert", "transact-withdraw-only-revert", "transact-emergency-paused-revert"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setShieldPauseContract", [ethers.ZeroAddress]),
    decodedCall: { function: "setShieldPauseContract", args: { shieldPauseContract: ethers.ZeroAddress } },
    postReads: [{ key: "pool.shieldPauseContract", read: () => pool.shieldPauseContract() }],
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE G — module-confinement + fee-module-malformed edge vectors
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Phase G: edge / revert vectors ===");

  await recorder.capture({
    meta: {
      id: "revert-insert-leaves-only-self",
      category: "edge",
      description: "Direct external call to the router's insertLeaves reverts — tree mutation is self-call gated (I-9).",
      specRefs: ["§5.5", "I-9"],
    },
    from: alice, fromLabel: "ALICE", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("insertLeaves", [[d32("revert-insert-leaves-only-self:leaf")]]),
    decodedCall: { function: "insertLeaves", args: { leaves: [d32("revert-insert-leaves-only-self:leaf")] } },
    expectRevert: true, expectReason: "Only self",
    balancesOf: balances(),
  });

  {
    const req = makeShieldRequest("revert-module-direct-call", erc20Token(book.USDC), ONE_USDC);
    await recorder.capture({
      meta: {
        id: "revert-module-direct-call",
        category: "edge",
        description: "Calling ShieldModule.shield directly (not via router delegatecall) trips the onlyDelegatecall guard (I-9).",
        specRefs: ["§1.2", "I-9"],
        setup: FUNDING_SETUP,
      },
      from: alice, fromLabel: "ALICE", to: book.SHIELD_MODULE, toLabel: "SHIELD_MODULE",
      calldata: shieldModuleIface.encodeFunctionData("shield", [[req], ethers.ZeroAddress]),
      decodedCall: { function: "ShieldModule.shield (direct)", args: { requests: [req], integrator: ethers.ZeroAddress } },
      expectRevert: true, expectReason: "PrivacyPoolStorage: Direct call not allowed",
      balancesOf: balances(),
    });
  }

  // Malformed fee module: totalFee > amount forces a checked-subtraction panic.
  await recorder.capture({
    meta: {
      id: "admin-set-fee-module-malformed",
      category: "admin",
      description: "Owner points feeModule at the capture-only MockConfigurableFeeModule (mode=1: totalFee = amount + 1).",
      specRefs: ["§5.4", "§10"],
      dependsOn: ["admin-clear-shield-pause-contract"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setFeeModule", [book.MOCK_FEE_MODULE]),
    decodedCall: { function: "setFeeModule", args: { feeModule: book.MOCK_FEE_MODULE } },
    postReads: [{ key: "pool.feeModule", read: () => pool.feeModule() }],
  });

  {
    const req = makeShieldRequest("revert-fee-module-malformed-overflow", erc20Token(book.USDC), ONE_USDC);
    await recorder.capture({
      meta: {
        id: "revert-fee-module-malformed-overflow",
        category: "edge",
        description: "Fee module returning totalFee > amount: base = value - totalFee underflows → Panic(0x11) bubbled verbatim through the router (spec §7.3, §5.7). No tokens move (I-8).",
        specRefs: ["§7.3", "§5.7", "I-8", "§10"],
        dependsOn: ["admin-set-fee-module-malformed"],
        setup: [...FUNDING_SETUP, "MockConfigurableFeeModule.setMode(1) — totalFee = amount + 1"],
      },
      setupTxs: [mockSetupTx("MOCK_FEE_MODULE", mockFee.contract, "setMode", 1, "fee module mode=1 (totalFee overflow)")],
      from: alice, fromLabel: "ALICE", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("shield", [[req], ethers.ZeroAddress]),
      decodedCall: { function: "shield", args: { requests: [req], integrator: ethers.ZeroAddress } },
      expectRevert: true,
      balancesOf: balances(),
    });
  }

  {
    const req = makeShieldRequest("revert-fee-module-reverting", erc20Token(book.USDC), ONE_USDC);
    await recorder.capture({
      meta: {
        id: "revert-fee-module-reverting",
        category: "edge",
        description: "Fee module whose calculateShieldFee reverts: the module's revert string bubbles verbatim through the router's delegatecall helper (spec §5.7).",
        specRefs: ["§7.3", "§5.7", "I-8"],
        dependsOn: ["admin-set-fee-module-malformed"],
        setup: [...FUNDING_SETUP, "MockConfigurableFeeModule.setMode(2) — calculateShieldFee reverts 'MockFeeModule: boom'"],
      },
      setupTxs: [mockSetupTx("MOCK_FEE_MODULE", mockFee.contract, "setMode", 2, "fee module mode=2 (calculateShieldFee reverts)")],
      from: alice, fromLabel: "ALICE", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("shield", [[req], ethers.ZeroAddress]),
      decodedCall: { function: "shield", args: { requests: [req], integrator: ethers.ZeroAddress } },
      expectRevert: true, expectReason: "MockFeeModule: boom",
      balancesOf: balances(),
    });
  }

  // Restore a clean, production-like end state.
  await recorder.capture({
    meta: {
      id: "admin-set-fee-module-zero-3",
      category: "admin",
      description: "Owner detaches the malformed mock fee module (cleanup; end state feeModule = 0).",
      specRefs: ["§5.4"],
      dependsOn: ["revert-fee-module-malformed-overflow", "revert-fee-module-reverting"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setFeeModule", [ethers.ZeroAddress]),
    decodedCall: { function: "setFeeModule", args: { feeModule: ethers.ZeroAddress } },
    postReads: [{ key: "pool.feeModule", read: () => pool.feeModule() }],
  });

  await recorder.capture({
    meta: {
      id: "admin-set-testing-mode-false",
      category: "admin",
      description: "Owner disables testingMode (cleanup): real SNARK verification restored; double TestingModeSet emission again (OQ-8). Final state matches the deployed fixturenet plus captured history.",
      specRefs: ["§5.4", "§5.6", "OQ-8"],
      dependsOn: ["admin-set-testing-mode-true"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setTestingMode", [false]),
    decodedCall: { function: "setTestingMode", args: { enabled: false } },
    postReads: [{ key: "pool.testingMode", read: () => pool.testingMode() }],
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Manifest
  // ══════════════════════════════════════════════════════════════════════════
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generator: "scripts/contract-vectors/capture.ts",
    network: {
      name: "local fixturenet (Anvil hub chain, mock CCTP)",
      chainId,
      rpc: "http://localhost:8545",
      hubDomain: HUB_DOMAIN,
    },
    proofPolicy: {
      summary: "All transact/unshield vectors captured with testingMode proof bypass active (spec §5.6 step 1): proofs are zero structs and calldata is replayable without circuit artifacts. Shield/admin/shield-in vectors need no proofs.",
      bypassEnabledByVector: "admin-set-testing-mode-true",
      bypassDisabledByVector: "admin-set-testing-mode-false",
    },
    bootCommands: [
      "npm run chains",
      "source config/local.env",
      "npm run compile",
      "npm run deploy:cctp:hub",
      "npm run deploy:aave:hub",
      "npm run deploy:governance",
      "npm run deploy:privacy-pool:hub",
      "npm run deploy:gasless-wrapper:hub",
      "npm run deploy:yield:hub",
      "npm run deploy:fee-module",
      "npx hardhat run scripts/contract-vectors/capture.ts --network hub",
    ],
    addressBook: book,
    notes: [
      "Replay order: topologically sort `vectors` by dependsOn (the array order below is already a valid execution order).",
      "Address substitution: calldata embeds capture-time addresses; replay on a new deployment must re-encode decodedCall.args with the new addressBook (labels in tx.from/to + addressBook).",
      "Vectors with requiresImpersonation must be sent from an impersonated account (hardhat_impersonateAccount / anvil_impersonateAccount).",
      "Merkle rollover (treeNumber > 0) is NOT covered: reaching it needs >65,536 leaf insertions (~100+ full blocks of batch inserts) — see OQ-1 and README 'Uncovered'.",
    ],
    vectors: recorder.entries,
  };
  writeJSON(path.join(OUT_DIR, "manifest.json"), manifest);

  console.log(`\n=== Capture complete: ${recorder.entries.length} vectors ===`);
  console.log(`Output: ${OUT_DIR}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
