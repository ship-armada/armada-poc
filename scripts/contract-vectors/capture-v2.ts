/**
 * Golden-vector capture — POST-DRIFT DELTA corpus (v2).
 *
 * Captures the behavioral surface that main absorbed after the original
 * (pre-drift) corpus was captured: the M0-era fixes now ported into the
 * rewritten contracts (deviation register D-15..D-18). Runs against a fresh
 * fixturenet deployed from the CURRENT (main-behavior) contracts; replay of
 * this corpus against the rewritten contracts is the post-drift equivalence
 * gate. The original 71-vector corpus (contract-vectors/) remains the
 * pre-drift regression record.
 *
 * Covered:
 *   - adapterRegistry privilege (set-once, registry-derived fee exemption)
 *   - token blocklist admin + blocked-shield revert + USDC unblockable
 *   - remoteHookRouters pinning + "Hook router not configured" revert
 *   - multi-note cross-chain shield-in (recipient absorbs CCTP fee; fee notes
 *     at full value; single batched Shield event)
 *   - atomic cross-chain unshield destination binding (CCTPBindingLib) +
 *     uniqueNonce echo + unbound/hijack reverts
 *   - deployer-gated initialize (non-deployer revert)
 *   - reentrancy guard on shield (MaliciousReentrantToken)
 *
 * Prerequisites: identical boot to the v1 corpus (see README.md), then:
 *   npx hardhat run scripts/contract-vectors/capture-v2.ts --network hub
 * Output: test-foundry/fixtures/contract-vectors-v2/ (override with
 * CAPTURE_OUT_DIR when capturing from a baseline worktree).
 */

import { ethers } from "hardhat";
import { Interface } from "ethers";
import * as path from "path";

import { d32, npkFromSeed, toHex, writeJSON } from "./lib/util";
import { Recorder } from "./lib/recorder";
import { deployMock } from "./lib/mock-contracts";
import { encodeBurnMessageV2, encodeMessageV2 } from "./lib/cctp-message";
import { UnshieldType, erc20Token, initPoseidon, makeShieldRequest, makeTransaction } from "./lib/builders";

const OUT_DIR = process.env.CAPTURE_OUT_DIR
  ? path.resolve(process.env.CAPTURE_OUT_DIR)
  : path.join(__dirname, "..", "..", "test-foundry", "fixtures", "contract-vectors-v2");

const ONE_USDC = 1_000_000n;
const HUB_DOMAIN = 100;
const CLIENT_DOMAIN = 101;
const CLIENT_DOMAIN_B = 102;
const CLIENT_POOL_DUMMY = "0x0000000000000000000000000000000000C11EA7";

/** Matches contracts/privacy-pool/CCTPBindingLib.sol (DOMAIN_TAG + encode). */
const CCTP_DOMAIN_TAG = ethers.keccak256(ethers.toUtf8Bytes("ArmadaCCTPUnshield.v1"));
function encodeCctpBinding(recipient: string, domain: number, maxFee: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "uint32", "uint256"],
      [CCTP_DOMAIN_TAG, recipient, domain, maxFee]
    )
  );
}

