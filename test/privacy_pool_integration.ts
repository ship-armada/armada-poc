/**
 * Privacy Pool Integration Tests
 *
 * Tests for the modular privacy pool architecture:
 *   - Hub: PrivacyPool + Modules (Merkle, Verifier, Shield, Transact)
 *   - Client: PrivacyPoolClient
 *
 * Tests cover:
 *   1. Local shield on Hub
 *   2. Local transact on Hub
 *   3. Cross-chain shield (Client -> Hub)
 *   4. Cross-chain unshield (Hub -> Client)
 */

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

describe("Privacy Pool Integration", function () {
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

    // Deploy Hub chain contracts
    await deployHubChain();

    // Deploy Client chain contracts
    await deployClientChain();

    // Link deployments
    await linkDeployments();

    // Configure shield fee: 50 bps (0.50%) to deployer as treasury
    treasuryAddress = deployerAddress;
    await privacyPool.setTreasury(treasuryAddress);
    await privacyPool.setShieldFee(50);
  });

  async function deployHubChain() {
    console.log("Deploying Hub chain...");

    // Deploy MockUSDCV2
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    hubUsdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await hubUsdc.waitForDeployment();

    // Deploy MockMessageTransmitterV2
    const MockMessageTransmitterV2 = await ethers.getContractFactory("MockMessageTransmitterV2");
    hubMessageTransmitter = await MockMessageTransmitterV2.deploy(DOMAINS.hub, relayerAddress);
    await hubMessageTransmitter.waitForDeployment();

    // Deploy MockTokenMessengerV2
    const MockTokenMessengerV2 = await ethers.getContractFactory("MockTokenMessengerV2");
    hubTokenMessenger = await MockTokenMessengerV2.deploy(
      await hubMessageTransmitter.getAddress(),
      await hubUsdc.getAddress(),
      DOMAINS.hub
    );
    await hubTokenMessenger.waitForDeployment();

    // Link CCTP contracts
    await hubMessageTransmitter.setTokenMessenger(await hubTokenMessenger.getAddress());
    await hubUsdc.addMinter(await hubTokenMessenger.getAddress());

    // Deploy PoseidonT3 library (required by MerkleModule)
    const poseidonT3Tx = await deployer.sendTransaction({
      data: poseidonBytecode.PoseidonT3.bytecode,
    });
    const poseidonT3Receipt = await poseidonT3Tx.wait();
    const poseidonT3Address = poseidonT3Receipt!.contractAddress!;

    // Deploy PoseidonT4 library (required by ShieldModule, TransactModule)
    const poseidonT4Tx = await deployer.sendTransaction({
      data: poseidonBytecode.PoseidonT4.bytecode,
    });
    const poseidonT4Receipt = await poseidonT4Tx.wait();
    const poseidonT4Address = poseidonT4Receipt!.contractAddress!;

    // Deploy modules with library linking
    const MerkleModule = await ethers.getContractFactory("MerkleModule", {
      libraries: {
        PoseidonT3: poseidonT3Address,
      },
    });
    merkleModule = await MerkleModule.deploy();
    await merkleModule.waitForDeployment();

    const VerifierModule = await ethers.getContractFactory("VerifierModule");
    verifierModule = await VerifierModule.deploy();
    await verifierModule.waitForDeployment();

    const ShieldModule = await ethers.getContractFactory("ShieldModule", {
      libraries: {
        PoseidonT4: poseidonT4Address,
      },
    });
    shieldModule = await ShieldModule.deploy();
    await shieldModule.waitForDeployment();

    const TransactModule = await ethers.getContractFactory("TransactModule", {
      libraries: {
        PoseidonT4: poseidonT4Address,
      },
    });
    transactModule = await TransactModule.deploy();
    await transactModule.waitForDeployment();

    // Deploy PrivacyPool router
    const PrivacyPool = await ethers.getContractFactory("PrivacyPool");
    privacyPool = await PrivacyPool.deploy();
    await privacyPool.waitForDeployment();
    privacyPoolAddress = await privacyPool.getAddress();

    // Initialize PrivacyPool
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

    // Deploy CCTPHookRouter for hub
    const CCTPHookRouter = await ethers.getContractFactory("CCTPHookRouter");
    hubHookRouter = await CCTPHookRouter.deploy(await hubMessageTransmitter.getAddress());
    await hubHookRouter.waitForDeployment();

    // Load verification keys for SNARK proof verification
    console.log("  Loading verification keys...");
    await loadVerificationKeys(privacyPool, TESTING_ARTIFACT_CONFIGS, false);

    console.log("  PrivacyPool:", privacyPoolAddress);
    console.log("  HubHookRouter:", await hubHookRouter.getAddress());
  }

  async function deployClientChain() {
    console.log("Deploying Client chain...");

    // Deploy MockUSDCV2
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    clientUsdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await clientUsdc.waitForDeployment();

    // Deploy MockMessageTransmitterV2
    const MockMessageTransmitterV2 = await ethers.getContractFactory("MockMessageTransmitterV2");
    clientMessageTransmitter = await MockMessageTransmitterV2.deploy(DOMAINS.client, relayerAddress);
    await clientMessageTransmitter.waitForDeployment();

    // Deploy MockTokenMessengerV2
    const MockTokenMessengerV2 = await ethers.getContractFactory("MockTokenMessengerV2");
    clientTokenMessenger = await MockTokenMessengerV2.deploy(
      await clientMessageTransmitter.getAddress(),
      await clientUsdc.getAddress(),
      DOMAINS.client
    );
    await clientTokenMessenger.waitForDeployment();

    // Link CCTP contracts
    await clientMessageTransmitter.setTokenMessenger(await clientTokenMessenger.getAddress());
    await clientUsdc.addMinter(await clientTokenMessenger.getAddress());

    // Deploy PrivacyPoolClient
    const PrivacyPoolClient = await ethers.getContractFactory("PrivacyPoolClient");
    privacyPoolClient = await PrivacyPoolClient.deploy();
    await privacyPoolClient.waitForDeployment();
    clientAddress = await privacyPoolClient.getAddress();

    // Initialize with zero hub address for now (will link later)
    await privacyPoolClient.initialize(
      await clientTokenMessenger.getAddress(),
      await clientMessageTransmitter.getAddress(),
      await clientUsdc.getAddress(),
      DOMAINS.client,
      DOMAINS.hub,
      ethers.ZeroHash, // Will be set in linkDeployments
      deployerAddress
    );

    // Deploy CCTPHookRouter for client
    const CCTPHookRouter = await ethers.getContractFactory("CCTPHookRouter");
    clientHookRouter = await CCTPHookRouter.deploy(await clientMessageTransmitter.getAddress());
    await clientHookRouter.waitForDeployment();

    console.log("  PrivacyPoolClient:", clientAddress);
    console.log("  ClientHookRouter:", await clientHookRouter.getAddress());
  }

  async function linkDeployments() {
    console.log("Linking deployments...");

    const hubPoolBytes32 = ethers.zeroPadValue(privacyPoolAddress, 32);
    const clientBytes32 = ethers.zeroPadValue(clientAddress, 32);

    // Set remote pool on Hub
    await privacyPool.setRemotePool(DOMAINS.client, clientBytes32);

    // Set hub pool on Client
    await privacyPoolClient.setHubPool(DOMAINS.hub, hubPoolBytes32);

    // Configure CCTP TokenMessenger remotes
    const hubTmBytes32 = ethers.zeroPadValue(await hubTokenMessenger.getAddress(), 32);
    const clientTmBytes32 = ethers.zeroPadValue(await clientTokenMessenger.getAddress(), 32);

    await hubTokenMessenger.setRemoteTokenMessenger(DOMAINS.client, clientTmBytes32);
    await clientTokenMessenger.setRemoteTokenMessenger(DOMAINS.hub, hubTmBytes32);

    // Set hookRouter on PrivacyPool and PrivacyPoolClient
    await privacyPool.setHookRouter(await hubHookRouter.getAddress());
    await privacyPoolClient.setHookRouter(await clientHookRouter.getAddress());

    // Set mock MessageTransmitter relayer to hookRouter
    // (so hookRouter can call receiveMessage on mock)
    // setRelayer() requires msg.sender == current relayer
    await hubMessageTransmitter.connect(relayer).setRelayer(await hubHookRouter.getAddress());
    await clientMessageTransmitter.connect(relayer).setRelayer(await clientHookRouter.getAddress());

    console.log("  Linking complete");
  }

  describe("Local Hub Operations", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("100", 6); // 100 USDC

    beforeEach(async function () {
      // Mint USDC to Alice
      await hubUsdc.mint(aliceAddress, SHIELD_AMOUNT * 2n);
    });

    it("should shield tokens locally", async function () {
      // Approve PrivacyPool to spend USDC
      await hubUsdc.connect(alice).approve(privacyPoolAddress, SHIELD_AMOUNT);

      // Create shield request with correct structure:
      // ShieldRequest { preimage: CommitmentPreimage, ciphertext: ShieldCiphertext }
      // CommitmentPreimage { npk: bytes32, token: TokenData, value: uint120 }
      // TokenData { tokenType: TokenType, tokenAddress: address, tokenSubID: uint256 }
      // ShieldCiphertext { encryptedBundle: bytes32[3], shieldKey: bytes32 }

      // npk must be < SNARK_SCALAR_FIELD (21888242871839275222246405745257275088548364400416034343698204186575808495617)
      // Use a simple value that's definitely in range
      const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      const rawNpk = BigInt(ethers.keccak256(ethers.toUtf8Bytes("alice-npk")));
      const validNpk = rawNpk % SNARK_SCALAR_FIELD;
      const npk = ethers.zeroPadValue(ethers.toBeHex(validNpk), 32);

      const encryptedBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("shield-key"));

      const shieldRequest = {
        preimage: {
          npk: npk,
          token: {
            tokenType: 0, // ERC20
            tokenAddress: await hubUsdc.getAddress(),
            tokenSubID: 0,
          },
          value: SHIELD_AMOUNT,
        },
        ciphertext: {
          encryptedBundle: encryptedBundle,
          shieldKey: shieldKey,
        },
      };

      // Execute shield
      const treasuryBalanceBefore = await hubUsdc.balanceOf(treasuryAddress);
      const tx = await privacyPool.connect(alice).shield([shieldRequest]);
      await tx.wait();

      // 50 bps fee: base = 100 - (100 * 50 / 10000) = 99.50 USDC, fee = 0.50 USDC
      const EXPECTED_FEE = SHIELD_AMOUNT * 50n / 10000n; // 500000 (0.50 USDC)
      const EXPECTED_BASE = SHIELD_AMOUNT - EXPECTED_FEE;  // 99500000 (99.50 USDC)

      // Verify pool received base amount
      const poolBalance = await hubUsdc.balanceOf(privacyPoolAddress);
      expect(poolBalance).to.equal(EXPECTED_BASE);

      // Verify treasury received fee
      const treasuryBalanceAfter = await hubUsdc.balanceOf(treasuryAddress);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(EXPECTED_FEE);

      // Verify merkle root changed (tree number should still be 0)
      const treeNumber = await privacyPool.treeNumber();
      expect(treeNumber).to.equal(0);

      // Merkle root should not be zero anymore
      const root = await privacyPool.merkleRoot();
      expect(root).to.not.equal(ethers.ZeroHash);
    });
  });

  describe("Cross-Chain Shield", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("50", 6); // 50 USDC

    beforeEach(async function () {
      // Mint USDC to Alice on client chain
      await clientUsdc.mint(aliceAddress, SHIELD_AMOUNT);
    });

    it("should initiate cross-chain shield from client", async function () {
      // Approve PrivacyPoolClient to spend USDC
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);

      // Create shield parameters
      const npk = ethers.keccak256(ethers.toUtf8Bytes("alice-note-key"));
      const encryptedBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("shield-key"));

      // Execute cross-chain shield
      // Use bytes32(0) for destinationCaller to allow any relayer
      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,               // maxFee = 0 (no CCTP fee for this test)
        0,               // minFinalityThreshold = 0 (use contract default)
        npk,
        encryptedBundle,
        shieldKey,
        ethers.ZeroHash  // destinationCaller = 0 (any relayer can submit)
      );
      const receipt = await tx.wait();

      // Check event was emitted
      const event = receipt?.logs.find((log: any) => {
        try {
          return privacyPoolClient.interface.parseLog(log)?.name === "CrossChainShieldInitiated";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;

      // Verify USDC was burned on client
      const aliceBalance = await clientUsdc.balanceOf(aliceAddress);
      expect(aliceBalance).to.equal(0);
    });

    it("should complete end-to-end cross-chain shield with maxFee", async function () {
      const MAX_FEE = ethers.parseUnits("1", 6); // 1 USDC fee

      // Approve PrivacyPoolClient to spend USDC
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);

      // Create shield parameters
      const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      const rawNpk = BigInt(ethers.keccak256(ethers.toUtf8Bytes("alice-cctp-fee-note")));
      const validNpk = rawNpk % SNARK_SCALAR_FIELD;
      const npk = ethers.zeroPadValue(ethers.toBeHex(validNpk), 32);
      const encryptedBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("shield-key"));

      // Execute cross-chain shield with maxFee
      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        MAX_FEE,         // maxFee = 1 USDC (CCTP relayer fee)
        0,               // minFinalityThreshold = 0 (use contract default)
        npk,
        encryptedBundle,
        shieldKey,
        ethers.ZeroHash  // destinationCaller = 0 (any relayer)
      );
      const receipt = await tx.wait();

      // Extract MessageSent(bytes) event — contains the full encoded MessageV2
      const transmitterInterface = clientMessageTransmitter.interface;
      let encodedMessage: string | undefined;
      for (const log of receipt!.logs) {
        try {
          const parsed = transmitterInterface.parseLog(log);
          if (parsed?.name === "MessageSent") {
            encodedMessage = parsed.args.message;
            break;
          }
        } catch {
          // Not from this contract
        }
      }
      expect(encodedMessage).to.not.be.undefined;

      // Record balances before relay
      const poolBalanceBefore = await hubUsdc.balanceOf(privacyPoolAddress);
      const hookRouterAddress = await hubHookRouter.getAddress();
      const hookRouterBalanceBefore = await hubUsdc.balanceOf(hookRouterAddress);
      const treasuryBalanceBefore = await hubUsdc.balanceOf(treasuryAddress);
      const merkleRootBefore = await privacyPool.merkleRoot();

      // Relay the message to Hub via CCTPHookRouter (atomically calls receiveMessage + hook)
      await hubHookRouter.connect(relayer).relayWithHook(encodedMessage, "0x");

      // CCTP mints (SHIELD_AMOUNT - MAX_FEE) to pool, then shield fee is deducted
      const amountAfterCCTP = SHIELD_AMOUNT - MAX_FEE; // 49 USDC
      const shieldFeeAmount = amountAfterCCTP * 50n / 10000n; // 0.50% of 49 USDC
      const poolNetReceived = amountAfterCCTP - shieldFeeAmount;

      // Verify: PrivacyPool kept base amount (after shield fee deduction)
      const poolBalanceAfter = await hubUsdc.balanceOf(privacyPoolAddress);
      expect(poolBalanceAfter - poolBalanceBefore).to.equal(poolNetReceived);

      // Verify: CCTP fee was minted to hookRouter (msg.sender of receiveMessage in mock)
      // In real CCTP, the fee goes to the relayer EOA. In mock, it goes to msg.sender of receiveMessage.
      const hookRouterBalanceAfter = await hubUsdc.balanceOf(hookRouterAddress);
      expect(hookRouterBalanceAfter - hookRouterBalanceBefore).to.equal(MAX_FEE);

      // Verify: Treasury received shield fee
      const treasuryBalanceAfter = await hubUsdc.balanceOf(treasuryAddress);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(shieldFeeAmount);

      // Verify: Merkle root changed (commitment was inserted)
      const merkleRootAfter = await privacyPool.merkleRoot();
      expect(merkleRootAfter).to.not.equal(merkleRootBefore);
    });
  });

  describe("Cross-Chain Unshield with maxFee", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("100", 6); // 100 USDC
    const UNSHIELD_AMOUNT = ethers.parseUnits("50", 6); // 50 USDC
    const MAX_FEE = ethers.parseUnits("1", 6); // 1 USDC CCTP fee

    let poseidon: any;
    let F: any;

    before(async function () {
      // Initialize Poseidon for commitment hashing
      poseidon = await buildPoseidon();
      F = poseidon.F;

      // Enable testing mode to bypass SNARK proof verification
      await privacyPool.setTestingMode(true);

      // Mint USDC to Alice on hub and shield to fund the pool
      await hubUsdc.mint(aliceAddress, SHIELD_AMOUNT);
      await hubUsdc.connect(alice).approve(privacyPoolAddress, SHIELD_AMOUNT);

      const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      const rawNpk = BigInt(ethers.keccak256(ethers.toUtf8Bytes("alice-unshield-test-npk")));
      const validNpk = rawNpk % SNARK_SCALAR_FIELD;
      const npk = ethers.zeroPadValue(ethers.toBeHex(validNpk), 32);

      const shieldRequest = {
        preimage: {
          npk: npk,
          token: {
            tokenType: 0,
            tokenAddress: await hubUsdc.getAddress(),
            tokenSubID: 0,
          },
          value: SHIELD_AMOUNT,
        },
        ciphertext: {
          encryptedBundle: [
            ethers.keccak256(ethers.toUtf8Bytes("unshield-enc1")),
            ethers.keccak256(ethers.toUtf8Bytes("unshield-enc2")),
            ethers.keccak256(ethers.toUtf8Bytes("unshield-enc3")),
          ],
          shieldKey: ethers.keccak256(ethers.toUtf8Bytes("unshield-key")),
        },
      };

      await privacyPool.connect(alice).shield([shieldRequest]);
    });

    after(async function () {
      // Disable testing mode after tests
      await privacyPool.setTestingMode(false);
    });

    it("should complete end-to-end cross-chain unshield with maxFee", async function () {
      // Get current merkle root (valid after the shield in before())
      const merkleRoot = await privacyPool.merkleRoot();

      // Compute the unshield commitment hash using Poseidon
      // npk is the PrivacyPool address encoded as bytes32 (used by atomicCrossChainUnshield)
      const npkBigInt = BigInt(privacyPoolAddress);
      const usdcAddress = await hubUsdc.getAddress();
      const tokenId = BigInt(usdcAddress); // For ERC20: bytes32(uint256(uint160(tokenAddress)))
      const valueBigInt = BigInt(UNSHIELD_AMOUNT);

      const commitmentHash = poseidon([F.e(npkBigInt), F.e(tokenId), F.e(valueBigInt)]);
      const commitmentHashBytes32 = ethers.zeroPadValue(
        ethers.toBeHex(BigInt(F.toString(commitmentHash))),
        32
      );

      // Use a unique nullifier
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("unshield-nullifier-1"));

      // Construct the Transaction struct
      const transaction = {
        proof: {
          a: { x: 0, y: 0 },
          b: { x: [0, 0], y: [0, 0] },
          c: { x: 0, y: 0 },
        },
        merkleRoot: merkleRoot,
        nullifiers: [nullifier],
        commitments: [commitmentHashBytes32], // Single commitment = unshield output
        boundParams: {
          treeNumber: 0,
          minGasPrice: 0,
          unshield: 1, // UnshieldType.NORMAL
          chainID: 31337,
          adaptContract: ethers.ZeroAddress,
          adaptParams: ethers.ZeroHash,
          commitmentCiphertext: [], // length = commitments.length - 1 = 0
        },
        unshieldPreimage: {
          npk: ethers.zeroPadValue(privacyPoolAddress, 32),
          token: {
            tokenType: 0,
            tokenAddress: usdcAddress,
            tokenSubID: 0,
          },
          value: UNSHIELD_AMOUNT,
        },
      };

      // Set destinationCaller = relayer address (bytes32)
      const destinationCaller = ethers.ZeroHash; // Allow any relayer

      // Record balances before
      const recipientBalanceBefore = await clientUsdc.balanceOf(bobAddress);
      const clientHookRouterAddress = await clientHookRouter.getAddress();
      const hookRouterBalanceBefore = await clientUsdc.balanceOf(clientHookRouterAddress);

      // Execute atomic cross-chain unshield with maxFee
      const tx = await privacyPool.atomicCrossChainUnshield(
        transaction,
        DOMAINS.client,
        bobAddress,         // finalRecipient on client chain
        destinationCaller,
        MAX_FEE,
      );
      const receipt = await tx.wait();

      // Extract MessageSent(bytes) event — contains the full encoded MessageV2
      const transmitterInterface = hubMessageTransmitter.interface;
      let encodedMessage: string | undefined;
      for (const log of receipt!.logs) {
        try {
          const parsed = transmitterInterface.parseLog(log);
          if (parsed?.name === "MessageSent") {
            encodedMessage = parsed.args.message;
            break;
          }
        } catch {
          // Not from this contract
        }
      }
      expect(encodedMessage).to.not.be.undefined;

      // Relay the message to client chain via CCTPHookRouter (atomically calls receiveMessage + hook)
      await clientHookRouter.connect(relayer).relayWithHook(encodedMessage, "0x");

      // Verify: Recipient (Bob) received UNSHIELD_AMOUNT - MAX_FEE on client chain
      const recipientBalanceAfter = await clientUsdc.balanceOf(bobAddress);
      expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(UNSHIELD_AMOUNT - MAX_FEE);

      // Verify: CCTP fee was minted to hookRouter (msg.sender of receiveMessage in mock)
      const hookRouterBalanceAfter = await clientUsdc.balanceOf(clientHookRouterAddress);
      expect(hookRouterBalanceAfter - hookRouterBalanceBefore).to.equal(MAX_FEE);
    });
  });

  describe("Verification Keys", function () {
    it("should have verification keys loaded", async function () {
      // Check that verification keys are set for common circuit configurations
      // A key is set if alpha1.x != 0
      const key1x2 = await privacyPool.getVerificationKey(1, 2);
      expect(key1x2.alpha1.x).to.not.equal(0n);

      const key2x2 = await privacyPool.getVerificationKey(2, 2);
      expect(key2x2.alpha1.x).to.not.equal(0n);
    });

    it("should not have testing mode enabled", async function () {
      // Testing mode should be disabled - we use real SNARK verification
      const testingMode = await privacyPool.testingMode();
      expect(testingMode).to.equal(false);
    });
  });

  describe("Configuration", function () {
    it("should have correct remote pool configured", async function () {
      const clientBytes32 = ethers.zeroPadValue(clientAddress, 32);
      const remotePool = await privacyPool.remotePools(DOMAINS.client);
      expect(remotePool).to.equal(clientBytes32);
    });

    it("should have correct hub pool configured on client", async function () {
      const hubPoolBytes32 = ethers.zeroPadValue(privacyPoolAddress, 32);
      const hubPool = await privacyPoolClient.hubPool();
      expect(hubPool).to.equal(hubPoolBytes32);
    });
  });
});
