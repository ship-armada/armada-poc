/**
 * Privacy Pool Integration Hardening Tests
 *
 * Additional integration tests covering complex scenarios:
 * 1. Multi-shield batch → transact → unshield (full lifecycle)
 * 2. Fee accounting end-to-end (shield + unshield fees → treasury)
 * 3. Multiple concurrent users in same block
 * 4. Cross-chain round-trip (Client shield → Hub unshield → Client)
 * 5. Batch transact with mixed operations
 * 6. Sequential shields preserve merkle root history
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import * as fs from "fs";
import * as path from "path";
// @ts-ignore
import { buildPoseidon } from "circomlibjs";

const poseidonBytecode = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "lib", "poseidon_bytecode.json"), "utf-8")
);

import {
  loadVerificationKeys,
  TESTING_ARTIFACT_CONFIGS,
} from "../lib/artifacts";

const DOMAINS = { hub: 100, client: 101 };
const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("Privacy Pool Integration Hardening", function () {
  let hubUsdc: Contract;
  let hubTokenMessenger: Contract;
  let hubMessageTransmitter: Contract;
  let privacyPool: Contract;
  let merkleModule: Contract;
  let verifierModule: Contract;
  let shieldModule: Contract;
  let transactModule: Contract;

  let clientUsdc: Contract;
  let clientTokenMessenger: Contract;
  let clientMessageTransmitter: Contract;
  let privacyPoolClient: Contract;
  let hubHookRouter: Contract;
  let clientHookRouter: Contract;

  let deployer: Signer;
  let alice: Signer;
  let bob: Signer;
  let charlie: Signer;
  let relayer: Signer;

  let deployerAddress: string;
  let aliceAddress: string;
  let bobAddress: string;
  let charlieAddress: string;
  let relayerAddress: string;
  let privacyPoolAddress: string;
  let clientAddress: string;
  let treasuryAddress: string;

  let poseidon: any;
  let F: any;

  before(async function () {
    [deployer, alice, bob, charlie, relayer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    aliceAddress = await alice.getAddress();
    bobAddress = await bob.getAddress();
    charlieAddress = await charlie.getAddress();
    relayerAddress = await relayer.getAddress();

    poseidon = await buildPoseidon();
    F = poseidon.F;

    // ──── Deploy Hub Chain ────
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    hubUsdc = await MockUSDCV2.deploy("Mock USDC", "USDC");

    const MockMessageTransmitterV2 = await ethers.getContractFactory("MockMessageTransmitterV2");
    hubMessageTransmitter = await MockMessageTransmitterV2.deploy(DOMAINS.hub, relayerAddress);

    const MockTokenMessengerV2 = await ethers.getContractFactory("MockTokenMessengerV2");
    hubTokenMessenger = await MockTokenMessengerV2.deploy(
      await hubMessageTransmitter.getAddress(),
      await hubUsdc.getAddress(),
      DOMAINS.hub
    );
    await hubMessageTransmitter.setTokenMessenger(await hubTokenMessenger.getAddress());
    await hubUsdc.addMinter(await hubTokenMessenger.getAddress());

    // Deploy Poseidon libraries
    const poseidonT3Tx = await deployer.sendTransaction({ data: poseidonBytecode.PoseidonT3.bytecode });
    const poseidonT3Address = (await poseidonT3Tx.wait())!.contractAddress!;
    const poseidonT4Tx = await deployer.sendTransaction({ data: poseidonBytecode.PoseidonT4.bytecode });
    const poseidonT4Address = (await poseidonT4Tx.wait())!.contractAddress!;

    // Deploy modules
    merkleModule = await (await ethers.getContractFactory("MerkleModule", { libraries: { PoseidonT3: poseidonT3Address } })).deploy();
    verifierModule = await (await ethers.getContractFactory("VerifierModule")).deploy();
    shieldModule = await (await ethers.getContractFactory("ShieldModule", { libraries: { PoseidonT4: poseidonT4Address } })).deploy();
    transactModule = await (await ethers.getContractFactory("TransactModule", { libraries: { PoseidonT4: poseidonT4Address } })).deploy();

    // Deploy PrivacyPool router
    const PrivacyPool = await ethers.getContractFactory("PrivacyPool");
    privacyPool = await PrivacyPool.deploy();
    privacyPoolAddress = await privacyPool.getAddress();

    await privacyPool.initialize(
      await shieldModule.getAddress(),
      await transactModule.getAddress(),
      await merkleModule.getAddress(),
      await verifierModule.getAddress(),
      await hubTokenMessenger.getAddress(),
      await hubMessageTransmitter.getAddress(),
      await hubUsdc.getAddress(),
      DOMAINS.hub,
      deployerAddress
    );

    await loadVerificationKeys(privacyPool, TESTING_ARTIFACT_CONFIGS, false);
    await privacyPool.setTestingMode(true);
    treasuryAddress = deployerAddress;
    await privacyPool.setTreasury(treasuryAddress);
    await privacyPool.setShieldFee(50); // 0.50%

    // ──── Deploy Client Chain ────
    clientUsdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    clientMessageTransmitter = await MockMessageTransmitterV2.deploy(DOMAINS.client, relayerAddress);
    clientTokenMessenger = await MockTokenMessengerV2.deploy(
      await clientMessageTransmitter.getAddress(),
      await clientUsdc.getAddress(),
      DOMAINS.client
    );
    await clientMessageTransmitter.setTokenMessenger(await clientTokenMessenger.getAddress());
    await clientUsdc.addMinter(await clientTokenMessenger.getAddress());

    const PrivacyPoolClient = await ethers.getContractFactory("PrivacyPoolClient");
    privacyPoolClient = await PrivacyPoolClient.deploy();
    clientAddress = await privacyPoolClient.getAddress();

    await privacyPoolClient.initialize(
      await clientTokenMessenger.getAddress(),
      await clientMessageTransmitter.getAddress(),
      await clientUsdc.getAddress(),
      DOMAINS.client,
      DOMAINS.hub,
      ethers.zeroPadValue(privacyPoolAddress, 32),
      deployerAddress
    );

    // Deploy CCTPHookRouters
    const CCTPHookRouter = await ethers.getContractFactory("CCTPHookRouter");
    hubHookRouter = await CCTPHookRouter.deploy(await hubMessageTransmitter.getAddress());
    clientHookRouter = await CCTPHookRouter.deploy(await clientMessageTransmitter.getAddress());

    // Set hookRouter on contracts
    await privacyPool.setHookRouter(await hubHookRouter.getAddress());
    await privacyPoolClient.setHookRouter(await clientHookRouter.getAddress());

    // Set mock MessageTransmitter relayer to hookRouter (so hookRouter can call receiveMessage)
    await hubMessageTransmitter.connect(relayer).setRelayer(await hubHookRouter.getAddress());
    await clientMessageTransmitter.connect(relayer).setRelayer(await clientHookRouter.getAddress());

    // Link deployments
    await privacyPool.setRemotePool(DOMAINS.client, ethers.zeroPadValue(clientAddress, 32));
    await hubTokenMessenger.setRemoteTokenMessenger(DOMAINS.client, ethers.zeroPadValue(await clientTokenMessenger.getAddress(), 32));
    await clientTokenMessenger.setRemoteTokenMessenger(DOMAINS.hub, ethers.zeroPadValue(await hubTokenMessenger.getAddress(), 32));
  });

  // ═══════════════════════════════════════════════════════════════════
  // Helper functions
  // ═══════════════════════════════════════════════════════════════════

  function validNpk(seed: string): string {
    const raw = BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed)));
    return ethers.zeroPadValue(ethers.toBeHex(raw % SNARK_SCALAR_FIELD), 32);
  }

  function makeShieldRequest(token: string, amount: bigint, npkSeed: string) {
    return {
      preimage: {
        npk: validNpk(npkSeed),
        token: { tokenType: 0, tokenAddress: token, tokenSubID: 0 },
        value: amount,
      },
      ciphertext: {
        encryptedBundle: [
          ethers.keccak256(ethers.toUtf8Bytes(`enc1-${npkSeed}`)),
          ethers.keccak256(ethers.toUtf8Bytes(`enc2-${npkSeed}`)),
          ethers.keccak256(ethers.toUtf8Bytes(`enc3-${npkSeed}`)),
        ],
        shieldKey: ethers.keccak256(ethers.toUtf8Bytes(`key-${npkSeed}`)),
      },
    };
  }

  function computeCommitmentHash(npkBigInt: bigint, tokenId: bigint, value: bigint): string {
    const hash = poseidon([F.e(npkBigInt), F.e(tokenId), F.e(value)]);
    return ethers.zeroPadValue(ethers.toBeHex(BigInt(F.toString(hash))), 32);
  }

  function makeTransaction(opts: {
    merkleRoot: string;
    nullifiers: string[];
    commitments: string[];
    unshield?: number;
    unshieldPreimage?: any;
    ciphertextCount?: number;
  }) {
    const unshieldType = opts.unshield ?? 0;
    const ciphertextCount = opts.ciphertextCount ??
      (unshieldType !== 0 ? opts.commitments.length - 1 : opts.commitments.length);

    const ciphertext = Array.from({ length: ciphertextCount }, () => ({
      ciphertext: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
      blindedSenderViewingKey: ethers.ZeroHash,
      blindedReceiverViewingKey: ethers.ZeroHash,
      annotationData: "0x",
      memo: "0x",
    }));

    return {
      proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
      merkleRoot: opts.merkleRoot,
      nullifiers: opts.nullifiers,
      commitments: opts.commitments,
      boundParams: {
        treeNumber: 0,
        minGasPrice: 0,
        unshield: unshieldType,
        chainID: 31337,
        adaptContract: ethers.ZeroAddress,
        adaptParams: ethers.ZeroHash,
        commitmentCiphertext: ciphertext,
      },
      unshieldPreimage: opts.unshieldPreimage ?? {
        npk: ethers.ZeroHash,
        token: { tokenType: 0, tokenAddress: ethers.ZeroAddress, tokenSubID: 0 },
        value: 0,
      },
    };
  }

  async function shieldAndGetRoot(signer: Signer, amount: bigint, npkSeed: string): Promise<string> {
    const signerAddr = await signer.getAddress();
    const usdcAddr = await hubUsdc.getAddress();
    await hubUsdc.mint(signerAddr, amount);
    await hubUsdc.connect(signer).approve(privacyPoolAddress, amount);
    await privacyPool.connect(signer).shield([makeShieldRequest(usdcAddr, amount, npkSeed)]);
    return await privacyPool.merkleRoot();
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 1: Multi-shield batch → transact → unshield lifecycle
  // ═══════════════════════════════════════════════════════════════════

  describe("Full Lifecycle: batch shield → transact → unshield", function () {
    it("should complete multi-shield, transact, and local unshield", async function () {
      const usdcAddr = await hubUsdc.getAddress();
      const SHIELD_EACH = ethers.parseUnits("20", 6); // 20 USDC each
      const SHIELD_COUNT = 5;
      const totalShield = SHIELD_EACH * BigInt(SHIELD_COUNT);

      // Step 1: Batch shield 5 notes
      await hubUsdc.mint(aliceAddress, totalShield);
      await hubUsdc.connect(alice).approve(privacyPoolAddress, totalShield);

      const requests = Array.from({ length: SHIELD_COUNT }, (_, i) =>
        makeShieldRequest(usdcAddr, SHIELD_EACH, `lifecycle-${i}`)
      );
      await privacyPool.connect(alice).shield(requests);

      const root = await privacyPool.merkleRoot();
      const nextLeaf = await privacyPool.nextLeafIndex();
      expect(nextLeaf).to.be.gte(SHIELD_COUNT);

      // Step 2: Transact (private transfer — 1 nullifier, 2 new commitments)
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("lifecycle-null-1"));
      const newCommit1 = ethers.keccak256(ethers.toUtf8Bytes("lifecycle-commit-1"));
      const newCommit2 = ethers.keccak256(ethers.toUtf8Bytes("lifecycle-commit-2"));

      const txData = makeTransaction({
        merkleRoot: root,
        nullifiers: [nullifier],
        commitments: [newCommit1, newCommit2],
      });

      await privacyPool.transact([txData]);
      const rootAfterTransact = await privacyPool.merkleRoot();
      expect(rootAfterTransact).to.not.equal(root);

      // Step 3: Unshield to Bob
      const unshieldValue = ethers.parseUnits("15", 6);
      const npkBigInt = BigInt(bobAddress);
      const tokenId = BigInt(usdcAddr);
      const unshieldCommitHash = computeCommitmentHash(npkBigInt, tokenId, unshieldValue);
      const changeCommit = ethers.keccak256(ethers.toUtf8Bytes("lifecycle-change"));

      const unshieldTx = makeTransaction({
        merkleRoot: rootAfterTransact,
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("lifecycle-null-2"))],
        commitments: [changeCommit, unshieldCommitHash],
        unshield: 1,
        unshieldPreimage: {
          npk: ethers.zeroPadValue(bobAddress, 32),
          token: { tokenType: 0, tokenAddress: usdcAddr, tokenSubID: 0 },
          value: unshieldValue,
        },
      });

      const bobBalanceBefore = await hubUsdc.balanceOf(bobAddress);
      await privacyPool.transact([unshieldTx]);
      const bobBalanceAfter = await hubUsdc.balanceOf(bobAddress);

      // Bob should receive unshieldValue minus unshield fee
      // Unshield fee is 0 by default, so bob gets full amount
      expect(bobBalanceAfter - bobBalanceBefore).to.equal(unshieldValue);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TEST 2: Fee accounting end-to-end
  // ═══════════════════════════════════════════════════════════════════

  describe("Fee Accounting End-to-End", function () {
    it("should correctly account shield fees to treasury", async function () {
      const usdcAddr = await hubUsdc.getAddress();
      const AMOUNT = ethers.parseUnits("1000", 6); // 1000 USDC

      const treasuryBefore = await hubUsdc.balanceOf(treasuryAddress);
      const poolBefore = await hubUsdc.balanceOf(privacyPoolAddress);

      await hubUsdc.mint(aliceAddress, AMOUNT);
      await hubUsdc.connect(alice).approve(privacyPoolAddress, AMOUNT);
      await privacyPool.connect(alice).shield([makeShieldRequest(usdcAddr, AMOUNT, "fee-test")]);

      const treasuryAfter = await hubUsdc.balanceOf(treasuryAddress);
      const poolAfter = await hubUsdc.balanceOf(privacyPoolAddress);

      // Shield fee is 50 bps = 0.50%
      const expectedFee = AMOUNT * 50n / 10000n; // 5 USDC
      const expectedBase = AMOUNT - expectedFee; // 995 USDC

      expect(treasuryAfter - treasuryBefore).to.equal(expectedFee);
      expect(poolAfter - poolBefore).to.equal(expectedBase);
      // Total conservation: fee + base = original amount
      expect(expectedFee + expectedBase).to.equal(AMOUNT);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TEST 3: Multiple concurrent users
  // ═══════════════════════════════════════════════════════════════════

  describe("Concurrent Users", function () {
    it("multiple users can shield in separate transactions in same block context", async function () {
      const usdcAddr = await hubUsdc.getAddress();
      const AMOUNT = ethers.parseUnits("50", 6);

      // Mint and approve for all users
      await hubUsdc.mint(aliceAddress, AMOUNT);
      await hubUsdc.mint(bobAddress, AMOUNT);
      await hubUsdc.mint(charlieAddress, AMOUNT);
      await hubUsdc.connect(alice).approve(privacyPoolAddress, AMOUNT);
      await hubUsdc.connect(bob).approve(privacyPoolAddress, AMOUNT);
      await hubUsdc.connect(charlie).approve(privacyPoolAddress, AMOUNT);

      const rootBefore = await privacyPool.merkleRoot();

      // All three users shield
      await privacyPool.connect(alice).shield([makeShieldRequest(usdcAddr, AMOUNT, "concurrent-alice")]);
      const rootAfterAlice = await privacyPool.merkleRoot();

      await privacyPool.connect(bob).shield([makeShieldRequest(usdcAddr, AMOUNT, "concurrent-bob")]);
      const rootAfterBob = await privacyPool.merkleRoot();

      await privacyPool.connect(charlie).shield([makeShieldRequest(usdcAddr, AMOUNT, "concurrent-charlie")]);
      const rootAfterCharlie = await privacyPool.merkleRoot();

      // Each should produce a unique root
      expect(rootAfterAlice).to.not.equal(rootBefore);
      expect(rootAfterBob).to.not.equal(rootAfterAlice);
      expect(rootAfterCharlie).to.not.equal(rootAfterBob);

      // All roots should be in history
      expect(await privacyPool.rootHistory(0, rootAfterAlice)).to.be.true;
      expect(await privacyPool.rootHistory(0, rootAfterBob)).to.be.true;
      expect(await privacyPool.rootHistory(0, rootAfterCharlie)).to.be.true;
    });

    it("users can transact using different historical roots", async function () {
      // After concurrent shields above, Alice and Bob each use a different root
      const roots: string[] = [];

      // Shield two notes to create two roots
      const root1 = await shieldAndGetRoot(alice, ethers.parseUnits("10", 6), "multi-root-1");
      roots.push(root1);
      const root2 = await shieldAndGetRoot(bob, ethers.parseUnits("10", 6), "multi-root-2");
      roots.push(root2);

      // Transact using root1 (older root)
      const tx1 = makeTransaction({
        merkleRoot: root1,
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("multi-root-null-1"))],
        commitments: [ethers.keccak256(ethers.toUtf8Bytes("multi-root-commit-1"))],
      });
      await expect(privacyPool.transact([tx1])).to.not.be.reverted;

      // Transact using root2 (newer root)
      const tx2 = makeTransaction({
        merkleRoot: root2,
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("multi-root-null-2"))],
        commitments: [ethers.keccak256(ethers.toUtf8Bytes("multi-root-commit-2"))],
      });
      await expect(privacyPool.transact([tx2])).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TEST 4: Cross-chain round-trip
  // ═══════════════════════════════════════════════════════════════════

  describe("Cross-Chain Round-Trip", function () {
    it("Client shield → Hub receive → Hub unshield back to Client", async function () {
      const SHIELD_AMOUNT = ethers.parseUnits("100", 6);
      const UNSHIELD_AMOUNT = ethers.parseUnits("50", 6);

      // Step 1: Client-side shield
      await clientUsdc.mint(aliceAddress, SHIELD_AMOUNT);
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);

      const npk = validNpk("roundtrip-npk");
      const encBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("rt-enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("rt-enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("rt-enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("rt-key"));

      const clientTx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT, 0, 0, npk, encBundle, shieldKey, ethers.ZeroHash
      );
      const clientReceipt = await clientTx.wait();

      // Step 2: Relay to Hub — extract full MessageV2 from MessageSent(bytes) event
      const transmitterInterface = clientMessageTransmitter.interface;
      let encodedMessage: string | undefined;
      for (const log of clientReceipt!.logs) {
        try {
          const parsed = transmitterInterface.parseLog(log);
          if (parsed?.name === "MessageSent") {
            encodedMessage = parsed.args.message;
            break;
          }
        } catch { /* skip */ }
      }
      expect(encodedMessage).to.not.be.undefined;

      const hubPoolBefore = await hubUsdc.balanceOf(privacyPoolAddress);
      await hubHookRouter.connect(relayer).relayWithHook(encodedMessage, "0x");
      const hubPoolAfter = await hubUsdc.balanceOf(privacyPoolAddress);

      // Pool should have received SHIELD_AMOUNT minus shield fee
      const shieldFee = SHIELD_AMOUNT * 50n / 10000n;
      expect(hubPoolAfter - hubPoolBefore).to.equal(SHIELD_AMOUNT - shieldFee);

      // Step 3: Unshield back to Client via atomicCrossChainUnshield
      const root = await privacyPool.merkleRoot();
      const usdcAddr = await hubUsdc.getAddress();

      const npkBigInt = BigInt(privacyPoolAddress);
      const tokenId = BigInt(usdcAddr);
      const unshieldCommitHash = computeCommitmentHash(npkBigInt, tokenId, UNSHIELD_AMOUNT);

      const unshieldTxData = makeTransaction({
        merkleRoot: root,
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("roundtrip-null"))],
        commitments: [unshieldCommitHash],
        unshield: 1,
        unshieldPreimage: {
          npk: ethers.zeroPadValue(privacyPoolAddress, 32),
          token: { tokenType: 0, tokenAddress: usdcAddr, tokenSubID: 0 },
          value: UNSHIELD_AMOUNT,
        },
      });

      const unshieldTx = await privacyPool.atomicCrossChainUnshield(
        unshieldTxData, DOMAINS.client, bobAddress, ethers.ZeroHash, 0
      );
      const unshieldReceipt = await unshieldTx.wait();

      // Step 4: Extract MessageSent(bytes) from unshield tx and relay to Client
      const hubTransmitterInterface = hubMessageTransmitter.interface;
      let unshieldEncodedMessage: string | undefined;
      for (const log of unshieldReceipt!.logs) {
        try {
          const parsed = hubTransmitterInterface.parseLog(log);
          if (parsed?.name === "MessageSent") {
            unshieldEncodedMessage = parsed.args.message;
            break;
          }
        } catch { /* skip */ }
      }
      expect(unshieldEncodedMessage).to.not.be.undefined;

      const bobBefore = await clientUsdc.balanceOf(bobAddress);
      await clientHookRouter.connect(relayer).relayWithHook(unshieldEncodedMessage, "0x");
      const bobAfter = await clientUsdc.balanceOf(bobAddress);

      // Bob should receive the unshield amount on the client chain
      expect(bobAfter - bobBefore).to.equal(UNSHIELD_AMOUNT);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TEST 5: Batched transact with mixed operations
  // ═══════════════════════════════════════════════════════════════════

  describe("Batched Mixed Transact", function () {
    it("should process multiple transactions in single call", async function () {
      const root = await shieldAndGetRoot(alice, ethers.parseUnits("200", 6), "batch-mixed");

      // Transaction 1: Pure private transfer (no unshield)
      const tx1 = makeTransaction({
        merkleRoot: root,
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("batch-null-1"))],
        commitments: [
          ethers.keccak256(ethers.toUtf8Bytes("batch-commit-1a")),
          ethers.keccak256(ethers.toUtf8Bytes("batch-commit-1b")),
        ],
      });

      // Transaction 2: Another private transfer
      const tx2 = makeTransaction({
        merkleRoot: root,
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("batch-null-2"))],
        commitments: [
          ethers.keccak256(ethers.toUtf8Bytes("batch-commit-2a")),
        ],
      });

      const nextLeafBefore = await privacyPool.nextLeafIndex();
      await privacyPool.transact([tx1, tx2]);
      const nextLeafAfter = await privacyPool.nextLeafIndex();

      // 3 new commitments inserted (2 from tx1 + 1 from tx2)
      expect(nextLeafAfter - nextLeafBefore).to.equal(3);

      // Both nullifiers should be spent
      expect(await privacyPool.nullifiers(0, ethers.keccak256(ethers.toUtf8Bytes("batch-null-1")))).to.be.true;
      expect(await privacyPool.nullifiers(0, ethers.keccak256(ethers.toUtf8Bytes("batch-null-2")))).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TEST 6: Sequential shields preserve merkle root history
  // ═══════════════════════════════════════════════════════════════════

  describe("Merkle Root History Preservation", function () {
    it("all historical roots remain valid for proofs", async function () {
      const roots: string[] = [];

      // Perform 5 sequential shields, recording each root
      for (let i = 0; i < 5; i++) {
        const root = await shieldAndGetRoot(alice, ethers.parseUnits("5", 6), `history-${i}`);
        roots.push(root);
      }

      // All 5 roots should be in history
      for (let i = 0; i < roots.length; i++) {
        const isValid = await privacyPool.rootHistory(0, roots[i]);
        expect(isValid).to.be.true;
      }

      // Any of these roots can be used in a transact
      const tx = makeTransaction({
        merkleRoot: roots[0], // Use the oldest root
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("history-old-null"))],
        commitments: [ethers.keccak256(ethers.toUtf8Bytes("history-old-commit"))],
      });
      await expect(privacyPool.transact([tx])).to.not.be.reverted;
    });
  });
});