const BALANCE_TRACKED = (book: Record<string, string>) =>
  (["POOL", "ALICE", "BOB", "CAROL", "TREASURY", "DEPLOYER", "HOOK_ROUTER"] as const)
    .filter((l) => book[l])
    .map((l) => [l, book[l]] as [string, string]);

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, alice, bob, carol] = signers;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 31337) throw new Error("capture must run on the local hub fixturenet");

  const poolDeployment = require("../../deployments/privacy-pool-hub.json");
  const feeModuleDeployment = require("../../deployments/fee-module-hub.json");
  const govDeployment = require("../../deployments/governance-hub.json");

  const book: Record<string, string> = {
    DEPLOYER: deployer.address,
    ALICE: alice.address,
    BOB: bob.address,
    CAROL: carol.address,
    TREASURY: govDeployment.contracts.treasury,
    POOL: poolDeployment.contracts.privacyPool,
    VERIFIER_MODULE: poolDeployment.contracts.verifierModule,
    HOOK_ROUTER: poolDeployment.contracts.hookRouter,
    TOKEN_MESSENGER: poolDeployment.cctp.tokenMessenger,
    MESSAGE_TRANSMITTER: poolDeployment.cctp.messageTransmitter,
    USDC: poolDeployment.cctp.usdc,
    FEE_MODULE: feeModuleDeployment.contracts.feeModuleProxy,
    CLIENT_POOL: CLIENT_POOL_DUMMY,
  };

  const pool = await ethers.getContractAt("PrivacyPool", book.POOL);
  const usdc = await ethers.getContractAt("MockUSDCV2", book.USDC);
  const transmitter = await ethers.getContractAt("MockMessageTransmitterV2", book.MESSAGE_TRANSMITTER);
  const hookRouter = await ethers.getContractAt("CCTPHookRouter", book.HOOK_ROUTER);

  const poolIface = pool.interface as Interface;
  const txIface = transmitter.interface as Interface;
  const hookRouterIface = hookRouter.interface as Interface;

  await initPoseidon();

  // ── Capture-only mocks + funding (genesis; replay-check replicates exactly) ─
  const mockPause = await deployMock(deployer, "MockShieldPauseController");
  const mockFee = await deployMock(deployer, "MockConfigurableFeeModule");
  const mockRegistry = await deployMock(deployer, "MockAdapterRegistry");
  const evilFactory = await ethers.getContractFactory("MaliciousReentrantToken");
  const evil = await evilFactory.deploy();
  await evil.waitForDeployment();
  const evilAddr = await evil.getAddress();
  book.MOCK_PAUSE = mockPause.address;
  book.MOCK_FEE_MODULE = mockFee.address;
  book.MOCK_ADAPTER_REGISTRY = mockRegistry.address;
  book.MALICIOUS_TOKEN = evilAddr;

  await (await usdc.mint(alice.address, 10_000n * ONE_USDC)).wait();
  await (await usdc.mint(bob.address, 1_000n * ONE_USDC)).wait();
  await (await usdc.mint(carol.address, 1_000n * ONE_USDC)).wait();
  await (await usdc.connect(alice).approve(book.POOL, ethers.MaxUint256)).wait();
  await (await usdc.connect(bob).approve(book.POOL, ethers.MaxUint256)).wait();
  await (await usdc.connect(carol).approve(book.POOL, ethers.MaxUint256)).wait();
  await (await evil.mint(alice.address, 100n * ONE_USDC)).wait();
  const evilToken = await ethers.getContractAt("MaliciousReentrantToken", evilAddr);
  await (await evilToken.connect(alice).approve(book.POOL, ethers.MaxUint256)).wait();

  const FUNDING_SETUP = [
    "MockUSDCV2 mints (ALICE 10_000, BOB 1_000, CAROL 1_000 USDC) + max approvals to POOL",
    "MaliciousReentrantToken mint(ALICE, 100) + approve(POOL, max)",
    "Genesis mocks: MockShieldPauseController, MockConfigurableFeeModule, MockAdapterRegistry, MaliciousReentrantToken (deploy order is load-bearing for address determinism)",
  ];

  const recorder = new Recorder({
    outDir: OUT_DIR,
    pool,
    usdc,
    decoders: [pool.interface, usdc.interface, transmitter.interface, hookRouter.interface],
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
  const treePos = async () => ({
    merkleRoot: await pool.merkleRoot(),
    treeNumber: Number(await pool.treeNumber()),
  });

  const admin = async (
    id: string,
    description: string,
    fn: string,
    args: any[],
    opts: { expectRevert?: boolean; expectReason?: string; dependsOn?: string[]; postReads?: any[] } = {}
  ) => {
    await recorder.capture({
      meta: { id, category: "admin", description, specRefs: ["§5.4"], dependsOn: opts.dependsOn ?? [] },
      from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData(fn, args),
      decodedCall: { function: fn, args },
      expectRevert: opts.expectRevert,
      expectReason: opts.expectReason,
      balancesOf: balances(),
      postReads: opts.postReads,
    });
  };

  // ═══ 1. testingMode on (proof bypass for the unshield vectors) ═══
  await admin(
    "v2-admin-set-testing-mode-true",
    "Owner enables testingMode proof bypass so the unshield vectors replay without circuit artifacts (same policy as v1 corpus).",
    "setTestingMode", [true],
    { postReads: [{ key: "pool.testingMode", read: () => pool.testingMode() }] }
  );

  // ═══ 2. Flat fee 50bps (fee behavior observability) ═══
  await admin(
    "v2-admin-set-shield-fee-50",
    "Owner sets the flat shield fee to 50 bps (fee module detached on a fresh fixturenet).",
    "setShieldFee", [50],
    { dependsOn: ["v2-admin-set-testing-mode-true"],
      postReads: [{ key: "pool.shieldFee", read: () => pool.shieldFee() }] }
  );

  // ═══ 3. Remote pool + hook router wiring for cross-chain vectors ═══
  await admin(
    "v2-admin-set-remote-pool",
    "Owner registers a remote pool on domain 101 (client chain).",
    "setRemotePool", [CLIENT_DOMAIN, ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32)],
    { postReads: [{ key: `pool.remotePools[${CLIENT_DOMAIN}]`, read: () => pool.remotePools(CLIENT_DOMAIN) }] }
  );

  await admin(
    "v2-admin-set-remote-hook-router",
    "Owner pins the destinationCaller for domain 101 to the hub hook router bytes32 (D-16): outbound burns can only be delivered through the destination chain's CCTPHookRouter.",
    "setRemoteHookRouter", [CLIENT_DOMAIN, ethers.zeroPadValue(book.HOOK_ROUTER, 32)],
    { dependsOn: ["v2-admin-set-remote-pool"],
      postReads: [{ key: `pool.remoteHookRouters[${CLIENT_DOMAIN}]`, read: () => pool.remoteHookRouters(CLIENT_DOMAIN) }] }
  );

  // Second remote pool WITHOUT a hook router (for the not-configured revert).
  await admin(
    "v2-admin-set-remote-pool-102",
    "Owner registers a remote pool on domain 102 but deliberately leaves its remoteHookRouters entry unset.",
    "setRemotePool", [CLIENT_DOMAIN_B, ethers.zeroPadValue(CLIENT_POOL_DUMMY, 32)]
  );

  // ═══ 4. Adapter registry privilege (D-18) ═══
  await recorder.capture({
    meta: {
      id: "v2-admin-set-adapter-registry",
      category: "admin",
      description: "Owner sets the timelock-governed adapter registry (set-once). Setup tx authorizes CAROL in the mock registry — CAROL's next shield pays no fee.",
      specRefs: ["§5.4", "§7.3"],
      dependsOn: ["v2-admin-set-shield-fee-50"],
      setup: [...FUNDING_SETUP, "MockAdapterRegistry.setAuthorized(CAROL, true)"],
    },
    setupTxs: [{
      from: deployer, fromLabel: "DEPLOYER",
      to: mockRegistry.address, toLabel: "MOCK_ADAPTER_REGISTRY",
      calldata: (mockRegistry.contract.interface as Interface).encodeFunctionData("setAuthorized", [carol.address, true]),
      description: "authorize CAROL in the mock registry",
    }],
    from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
    calldata: poolIface.encodeFunctionData("setAdapterRegistry", [mockRegistry.address]),
    decodedCall: { function: "setAdapterRegistry", args: { registry: mockRegistry.address } },
    balancesOf: balances(),
    postReads: [{ key: "pool.adapterRegistry", read: () => pool.adapterRegistry() }],
  });

  await admin(
    "v2-admin-set-adapter-registry-twice-revert",
    "Second setAdapterRegistry reverts — the registry is immutable once set (owner has no path to grant shield privilege after configuration).",
    "setAdapterRegistry", [mockRegistry.address],
    { expectRevert: true, expectReason: "PrivacyPool: registry already set",
      dependsOn: ["v2-admin-set-adapter-registry"] }
  );

  // ═══ 5. Privilege-derived shields ═══
  {
    const req = makeShieldRequest("v2-shield-privileged-adapter", erc20Token(book.USDC), 20n * ONE_USDC);
    await recorder.capture({
      meta: {
        id: "v2-shield-privileged-adapter",
        category: "shield",
        description: "CAROL (authorized in the registry) shields 20 USDC with 50bps flat fee configured: fee = 0, full value committed (D-18 registry-derived exemption).",
        specRefs: ["§7.1", "§7.3"],
        dependsOn: ["v2-admin-set-adapter-registry"],
        setup: FUNDING_SETUP,
      },
      from: carol, fromLabel: "CAROL", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("shield", [[req], ethers.ZeroAddress]),
      decodedCall: { function: "shield", args: { requests: [req], integrator: ethers.ZeroAddress } },
      balancesOf: balances(),
    });
  }
  {
    const req = makeShieldRequest("v2-shield-unprivileged-with-registry", erc20Token(book.USDC), 20n * ONE_USDC);
    await recorder.capture({
      meta: {
        id: "v2-shield-unprivileged-with-registry",
        category: "shield",
        description: "BOB (NOT in the registry) shields 20 USDC with the registry set: flat 50bps fee charged and sent to treasury — proves the retired privilegedShieldCallers map is inert (D-18).",
        specRefs: ["§7.1", "§7.3"],
        dependsOn: ["v2-shield-privileged-adapter"],
        setup: FUNDING_SETUP,
      },
      from: bob, fromLabel: "BOB", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("shield", [[req], ethers.ZeroAddress]),
      decodedCall: { function: "shield", args: { requests: [req], integrator: ethers.ZeroAddress } },
      balancesOf: balances(),
    });
  }

  // ═══ 6. Token blocklist (D-18) ═══
  await admin(
    "v2-admin-add-to-blocklist",
    "Owner blocklists the MOCK_PAUSE address (standing in for a token). Emits AddToBlocklist; blocked tokens cannot be SHIELDED but existing notes stay exitable.",
    "addToBlocklist", [[mockPause.address]],
    { dependsOn: ["v2-admin-set-shield-fee-50"],
      postReads: [{ key: `pool.tokenBlocklist[${mockPause.address}]`, read: () => pool.tokenBlocklist(mockPause.address) }] }
  );
  {
    const req = makeShieldRequest("v2-shield-blocked-token-revert", erc20Token(mockPause.address), ONE_USDC);
    await recorder.capture({
      meta: {
        id: "v2-shield-blocked-token-revert",
        category: "shield",
        description: "Shield of a blocklisted token reverts in preimage validation (spec §7.1(a)) before any token movement.",
        specRefs: ["§7.1"],
        dependsOn: ["v2-admin-add-to-blocklist"],
        setup: FUNDING_SETUP,
      },
      from: alice, fromLabel: "ALICE", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("shield", [[req], ethers.ZeroAddress]),
      decodedCall: { function: "shield", args: { requests: [req], integrator: ethers.ZeroAddress } },
      expectRevert: true, expectReason: "ShieldModule: Token blocked",
      balancesOf: balances(),
    });
  }
  await admin(
    "v2-admin-block-usdc-revert",
    "Blocking the pool's core USDC asset reverts — in-flight cross-chain shields must stay deliverable (D-18).",
    "addToBlocklist", [[book.USDC]],
    { expectRevert: true, expectReason: "PrivacyPool: cannot block USDC",
      dependsOn: ["v2-admin-add-to-blocklist"] }
  );
  await admin(
    "v2-admin-remove-from-blocklist",
    "Owner removes the block (idempotent cleanup; end state: blocklist empty).",
    "removeFromBlocklist", [[mockPause.address]],
    { dependsOn: ["v2-shield-blocked-token-revert", "v2-admin-block-usdc-revert"],
      postReads: [{ key: `pool.tokenBlocklist[${mockPause.address}]`, read: () => pool.tokenBlocklist(mockPause.address) }] }
  );

  // ═══ 7. Multi-note cross-chain shield-in (D-15) ═══
  const shieldInMessageV2 = (
    seed: string,
    notes: { value: bigint; npk?: string; integrator?: string }[],
    gross: bigint,
    cctpFee: bigint,
    finality: number
  ) => {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const notesTuple = notes.map((n, i) => ({
      npk: n.npk ?? npkFromSeed(`${seed}:n${i}`),
      value: n.value,
      encryptedBundle: [d32(`${seed}:eb${i}0`), d32(`${seed}:eb${i}1`), d32(`${seed}:eb${i}2`)],
      shieldKey: d32(`${seed}:sk${i}`),
      integrator: n.integrator ?? ethers.ZeroAddress,
    }));
    const shieldDataArray = coder.encode(
      ["tuple(bytes32 npk, uint120 value, bytes32[3] encryptedBundle, bytes32 shieldKey, address integrator)[]"],
      [notesTuple.map((t) => [t.npk, t.value, t.encryptedBundle, t.shieldKey, t.integrator])]
    );
    const hookData = coder.encode(["tuple(uint8 messageType, bytes data)"], [[0, shieldDataArray]]);
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

  // Hook router wiring (same as v1 genesis vectors — the deploy scripts leave these unset).
  await admin(
    "v2-admin-set-hook-router",
    "Owner wires the CCTPHookRouter into the pool (required for inbound cross-chain shields).",
    "setHookRouter", [book.HOOK_ROUTER],
    { postReads: [{ key: "pool.hookRouter", read: () => pool.hookRouter() }] }
  );
  await recorder.capture({
    meta: {
      id: "v2-cctp-set-mock-relayer",
      category: "cctp-config",
      description: "Mock-CCTP wiring: point the hub MockMessageTransmitterV2's relayer at the CCTPHookRouter so relayWithHook can call receiveMessage.",
      dependsOn: ["v2-admin-set-hook-router"],
    },
    from: deployer, fromLabel: "DEPLOYER", to: book.MESSAGE_TRANSMITTER, toLabel: "MESSAGE_TRANSMITTER",
    calldata: txIface.encodeFunctionData("setRelayer", [book.HOOK_ROUTER]),
    decodedCall: { function: "setRelayer", args: { relayer: book.HOOK_ROUTER } },
    balancesOf: balances(),
  });

  {
    const message = shieldInMessageV2(
      "v2-shieldin-multi-note",
      [{ value: 500n * ONE_USDC }, { value: 5n * ONE_USDC }],
      500n * ONE_USDC, 2n * ONE_USDC, 2000
    );
    await recorder.capture({
      meta: {
        id: "v2-shieldin-multi-note",
        category: "shield-in",
        description: "Multi-note cross-chain shield-in (D-15): 500 USDC gross, 2 USDC CCTP fee; note[0] (recipient) is credited 498-5=493, note[1] (relayer fee note) mints at full 5; ONE Shield event with both commitments.",
        specRefs: ["§5.3", "§7.2"],
        dependsOn: ["v2-admin-set-hook-router", "v2-cctp-set-mock-relayer"],
        setup: ["MessageV2/BurnMessageV2 bytes fabricated off-chain per ICCTPV2.sol offsets (same bytes a client-chain MessageSent event would carry)"],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.HOOK_ROUTER, toLabel: "HOOK_ROUTER",
      calldata: hookRouterIface.encodeFunctionData("relayWithHook", [message, "0x"]),
      decodedCall: { function: "relayWithHook", args: { message, attestation: "0x" } },
      balancesOf: balances(),
    });
  }
  {
    const message = shieldInMessageV2("v2-shieldin-no-notes-revert", [], ONE_USDC, 0n, 2000);
    await recorder.capture({
      meta: {
        id: "v2-shieldin-no-notes-revert",
        category: "shield-in",
        description: "Empty ShieldData[] reverts (spec §7.2 step 2).",
        specRefs: ["§7.2"],
        dependsOn: ["v2-shieldin-multi-note"],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.HOOK_ROUTER, toLabel: "HOOK_ROUTER",
      calldata: hookRouterIface.encodeFunctionData("relayWithHook", [message, "0x"]),
      decodedCall: { function: "relayWithHook", args: { message, attestation: "0x" } },
      expectRevert: true, expectReason: "ShieldModule: no shield notes",
      balancesOf: balances(),
    });
  }

  // ═══ 8. Bound atomic cross-chain unshield (D-16) ═══
  const atomicUnshieldVector = async (
    id: string,
    description: string,
    domain: number,
    bindCorrectly: boolean,
    expectReason?: string
  ) => {
    const pos = await treePos();
    const base = 10n * ONE_USDC;
    const maxFee = ONE_USDC;
    const uniqueNonce = d32(`${id}:nonce`);
    const tx = makeTransaction({
      seed: id,
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
    tx.boundParams.adaptParams = bindCorrectly
      ? encodeCctpBinding(bob.address, domain, maxFee)
      : ethers.ZeroHash;
    await recorder.capture({
      meta: {
        id, category: "unshield", description,
        specRefs: ["§8.2"],
        proofsBypassed: true,
        dependsOn: ["v2-admin-set-testing-mode-true", "v2-admin-set-remote-pool", "v2-shieldin-multi-note"],
        setup: [
          "testingMode = true (proof bypass)",
          "remotePools[101] + remoteHookRouters[101] registered",
          "Pool USDC balance covers the bridged amount from prior shield-ins",
        ],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("atomicCrossChainUnshield", [
        tx, domain, bob.address, maxFee, uniqueNonce,
      ]),
      decodedCall: {
        function: "atomicCrossChainUnshield",
        args: { tx, destinationDomain: domain, finalRecipient: bob.address, maxFee: toHex(maxFee), uniqueNonce },
      },
      expectRevert: !!expectReason,
      expectReason,
      captureReturnData: !expectReason,
      balancesOf: balances(),
    });
  };

  await atomicUnshieldVector(
    "v2-unshield-crosschain-bound",
    "Bound atomic cross-chain unshield (D-16): adaptParams = CCTPBindingLib.encode(recipient, domain, maxFee); destinationCaller pinned to remoteHookRouters[101] in the burn call; uniqueNonce echoed in hookData; nonce=0 returned.",
    CLIENT_DOMAIN, true
  );
  await atomicUnshieldVector(
    "v2-unshield-crosschain-unbound-revert",
    "Unbound cross-chain unshield (adaptParams = 0) reverts — a relayer cannot resubmit a victim's proof with a redirected recipient (D-16).",
    CLIENT_DOMAIN, false, "TransactModule: destination not bound to proof"
  );
  await atomicUnshieldVector(
    "v2-unshield-crosschain-no-hookrouter-revert",
    "Cross-chain unshield to domain 102 (remote pool registered, hook router NOT pinned) reverts before proof validation (D-16).",
    CLIENT_DOMAIN_B, true, "TransactModule: Hook router not configured"
  );

  // ═══ 8b. Local unshield to the pool itself (cross-path replay guard, D-18) ═══
  {
    const pos = await treePos();
    const tx = makeTransaction({
      seed: "v2-unshield-to-pool-revert",
      nullifierCount: 1,
      commitmentCount: 2,
      merkleRoot: pos.merkleRoot,
      treeNumber: pos.treeNumber,
      chainId,
      unshield: UnshieldType.NORMAL,
      unshieldPreimage: {
        npk: ethers.zeroPadValue(book.POOL, 32), // recipient decodes to the pool itself
        token: erc20Token(book.USDC),
        value: ONE_USDC,
      },
    });
    await recorder.capture({
      meta: {
        id: "v2-unshield-to-pool-revert",
        category: "unshield",
        description: "Local unshield whose npk encodes the pool address reverts (D-18): blocks replaying an xchain-unshield proof through plain transact() (pool->pool payout would strand funds).",
        specRefs: ["§8.5"],
        proofsBypassed: true,
        dependsOn: ["v2-admin-set-testing-mode-true", "v2-shieldin-multi-note"],
        setup: ["testingMode = true (proof bypass)", "Pool USDC balance covers the amount (revert fires before any transfer)"],
      },
      from: deployer, fromLabel: "DEPLOYER", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("transact", [[tx]]),
      decodedCall: { function: "transact", args: { note: "1x2 tx with unshield preimage npk = POOL" } },
      expectRevert: true, expectReason: "TransactModule: unshield to pool",
      balancesOf: balances(),
    });
  }

  // ═══ 9. Deployer-gated initialize (D-18) ═══
  {
    const freshFactory = await ethers.getContractFactory("PrivacyPool");
    // Deploy the fresh pool as a setupTx (creation tx) so replay reproduces it
    // at the same deterministic address (same deployer nonce position).
    const deployNonce = await deployer.getNonce();
    const freshAddr = ethers.getCreateAddress({ from: deployer.address, nonce: deployNonce });
    await recorder.capture({
      meta: {
        id: "v2-initialize-nondeployer-revert",
        category: "admin",
        description: "initialize() from a non-deployer reverts (OQ-7 closed, D-18): a front-runner cannot initialize a freshly deployed pool with malicious params.",
        specRefs: ["§5.1"],
        setup: ["Freshly deployed uninitialized PrivacyPool (setupTx creation; captured init args are dummy addresses — the deployer check fires first)"],
      },
      setupTxs: [{
        from: deployer, fromLabel: "DEPLOYER",
        to: "", toLabel: "CREATE",
        calldata: freshFactory.bytecode,
        description: "deploy a fresh uninitialized PrivacyPool",
      }],
      from: alice, fromLabel: "ALICE", to: freshAddr, toLabel: "FRESH_POOL",
      calldata: poolIface.encodeFunctionData("initialize", [
        deployer.address, deployer.address, deployer.address, deployer.address,
        deployer.address, deployer.address, book.USDC, HUB_DOMAIN, deployer.address, deployer.address,
      ]),
      decodedCall: { function: "initialize", args: { note: "dummy module/tokenMessenger/transmitter/usdc/owner/treasury args — deployer check fires first" } },
      expectRevert: true, expectReason: "PrivacyPool: Only deployer",
      balancesOf: balances(),
    });
  }

  // ═══ 10. Reentrancy guard (D-18) ═══
  {
    await recorder.capture({
      meta: {
        id: "v2-shield-reentrancy-revert",
        category: "edge",
        description: "Shield with MaliciousReentrantToken: the token's transferFrom re-enters pool.shield mid-deposit; the router's nonReentrant guard fires (D-18).",
        specRefs: ["§5.2", "D-18"],
        dependsOn: ["v2-admin-set-shield-fee-50"],
        setup: [...FUNDING_SETUP, "MaliciousReentrantToken.setAttack(POOL, 1=shield)"],
      },
      setupTxs: [{
        from: deployer, fromLabel: "DEPLOYER",
        to: evilAddr, toLabel: "MALICIOUS_TOKEN",
        calldata: (evilToken.interface as Interface).encodeFunctionData("setAttack", [book.POOL, 1]),
        description: "arm the reentrancy attack against pool.shield",
      }],
      from: alice, fromLabel: "ALICE", to: book.POOL, toLabel: "POOL",
      calldata: poolIface.encodeFunctionData("shield", [
        [makeShieldRequest("v2-shield-reentrancy-revert", erc20Token(evilAddr), ONE_USDC)],
        ethers.ZeroAddress,
      ]),
      decodedCall: { function: "shield", args: { note: "single 1-token shield of MALICIOUS_TOKEN", integrator: ethers.ZeroAddress } },
      expectRevert: true, expectReason: "PrivacyPool: reentrant call",
      balancesOf: balances(),
    });
  }

  // ═══ Cleanup: restore production-like verification ═══
  await admin(
    "v2-admin-set-testing-mode-false",
    "Owner disables testingMode (cleanup): real SNARK verification restored.",
    "setTestingMode", [false],
    { dependsOn: ["v2-unshield-crosschain-bound"],
      postReads: [{ key: "pool.testingMode", read: () => pool.testingMode() }] }
  );

  // ═══ Manifest ═══
  const manifest = {
    version: 2,
    generatedAt: new Date().toISOString(),
    generator: "scripts/contract-vectors/capture-v2.ts",
    network: {
      name: "local fixturenet (Anvil hub chain, mock CCTP)",
      chainId,
      rpc: "http://localhost:8545",
      hubDomain: HUB_DOMAIN,
    },
    proofPolicy: {
      summary: "Unshield vectors captured with testingMode proof bypass active; all others need no proofs. Same policy as the v1 corpus.",
      bypassEnabledByVector: "v2-admin-set-testing-mode-true",
      bypassDisabledByVector: "v2-admin-set-testing-mode-false",
    },
    bootCommands: [
      "anvil --port 8545 --chain-id 31337 --block-time 1 --accounts 200",
      "source config/local.env",
      "npm run compile",
      "npm run deploy:cctp:hub",
      "npm run deploy:aave:hub",
      "npm run deploy:governance",
      "npm run deploy:privacy-pool:hub",
      "npm run deploy:gasless-wrapper:hub",
      "npm run deploy:yield:hub",
      "npm run deploy:fee-module",
      "npx hardhat run scripts/contract-vectors/capture-v2.ts --network hub",
    ],
    addressBook: book,
    notes: [
      "Delta corpus for the post-drift behavior (main absorbed M0-era fixes after the v1 corpus): replay against the rewritten contracts is the post-drift equivalence gate.",
      "Genesis deploy order is load-bearing: MockShieldPauseController, MockConfigurableFeeModule, MockAdapterRegistry, MaliciousReentrantToken, then funding/approvals (see replay-check.ts).",
      "Replay requires the fixturenet booted with --timestamp <generatedAt unix> (EIP-2612-free corpus, but keep the harness invariant).",
    ],
    vectors: recorder.entries,
  };
  writeJSON(path.join(OUT_DIR, "manifest.json"), manifest);

  console.log(`\n=== v2 capture complete: ${recorder.entries.length} vectors ===`);
  console.log(`Output: ${OUT_DIR}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
