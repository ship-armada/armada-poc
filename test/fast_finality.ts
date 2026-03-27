// ABOUTME: Tests for CCTP V2 fast finality (confirmed-level) message handling.
// ABOUTME: Covers CCTPHookRouter dispatch, per-transaction finality choice, admin threshold config, and fee accounting.

import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import * as fs from "fs";
import * as path from "path";
// @ts-ignore - circomlibjs doesn't have types
import { buildPoseidon } from "circomlibjs";

// Load Poseidon bytecode for deployment
const poseidonBytecode = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "lib", "poseidon_bytecode.json"), "utf-8")
);

// Import artifact loading for verification keys
import {
  loadVerificationKeys,
  TESTING_ARTIFACT_CONFIGS,
} from "../lib/artifacts";

// CCTP Domain IDs
const DOMAINS = {
  hub: 100,
  client: 101,
};

// CCTP Finality thresholds (matching CCTPFinality library in ICCTPV2.sol)
const FINALITY = {
  FAST: 1000,
  STANDARD: 2000,
};

describe("CCTP V2 Fast Finality", function () {
  // Contracts
  let hubUsdc: Contract;
  let hubTokenMessenger: Contract;
  let hubMessageTransmitter: Contract;
  let hubHookRouter: Contract;
  let privacyPool: Contract;
  let merkleModule: Contract;
  let verifierModule: Contract;
  let shieldModule: Contract;
  let transactModule: Contract;

  let clientUsdc: Contract;
  let clientTokenMessenger: Contract;
  let clientMessageTransmitter: Contract;
  let clientHookRouter: Contract;
  let privacyPoolClient: Contract;

  // Signers
  let deployer: Signer;
  let alice: Signer;
  let bob: Signer;
  let relayer: Signer;

  // Addresses
  let deployerAddress: string;
  let aliceAddress: string;
  let bobAddress: string;
  let relayerAddress: string;
  let privacyPoolAddress: string;
  let clientAddress: string;
  let treasuryAddress: string;

  before(async function () {
    [deployer, alice, bob, relayer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    aliceAddress = await alice.getAddress();
    bobAddress = await bob.getAddress();
    relayerAddress = await relayer.getAddress();

    // Configure treasury as deployer
    treasuryAddress = deployerAddress;

    await deployHubChain();
    await deployClientChain();
    await linkDeployments();

    // Configure shield fee: 50 bps (0.50%)
    await privacyPool.setShieldFee(50); // 0.50%
  });

  async function deployHubChain() {
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    hubUsdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await hubUsdc.waitForDeployment();

    const MockMessageTransmitterV2 = await ethers.getContractFactory("MockMessageTransmitterV2");
    hubMessageTransmitter = await MockMessageTransmitterV2.deploy(DOMAINS.hub, relayerAddress);
    await hubMessageTransmitter.waitForDeployment();

    const MockTokenMessengerV2 = await ethers.getContractFactory("MockTokenMessengerV2");
    hubTokenMessenger = await MockTokenMessengerV2.deploy(
      await hubMessageTransmitter.getAddress(),
      await hubUsdc.getAddress(),
      DOMAINS.hub
    );
    await hubTokenMessenger.waitForDeployment();

    await hubMessageTransmitter.setTokenMessenger(await hubTokenMessenger.getAddress());
    await hubUsdc.addMinter(await hubTokenMessenger.getAddress());

    // Deploy Poseidon libraries
    const poseidonT3Tx = await deployer.sendTransaction({ data: poseidonBytecode.PoseidonT3.bytecode });
    const poseidonT3Receipt = await poseidonT3Tx.wait();
    const poseidonT3Address = poseidonT3Receipt!.contractAddress!;

    const poseidonT4Tx = await deployer.sendTransaction({ data: poseidonBytecode.PoseidonT4.bytecode });
    const poseidonT4Receipt = await poseidonT4Tx.wait();
    const poseidonT4Address = poseidonT4Receipt!.contractAddress!;

    // Deploy modules
    const MerkleModule = await ethers.getContractFactory("MerkleModule", {
      libraries: { PoseidonT3: poseidonT3Address },
    });
    merkleModule = await MerkleModule.deploy();
    await merkleModule.waitForDeployment();

    const VerifierModule = await ethers.getContractFactory("VerifierModule");
    verifierModule = await VerifierModule.deploy();
    await verifierModule.waitForDeployment();

    const ShieldModule = await ethers.getContractFactory("ShieldModule", {
      libraries: { PoseidonT4: poseidonT4Address },
    });
    shieldModule = await ShieldModule.deploy();
    await shieldModule.waitForDeployment();

    const TransactModule = await ethers.getContractFactory("TransactModule", {
      libraries: { PoseidonT4: poseidonT4Address },
    });
    transactModule = await TransactModule.deploy();
    await transactModule.waitForDeployment();

    const PrivacyPool = await ethers.getContractFactory("PrivacyPool");
    privacyPool = await PrivacyPool.deploy();
    await privacyPool.waitForDeployment();
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
      deployerAddress,
      treasuryAddress
    );

    const CCTPHookRouter = await ethers.getContractFactory("CCTPHookRouter");
    hubHookRouter = await CCTPHookRouter.deploy(await hubMessageTransmitter.getAddress());
    await hubHookRouter.waitForDeployment();

    // Load verification keys
    await loadVerificationKeys(privacyPool, TESTING_ARTIFACT_CONFIGS, false);
  }

  async function deployClientChain() {
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    clientUsdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await clientUsdc.waitForDeployment();

    const MockMessageTransmitterV2 = await ethers.getContractFactory("MockMessageTransmitterV2");
    clientMessageTransmitter = await MockMessageTransmitterV2.deploy(DOMAINS.client, relayerAddress);
    await clientMessageTransmitter.waitForDeployment();

    const MockTokenMessengerV2 = await ethers.getContractFactory("MockTokenMessengerV2");
    clientTokenMessenger = await MockTokenMessengerV2.deploy(
      await clientMessageTransmitter.getAddress(),
      await clientUsdc.getAddress(),
      DOMAINS.client
    );
    await clientTokenMessenger.waitForDeployment();

    await clientMessageTransmitter.setTokenMessenger(await clientTokenMessenger.getAddress());
    await clientUsdc.addMinter(await clientTokenMessenger.getAddress());

    const PrivacyPoolClient = await ethers.getContractFactory("PrivacyPoolClient");
    privacyPoolClient = await PrivacyPoolClient.deploy();
    await privacyPoolClient.waitForDeployment();
    clientAddress = await privacyPoolClient.getAddress();

    await privacyPoolClient.initialize(
      await clientTokenMessenger.getAddress(),
      await clientMessageTransmitter.getAddress(),
      await clientUsdc.getAddress(),
      DOMAINS.client,
      DOMAINS.hub,
      ethers.ZeroHash,
      deployerAddress
    );

    const CCTPHookRouter = await ethers.getContractFactory("CCTPHookRouter");
    clientHookRouter = await CCTPHookRouter.deploy(await clientMessageTransmitter.getAddress());
    await clientHookRouter.waitForDeployment();
  }

  async function linkDeployments() {
    const hubPoolBytes32 = ethers.zeroPadValue(privacyPoolAddress, 32);
    const clientBytes32 = ethers.zeroPadValue(clientAddress, 32);

    await privacyPool.setRemotePool(DOMAINS.client, clientBytes32);
    await privacyPoolClient.setHubPool(DOMAINS.hub, hubPoolBytes32);

    const hubTmBytes32 = ethers.zeroPadValue(await hubTokenMessenger.getAddress(), 32);
    const clientTmBytes32 = ethers.zeroPadValue(await clientTokenMessenger.getAddress(), 32);

    await hubTokenMessenger.setRemoteTokenMessenger(DOMAINS.client, clientTmBytes32);
    await clientTokenMessenger.setRemoteTokenMessenger(DOMAINS.hub, hubTmBytes32);

    await privacyPool.setHookRouter(await hubHookRouter.getAddress());
    await privacyPoolClient.setHookRouter(await clientHookRouter.getAddress());

    await hubMessageTransmitter.connect(relayer).setRelayer(await hubHookRouter.getAddress());
    await clientMessageTransmitter.connect(relayer).setRelayer(await clientHookRouter.getAddress());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER: Extract encoded CCTP message from a transaction receipt
  // ═══════════════════════════════════════════════════════════════════════════

  function extractMessageSent(receipt: any, transmitterContract: Contract): string {
    const transmitterInterface = transmitterContract.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = transmitterInterface.parseLog(log);
        if (parsed?.name === "MessageSent") {
          return parsed.args.message;
        }
      } catch {
        // Not from this contract
      }
    }
    throw new Error("MessageSent event not found in receipt");
  }

  // Helper: create valid shield parameters
  function makeShieldParams(seed: string) {
    const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const rawNpk = BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed)));
    const validNpk = rawNpk % SNARK_SCALAR_FIELD;
    return {
      npk: ethers.zeroPadValue(ethers.toBeHex(validNpk), 32),
      encryptedBundle: [
        ethers.keccak256(ethers.toUtf8Bytes(seed + "-enc1")),
        ethers.keccak256(ethers.toUtf8Bytes(seed + "-enc2")),
        ethers.keccak256(ethers.toUtf8Bytes(seed + "-enc3")),
      ] as [string, string, string],
      shieldKey: ethers.keccak256(ethers.toUtf8Bytes(seed + "-key")),
    };
  }

  // Helper: parse minFinalityThreshold from a CCTP MessageV2 envelope
  function parseMinFinality(encodedMessage: string): number {
    const msgHex = encodedMessage.startsWith("0x") ? encodedMessage.slice(2) : encodedMessage;
    // Offset 140 (4 bytes) = minFinalityThreshold in MessageV2 envelope
    const minFinalityHex = msgHex.slice(280, 288); // offset 140 * 2 = 280, 4 bytes = 8 hex chars
    return parseInt(minFinalityHex, 16);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN CONTROLS (defaultFinalityThreshold only — no admin toggle for fast mode)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Admin Controls", function () {
    it("should default defaultFinalityThreshold to 0 (interpreted as STANDARD)", async function () {
      expect(await privacyPool.defaultFinalityThreshold()).to.equal(0);
      expect(await privacyPoolClient.defaultFinalityThreshold()).to.equal(0);
    });

    it("should allow owner to set default finality threshold to FAST on PrivacyPoolClient", async function () {
      const tx = await privacyPoolClient.setDefaultFinalityThreshold(FINALITY.FAST);
      const receipt = await tx.wait();

      const event = receipt?.logs.find((log: any) => {
        try {
          return privacyPoolClient.interface.parseLog(log)?.name === "DefaultFinalityThresholdSet";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
      expect(await privacyPoolClient.defaultFinalityThreshold()).to.equal(FINALITY.FAST);

      // Reset
      await privacyPoolClient.setDefaultFinalityThreshold(FINALITY.STANDARD);
    });

    it("should allow owner to set default finality threshold on PrivacyPool (Hub)", async function () {
      await privacyPool.setDefaultFinalityThreshold(FINALITY.FAST);
      expect(await privacyPool.defaultFinalityThreshold()).to.equal(FINALITY.FAST);

      // Reset
      await privacyPool.setDefaultFinalityThreshold(FINALITY.STANDARD);
    });

    it("should reject invalid finality threshold values on PrivacyPoolClient", async function () {
      await expect(
        privacyPoolClient.setDefaultFinalityThreshold(500)
      ).to.be.revertedWith("PrivacyPoolClient: Invalid threshold");

      await expect(
        privacyPoolClient.setDefaultFinalityThreshold(0)
      ).to.be.revertedWith("PrivacyPoolClient: Invalid threshold");

      await expect(
        privacyPoolClient.setDefaultFinalityThreshold(3000)
      ).to.be.revertedWith("PrivacyPoolClient: Invalid threshold");
    });

    it("should reject non-owner setting finality threshold on PrivacyPoolClient", async function () {
      await expect(
        privacyPoolClient.connect(alice).setDefaultFinalityThreshold(FINALITY.FAST)
      ).to.be.revertedWith("PrivacyPoolClient: Only owner");
    });

    it("should reject non-owner setting finality threshold on PrivacyPool", async function () {
      await expect(
        privacyPool.connect(alice).setDefaultFinalityThreshold(FINALITY.FAST)
      ).to.be.revertedWith("PrivacyPool: Only owner");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PER-TRANSACTION FINALITY CHOICE ON crossChainShield
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Per-Transaction Finality Choice", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("50", 6); // 50 USDC

    beforeEach(async function () {
      await clientUsdc.mint(aliceAddress, SHIELD_AMOUNT);
    });

    it("should send with FAST finality when user requests it", async function () {
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("per-tx-fast");

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,                    // maxFee
        FINALITY.FAST,        // minFinalityThreshold — user explicitly picks FAST
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      const minFinality = parseMinFinality(encodedMessage);
      expect(minFinality).to.equal(FINALITY.FAST);
    });

    it("should send with STANDARD finality when user requests it", async function () {
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("per-tx-standard");

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,
        FINALITY.STANDARD,   // user explicitly picks STANDARD
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      const minFinality = parseMinFinality(encodedMessage);
      expect(minFinality).to.equal(FINALITY.STANDARD);
    });

    it("should fall back to contract default when user passes 0", async function () {
      // Set contract default to FAST
      await privacyPoolClient.setDefaultFinalityThreshold(FINALITY.FAST);

      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("per-tx-default-fast");

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,
        0,                    // 0 = use contract default
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      const minFinality = parseMinFinality(encodedMessage);
      expect(minFinality).to.equal(FINALITY.FAST);

      // Reset
      await privacyPoolClient.setDefaultFinalityThreshold(FINALITY.STANDARD);
    });

    it("should fall back to STANDARD when user passes 0 and no default set", async function () {
      // Deploy a fresh client with no default set (defaultFinalityThreshold = 0)
      const PrivacyPoolClient = await ethers.getContractFactory("PrivacyPoolClient");
      const freshClient = await PrivacyPoolClient.deploy();
      await freshClient.waitForDeployment();
      const freshClientAddress = await freshClient.getAddress();

      await freshClient.initialize(
        await clientTokenMessenger.getAddress(),
        await clientMessageTransmitter.getAddress(),
        await clientUsdc.getAddress(),
        DOMAINS.client,
        DOMAINS.hub,
        ethers.zeroPadValue(privacyPoolAddress, 32),
        deployerAddress
      );
      await freshClient.setHookRouter(await clientHookRouter.getAddress());

      await clientUsdc.mint(aliceAddress, SHIELD_AMOUNT);
      await clientUsdc.connect(alice).approve(freshClientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("per-tx-default-standard");

      const tx = await freshClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,
        0,                    // 0, and defaultFinalityThreshold is also 0 → STANDARD
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      const minFinality = parseMinFinality(encodedMessage);
      expect(minFinality).to.equal(FINALITY.STANDARD);
    });

    it("should reject invalid finality threshold from user (e.g. 500)", async function () {
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("per-tx-invalid");

      await expect(
        privacyPoolClient.connect(alice).crossChainShield(
          SHIELD_AMOUNT,
          0,
          500,                // invalid — not FAST or STANDARD
          params.npk,
          params.encryptedBundle,
          params.shieldKey,
          ethers.ZeroHash
        ,
        ethers.ZeroAddress)
      ).to.be.revertedWith("PrivacyPoolClient: Invalid finality threshold");
    });

    it("should reject invalid finality threshold from user (e.g. 1500)", async function () {
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("per-tx-invalid-1500");

      await expect(
        privacyPoolClient.connect(alice).crossChainShield(
          SHIELD_AMOUNT,
          0,
          1500,               // invalid — between FAST and STANDARD
          params.npk,
          params.encryptedBundle,
          params.shieldKey,
          ethers.ZeroHash
        ,
        ethers.ZeroAddress)
      ).to.be.revertedWith("PrivacyPoolClient: Invalid finality threshold");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CROSS-CHAIN SHIELD WITH FAST FINALITY (end-to-end)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Cross-Chain Shield with Fast Finality", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("50", 6); // 50 USDC

    beforeEach(async function () {
      await clientUsdc.mint(aliceAddress, SHIELD_AMOUNT);
    });

    it("should accept fast finality shield on Hub (no admin toggle needed)", async function () {
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("fast-accept-test");

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,                    // no CCTP fee
        FINALITY.FAST,        // user picks FAST
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      const merkleRootBefore = await privacyPool.merkleRoot();

      // Relay should succeed — Hub always accepts fast finality
      await hubHookRouter.connect(relayer).relayWithHook(encodedMessage, "0x");

      // Merkle root should change (commitment inserted)
      const merkleRootAfter = await privacyPool.merkleRoot();
      expect(merkleRootAfter).to.not.equal(merkleRootBefore);
    });

    it("should correctly account for fees in fast finality shield", async function () {
      const MAX_FEE = ethers.parseUnits("1", 6); // 1 USDC CCTP fee

      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("fast-fee-test");

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        MAX_FEE,
        FINALITY.FAST,        // user picks FAST
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      const poolBalanceBefore = await hubUsdc.balanceOf(privacyPoolAddress);
      const treasuryBalanceBefore = await hubUsdc.balanceOf(treasuryAddress);

      await hubHookRouter.connect(relayer).relayWithHook(encodedMessage, "0x");

      // In mock: feeExecuted = maxFee, so actual minted = SHIELD_AMOUNT - MAX_FEE = 49 USDC
      const amountAfterCCTP = SHIELD_AMOUNT - MAX_FEE;
      const shieldFeeAmount = amountAfterCCTP * 50n / 10000n; // 0.50% shield fee
      const poolNetReceived = amountAfterCCTP - shieldFeeAmount;

      const poolBalanceAfter = await hubUsdc.balanceOf(privacyPoolAddress);
      expect(poolBalanceAfter - poolBalanceBefore).to.equal(poolNetReceived);

      const treasuryBalanceAfter = await hubUsdc.balanceOf(treasuryAddress);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(shieldFeeAmount);
    });

    it("should accept standard finality shield alongside fast", async function () {
      // Send with STANDARD — should use handleReceiveFinalizedMessage path
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("standard-alongside-fast");

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,
        FINALITY.STANDARD,
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      const merkleRootBefore = await privacyPool.merkleRoot();

      // Standard finality relay should work
      await hubHookRouter.connect(relayer).relayWithHook(encodedMessage, "0x");

      const merkleRootAfter = await privacyPool.merkleRoot();
      expect(merkleRootAfter).to.not.equal(merkleRootBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CROSS-CHAIN UNSHIELD WITH FAST FINALITY
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Cross-Chain Unshield with Fast Finality", function () {
    it("should accept fast finality unshield on PrivacyPoolClient (always enabled)", async function () {
      // The Client always accepts both finalized and unfinalized messages.
      // We verify by calling handleReceiveUnfinalizedMessage from an authorized caller.
      // Since we can't easily construct a valid BurnMessageV2, we just verify
      // the authorization + finality checks pass (the handler will revert on
      // malformed message body, which proves it got past auth checks).
      const tokenMessengerAddr = await privacyPoolClient.tokenMessenger();
      const tokenMessengerSigner = await ethers.getImpersonatedSigner(tokenMessengerAddr);
      await ethers.provider.send("hardhat_setBalance", [tokenMessengerAddr, "0xDE0B6B3A7640000"]);

      // Should not revert with "Unauthorized caller" or "Finality below minimum"
      // — will revert on message body decode instead (proving auth passed)
      await expect(
        privacyPoolClient.connect(tokenMessengerSigner).handleReceiveUnfinalizedMessage(
          DOMAINS.hub,
          ethers.zeroPadValue(await hubTokenMessenger.getAddress(), 32),
          FINALITY.FAST,
          ethers.ZeroHash  // malformed body — will fail on decode, not auth
        )
      ).to.not.be.revertedWith("PrivacyPoolClient: Unauthorized caller");
    });

    it("should accept fast finality messages on Hub PrivacyPool (always enabled)", async function () {
      const tokenMessengerAddr = await privacyPool.tokenMessenger();
      const tokenMessengerSigner = await ethers.getImpersonatedSigner(tokenMessengerAddr);
      await ethers.provider.send("hardhat_setBalance", [tokenMessengerAddr, "0xDE0B6B3A7640000"]);

      // Should not revert with auth or finality errors
      await expect(
        privacyPool.connect(tokenMessengerSigner).handleReceiveUnfinalizedMessage(
          DOMAINS.client,
          ethers.zeroPadValue(await clientTokenMessenger.getAddress(), 32),
          FINALITY.FAST,
          ethers.ZeroHash
        )
      ).to.not.be.revertedWith("PrivacyPool: Unauthorized caller");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // HOOKROUTER DISPATCH TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("CCTPHookRouter Finality Dispatch", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("50", 6);

    beforeEach(async function () {
      await clientUsdc.mint(aliceAddress, SHIELD_AMOUNT);
    });

    it("should dispatch to handleReceiveFinalizedMessage for standard finality", async function () {
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("hookrouter-standard");

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,
        FINALITY.STANDARD,
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      // Should succeed via handleReceiveFinalizedMessage (standard path)
      await expect(
        hubHookRouter.connect(relayer).relayWithHook(encodedMessage, "0x")
      ).to.not.be.reverted;
    });

    it("should dispatch to handleReceiveUnfinalizedMessage for fast finality and succeed", async function () {
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("hookrouter-fast");

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,
        FINALITY.FAST,
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      // Should succeed — Hub always accepts fast finality messages
      await expect(
        hubHookRouter.connect(relayer).relayWithHook(encodedMessage, "0x")
      ).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURABLE OUTBOUND FINALITY TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Configurable Outbound Finality", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("50", 6);

    it("should use STANDARD finality by default (threshold=0)", async function () {
      // defaultFinalityThreshold may be 0 (initial) or STANDARD (2000) — both mean standard
      const threshold = await privacyPoolClient.defaultFinalityThreshold();
      expect(threshold === 0n || threshold === BigInt(FINALITY.STANDARD)).to.be.true;

      await clientUsdc.mint(aliceAddress, SHIELD_AMOUNT);
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("outbound-default");

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,
        0,                    // user passes 0 → use contract default → STANDARD
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      const minFinality = parseMinFinality(encodedMessage);
      expect(minFinality).to.equal(FINALITY.STANDARD);
    });

    it("should use FAST finality when contract default is configured", async function () {
      await privacyPoolClient.setDefaultFinalityThreshold(FINALITY.FAST);

      await clientUsdc.mint(aliceAddress, SHIELD_AMOUNT);
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("outbound-fast");

      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,
        0,                    // user passes 0 → uses contract default → FAST
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      const minFinality = parseMinFinality(encodedMessage);
      expect(minFinality).to.equal(FINALITY.FAST);

      // Reset
      await privacyPoolClient.setDefaultFinalityThreshold(FINALITY.STANDARD);
    });

    it("user-specified finality overrides contract default", async function () {
      // Set contract default to STANDARD
      await privacyPoolClient.setDefaultFinalityThreshold(FINALITY.STANDARD);

      await clientUsdc.mint(aliceAddress, SHIELD_AMOUNT);
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);
      const params = makeShieldParams("outbound-override");

      // User explicitly requests FAST, overriding the STANDARD default
      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,
        FINALITY.FAST,        // user overrides contract default
        params.npk,
        params.encryptedBundle,
        params.shieldKey,
        ethers.ZeroHash
      ,
      ethers.ZeroAddress);
      const receipt = await tx.wait();
      const encodedMessage = extractMessageSent(receipt, clientMessageTransmitter);

      const minFinality = parseMinFinality(encodedMessage);
      expect(minFinality).to.equal(FINALITY.FAST);
    });
  });
});
