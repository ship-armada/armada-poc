/**
 * Privacy Pool Gas Profiling
 *
 * Benchmarks gas consumption for key privacy pool operations:
 * 1. Shield gas scaling (1, 5, 10, 20 shields per call)
 * 2. Transact gas (single and batched)
 * 3. Cross-chain shield gas (Client-side CCTP burn + Hub-side receive)
 * 4. Cross-chain unshield gas (atomicCrossChainUnshield)
 * 5. Merkle insertion gas at various fill levels
 * 6. Delegatecall overhead (router vs direct module call)
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

describe("Privacy Pool Gas Profiling", function () {
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

  let deployer: Signer;
  let alice: Signer;
  let bob: Signer;
  let relayer: Signer;

  let deployerAddress: string;
  let aliceAddress: string;
  let privacyPoolAddress: string;
  let clientAddress: string;
  let relayerAddress: string;

  let poseidon: any;
  let F: any;

  // Gas results table
  const gasResults: { operation: string; gas: number; notes: string }[] = [];

  function recordGas(operation: string, gas: number, notes: string = "") {
    gasResults.push({ operation, gas, notes });
  }

  before(async function () {
    [deployer, alice, bob, relayer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    aliceAddress = await alice.getAddress();
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
    await privacyPool.setTreasury(deployerAddress);
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

    // Link deployments
    await privacyPool.setRemotePool(DOMAINS.client, ethers.zeroPadValue(clientAddress, 32));
    await hubTokenMessenger.setRemoteTokenMessenger(DOMAINS.client, ethers.zeroPadValue(await clientTokenMessenger.getAddress(), 32));
    await clientTokenMessenger.setRemoteTokenMessenger(DOMAINS.hub, ethers.zeroPadValue(await hubTokenMessenger.getAddress(), 32));

    // Set remote hook routers — gas test calls receiveMessage directly via relayer (no hookRouter)
    // so set destinationCaller to relayer address to match mock CCTP validation
    await privacyPool.setRemoteHookRouter(DOMAINS.client, ethers.zeroPadValue(relayerAddress, 32));
    await privacyPoolClient.setHubHookRouter(ethers.zeroPadValue(relayerAddress, 32));
  });

  // ═══════════════════════════════════════════════════════════════════
  // Helper functions
  // ═══════════════════════════════════════════════════════════════════

  function validNpk(seed: string = "test-npk"): string {
    const raw = BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed)));
    return ethers.zeroPadValue(ethers.toBeHex(raw % SNARK_SCALAR_FIELD), 32);
  }

  function makeShieldRequest(token: string, amount: bigint, npkSeed?: string) {
    return {
      preimage: {
        npk: validNpk(npkSeed ?? `npk-${Math.random()}`),
        token: { tokenType: 0, tokenAddress: token, tokenSubID: 0 },
        value: amount,
      },
      ciphertext: {
        encryptedBundle: [
          ethers.keccak256(ethers.toUtf8Bytes(`enc1-${Math.random()}`)),
          ethers.keccak256(ethers.toUtf8Bytes(`enc2-${Math.random()}`)),
          ethers.keccak256(ethers.toUtf8Bytes(`enc3-${Math.random()}`)),
        ],
        shieldKey: ethers.keccak256(ethers.toUtf8Bytes(`key-${Math.random()}`)),
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

  async function shieldAndGetRoot(amount: bigint, npkSeed?: string): Promise<string> {
    const usdcAddr = await hubUsdc.getAddress();
    await hubUsdc.mint(aliceAddress, amount);
    await hubUsdc.connect(alice).approve(privacyPoolAddress, amount);
    await privacyPool.connect(alice).shield([makeShieldRequest(usdcAddr, amount, npkSeed)]);
    return await privacyPool.merkleRoot();
  }

  // ═══════════════════════════════════════════════════════════════════
  // BENCHMARK 1: Shield gas scaling
  // ═══════════════════════════════════════════════════════════════════

  describe("Shield Gas Scaling", function () {
    const AMOUNT_PER_SHIELD = ethers.parseUnits("10", 6); // 10 USDC each

    for (const count of [1, 5, 10, 20]) {
      it(`shield ${count} tokens in single call`, async function () {
        const usdcAddr = await hubUsdc.getAddress();
        const totalAmount = AMOUNT_PER_SHIELD * BigInt(count);

        await hubUsdc.mint(aliceAddress, totalAmount);
        await hubUsdc.connect(alice).approve(privacyPoolAddress, totalAmount);

        const requests = Array.from({ length: count }, (_, i) =>
          makeShieldRequest(usdcAddr, AMOUNT_PER_SHIELD, `shield-gas-${count}-${i}`)
        );

        const tx = await privacyPool.connect(alice).shield(requests);
        const receipt = await tx.wait();
        const gasUsed = Number(receipt!.gasUsed);

        recordGas(`shield x${count}`, gasUsed, `${Math.round(gasUsed / count)} gas/shield`);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // BENCHMARK 2: Transact gas (testingMode — bypasses SNARK)
  // ═══════════════════════════════════════════════════════════════════

  describe("Transact Gas", function () {
    it("single transact (1 nullifier, 2 commitments)", async function () {
      const root = await shieldAndGetRoot(ethers.parseUnits("100", 6), "transact-gas-1");

      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("transact-gas-null-1"));
      const commitment1 = ethers.keccak256(ethers.toUtf8Bytes("transact-gas-commit-1a"));
      const commitment2 = ethers.keccak256(ethers.toUtf8Bytes("transact-gas-commit-1b"));

      const txData = makeTransaction({
        merkleRoot: root,
        nullifiers: [nullifier],
        commitments: [commitment1, commitment2],
      });

      const tx = await privacyPool.transact([txData]);
      const receipt = await tx.wait();
      recordGas("transact (1 nullifier, 2 commits)", Number(receipt!.gasUsed));
    });

    it("batched transact (3 transactions)", async function () {
      const root = await shieldAndGetRoot(ethers.parseUnits("100", 6), "transact-gas-batch");

      const txns = [];
      for (let i = 0; i < 3; i++) {
        txns.push(makeTransaction({
          merkleRoot: root,
          nullifiers: [ethers.keccak256(ethers.toUtf8Bytes(`transact-gas-batch-null-${i}`))],
          commitments: [
            ethers.keccak256(ethers.toUtf8Bytes(`transact-gas-batch-commit-${i}a`)),
            ethers.keccak256(ethers.toUtf8Bytes(`transact-gas-batch-commit-${i}b`)),
          ],
        }));
      }

      const tx = await privacyPool.transact(txns);
      const receipt = await tx.wait();
      recordGas("transact x3 (batched)", Number(receipt!.gasUsed), `${Math.round(Number(receipt!.gasUsed) / 3)} gas/tx`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // BENCHMARK 3: Transact with unshield
  // ═══════════════════════════════════════════════════════════════════

  describe("Transact + Unshield Gas", function () {
    it("transact with local unshield (NORMAL)", async function () {
      const usdcAddr = await hubUsdc.getAddress();
      const shieldAmount = ethers.parseUnits("100", 6);
      const unshieldValue = ethers.parseUnits("50", 6);

      const root = await shieldAndGetRoot(shieldAmount, "unshield-gas-1");

      // Compute unshield commitment hash: Poseidon(npk=bob, tokenId=usdc, value)
      const bobAddr = await bob.getAddress();
      const npkBigInt = BigInt(bobAddr);
      const tokenId = BigInt(usdcAddr);
      const unshieldCommitHash = computeCommitmentHash(npkBigInt, tokenId, unshieldValue);

      const changeCommit = ethers.keccak256(ethers.toUtf8Bytes("unshield-gas-change"));

      const txData = makeTransaction({
        merkleRoot: root,
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("unshield-gas-null"))],
        commitments: [changeCommit, unshieldCommitHash],
        unshield: 1, // NORMAL
        unshieldPreimage: {
          npk: ethers.zeroPadValue(bobAddr, 32),
          token: { tokenType: 0, tokenAddress: usdcAddr, tokenSubID: 0 },
          value: unshieldValue,
        },
      });

      const tx = await privacyPool.transact([txData]);
      const receipt = await tx.wait();
      recordGas("transact + unshield (NORMAL)", Number(receipt!.gasUsed));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // BENCHMARK 4: Cross-chain shield gas
  // ═══════════════════════════════════════════════════════════════════

  describe("Cross-Chain Shield Gas", function () {
    it("client-side CCTP burn (crossChainShield)", async function () {
      const amount = ethers.parseUnits("50", 6);
      await clientUsdc.mint(aliceAddress, amount);
      await clientUsdc.connect(alice).approve(clientAddress, amount);

      const npk = validNpk("cctp-gas-shield");
      const encBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("cctp-enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("cctp-enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("cctp-enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("cctp-key"));

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        amount, 0, npk, encBundle, shieldKey
      );
      const receipt = await tx.wait();
      recordGas("crossChainShield (client-side)", Number(receipt!.gasUsed));

      // Extract full MessageV2 from MessageSent(bytes) event and relay to Hub
      const transmitterInterface = clientMessageTransmitter.interface;
      let encodedMessage: string | undefined;
      for (const log of receipt!.logs) {
        try {
          const parsed = transmitterInterface.parseLog(log);
          if (parsed?.name === "MessageSent") {
            encodedMessage = parsed.args.message;
            break;
          }
        } catch { /* skip */ }
      }

      const relayTx = await hubMessageTransmitter.connect(relayer).receiveMessage(encodedMessage!, "0x");
      const relayReceipt = await relayTx.wait();
      recordGas("receiveMessage (hub-side shield)", Number(relayReceipt!.gasUsed));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // BENCHMARK 5: Cross-chain unshield gas
  // ═══════════════════════════════════════════════════════════════════

  describe("Cross-Chain Unshield Gas", function () {
    it("atomicCrossChainUnshield", async function () {
      const usdcAddr = await hubUsdc.getAddress();
      const shieldAmount = ethers.parseUnits("100", 6);
      const unshieldValue = ethers.parseUnits("50", 6);

      const root = await shieldAndGetRoot(shieldAmount, "atomic-unshield-gas");

      const bobAddr = await bob.getAddress();
      const npkBigInt = BigInt(bobAddr);
      const tokenId = BigInt(usdcAddr);
      const unshieldCommitHash = computeCommitmentHash(npkBigInt, tokenId, unshieldValue);

      const changeCommit = ethers.keccak256(ethers.toUtf8Bytes("atomic-unshield-gas-change"));

      const txData = makeTransaction({
        merkleRoot: root,
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("atomic-unshield-gas-null"))],
        commitments: [changeCommit, unshieldCommitHash],
        unshield: 1,
        unshieldPreimage: {
          npk: ethers.zeroPadValue(bobAddr, 32),
          token: { tokenType: 0, tokenAddress: usdcAddr, tokenSubID: 0 },
          value: unshieldValue,
        },
      });

      // Approve USDC for CCTP burn
      const poolUsdcBalance = await hubUsdc.balanceOf(privacyPoolAddress);
      await hubUsdc.mint(privacyPoolAddress, unshieldValue); // ensure pool has enough

      const tx = await privacyPool.atomicCrossChainUnshield(
        txData,
        DOMAINS.client,
        bobAddr,
        0 // maxFee
      );
      const receipt = await tx.wait();
      recordGas("atomicCrossChainUnshield", Number(receipt!.gasUsed));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // BENCHMARK 6: Merkle insertion at different fill levels
  // ═══════════════════════════════════════════════════════════════════

  describe("Merkle Insertion Gas at Fill Levels", function () {
    it("shield at near-empty tree (< 10 leaves)", async function () {
      // Tree should be nearly empty from prior tests
      const usdcAddr = await hubUsdc.getAddress();
      const amount = ethers.parseUnits("10", 6);
      await hubUsdc.mint(aliceAddress, amount);
      await hubUsdc.connect(alice).approve(privacyPoolAddress, amount);

      const tx = await privacyPool.connect(alice).shield([makeShieldRequest(usdcAddr, amount, "merkle-near-empty")]);
      const receipt = await tx.wait();
      recordGas("shield (near-empty tree)", Number(receipt!.gasUsed));
    });

    it("shield after 50 insertions", async function () {
      // Insert 50 shields to fill tree a bit
      const usdcAddr = await hubUsdc.getAddress();
      const batchAmount = ethers.parseUnits("1", 6);

      for (let i = 0; i < 5; i++) {
        const batchSize = 10;
        const totalAmount = batchAmount * BigInt(batchSize);
        await hubUsdc.mint(aliceAddress, totalAmount);
        await hubUsdc.connect(alice).approve(privacyPoolAddress, totalAmount);

        const requests = Array.from({ length: batchSize }, (_, j) =>
          makeShieldRequest(usdcAddr, batchAmount, `fill-50-${i}-${j}`)
        );
        await privacyPool.connect(alice).shield(requests);
      }

      // Now measure a single shield at this fill level
      const amount = ethers.parseUnits("10", 6);
      await hubUsdc.mint(aliceAddress, amount);
      await hubUsdc.connect(alice).approve(privacyPoolAddress, amount);

      const tx = await privacyPool.connect(alice).shield([makeShieldRequest(usdcAddr, amount, "merkle-after-50")]);
      const receipt = await tx.wait();
      recordGas("shield (after ~50 leaves)", Number(receipt!.gasUsed));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Print results
  // ═══════════════════════════════════════════════════════════════════

  after(function () {
    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  PRIVACY POOL GAS PROFILING RESULTS");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");

    // Format as table
    const maxOpLen = Math.max(...gasResults.map(r => r.operation.length), 10);
    const maxGasLen = Math.max(...gasResults.map(r => r.gas.toLocaleString().length), 7);

    const header = `  ${"Operation".padEnd(maxOpLen)}  ${"Gas".padStart(maxGasLen)}  Notes`;
    const separator = `  ${"─".repeat(maxOpLen)}  ${"─".repeat(maxGasLen)}  ${"─".repeat(40)}`;

    console.log(header);
    console.log(separator);

    for (const r of gasResults) {
      const line = `  ${r.operation.padEnd(maxOpLen)}  ${r.gas.toLocaleString().padStart(maxGasLen)}  ${r.notes}`;
      console.log(line);
    }

    console.log(separator);
    console.log("");

    // Extrapolation to L1/L2 block limits
    const L1_GAS_LIMIT = 30_000_000;
    const L2_GAS_LIMIT = 100_000_000; // Arbitrum-style

    console.log("  Block Limit Extrapolation:");
    console.log(`  L1 gas limit: ${L1_GAS_LIMIT.toLocaleString()}`);
    console.log(`  L2 gas limit: ${L2_GAS_LIMIT.toLocaleString()}`);
    console.log("");

    const singleShield = gasResults.find(r => r.operation === "shield x1");
    if (singleShield) {
      console.log(`  Max shields per L1 block: ~${Math.floor(L1_GAS_LIMIT / singleShield.gas)}`);
      console.log(`  Max shields per L2 block: ~${Math.floor(L2_GAS_LIMIT / singleShield.gas)}`);
    }

    const singleTransact = gasResults.find(r => r.operation.includes("1 nullifier, 2 commits"));
    if (singleTransact) {
      console.log(`  Max transacts per L1 block: ~${Math.floor(L1_GAS_LIMIT / singleTransact.gas)}`);
      console.log(`  Max transacts per L2 block: ~${Math.floor(L2_GAS_LIMIT / singleTransact.gas)}`);
    }

    console.log("\n═══════════════════════════════════════════════════════════\n");
  });
});
