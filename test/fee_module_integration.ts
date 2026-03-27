/**
 * Fee Module Integration Tests
 *
 * Tests ArmadaFeeModule wired into the live PrivacyPool (ShieldModule) and
 * ArmadaYieldVault on a local Hardhat/Anvil chain. Covers:
 *   1. Local shield with fee module (no integrator)
 *   2. Local shield with registered integrator — fee split
 *   3. Cross-chain shield with fee module
 *   4. Flat fee fallback when feeModule == address(0)
 *   5. Yield vault reads fee from module and records via recordYieldFee
 *   6. Privileged callers (adapter) bypass fee module
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import * as fs from "fs";
import * as path from "path";
// @ts-ignore - circomlibjs doesn't have types
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
const BPS_DENOMINATOR = 10000n;

describe("Fee Module Integration", function () {
  // Core contracts
  let hubUsdc: Contract;
  let hubTokenMessenger: Contract;
  let hubMessageTransmitter: Contract;
  let hubHookRouter: Contract;
  let privacyPool: Contract;
  let shieldModule: Contract;
  let feeModule: Contract;

  // Client chain (for cross-chain tests)
  let clientUsdc: Contract;
  let clientTokenMessenger: Contract;
  let clientMessageTransmitter: Contract;
  let clientHookRouter: Contract;
  let privacyPoolClient: Contract;

  // Yield contracts
  let mockAaveSpoke: Contract;
  let armadaTreasury: Contract;
  let armadaYieldVault: Contract;
  let armadaYieldAdapter: Contract;

  // Signers
  let deployer: Signer;
  let alice: Signer;
  let integrator: Signer;
  let relayer: Signer;

  // Addresses
  let deployerAddress: string;
  let aliceAddress: string;
  let integratorAddress: string;
  let relayerAddress: string;
  let privacyPoolAddress: string;
  let clientAddress: string;
  let treasuryAddress: string;
  let feeModuleAddress: string;
  let usdcAddress: string;
  let vaultAddress: string;
  let adapterAddress: string;

  let poseidon: any;
  let F: any;

  before(async function () {
    [deployer, alice, integrator, relayer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    aliceAddress = await alice.getAddress();
    integratorAddress = await integrator.getAddress();
    relayerAddress = await relayer.getAddress();

    poseidon = await buildPoseidon();
    F = poseidon.F;

    // ── Deploy Hub chain ──
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    hubUsdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    usdcAddress = await hubUsdc.getAddress();

    const MockMessageTransmitterV2 = await ethers.getContractFactory("MockMessageTransmitterV2");
    hubMessageTransmitter = await MockMessageTransmitterV2.deploy(DOMAINS.hub, relayerAddress);

    const MockTokenMessengerV2 = await ethers.getContractFactory("MockTokenMessengerV2");
    hubTokenMessenger = await MockTokenMessengerV2.deploy(
      await hubMessageTransmitter.getAddress(),
      usdcAddress,
      DOMAINS.hub
    );
    await hubMessageTransmitter.setTokenMessenger(await hubTokenMessenger.getAddress());
    await hubUsdc.addMinter(await hubTokenMessenger.getAddress());

    // Poseidon libraries
    const poseidonT3Tx = await deployer.sendTransaction({ data: poseidonBytecode.PoseidonT3.bytecode });
    const poseidonT3Address = (await poseidonT3Tx.wait())!.contractAddress!;
    const poseidonT4Tx = await deployer.sendTransaction({ data: poseidonBytecode.PoseidonT4.bytecode });
    const poseidonT4Address = (await poseidonT4Tx.wait())!.contractAddress!;

    // Modules
    const merkleModule = await (
      await ethers.getContractFactory("MerkleModule", { libraries: { PoseidonT3: poseidonT3Address } })
    ).deploy();
    const verifierModule = await (await ethers.getContractFactory("VerifierModule")).deploy();
    shieldModule = await (
      await ethers.getContractFactory("ShieldModule", { libraries: { PoseidonT4: poseidonT4Address } })
    ).deploy();
    const transactModule = await (
      await ethers.getContractFactory("TransactModule", { libraries: { PoseidonT4: poseidonT4Address } })
    ).deploy();

    // Treasury (deployed before PrivacyPool so address is available for initialize)
    const ArmadaTreasury = await ethers.getContractFactory("ArmadaTreasury");
    armadaTreasury = await ArmadaTreasury.deploy();
    treasuryAddress = await armadaTreasury.getAddress();

    // PrivacyPool
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
      usdcAddress,
      DOMAINS.hub,
      deployerAddress,
      treasuryAddress
    );

    await loadVerificationKeys(privacyPool, TESTING_ARTIFACT_CONFIGS, false);
    await privacyPool.setTestingMode(true);
    await privacyPool.setShieldFee(50); // 0.50% flat fee (for fallback tests)

    // ── Deploy ArmadaFeeModule behind UUPS proxy ──
    const ArmadaFeeModule = await ethers.getContractFactory("ArmadaFeeModule");
    const feeModuleImpl = await ArmadaFeeModule.deploy();
    await feeModuleImpl.waitForDeployment();

    // Yield vault (needed for fee module init)
    const MockAaveSpoke = await ethers.getContractFactory("MockAaveSpoke");
    mockAaveSpoke = await MockAaveSpoke.deploy();
    await hubUsdc.addMinter(await mockAaveSpoke.getAddress());
    await mockAaveSpoke.addReserve(usdcAddress, 500, true);

    const ArmadaYieldVault = await ethers.getContractFactory("ArmadaYieldVault");
    armadaYieldVault = await ArmadaYieldVault.deploy(
      await mockAaveSpoke.getAddress(),
      0,
      treasuryAddress,
      "Armada Yield USDC",
      "ayUSDC"
    );
    vaultAddress = await armadaYieldVault.getAddress();

    // Deploy proxy
    const initData = ArmadaFeeModule.interface.encodeFunctionData("initialize", [
      deployerAddress,      // owner
      treasuryAddress,      // treasury
      privacyPoolAddress,   // privacyPool
      vaultAddress,         // yieldVault
    ]);
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const feeModuleProxy = await ERC1967Proxy.deploy(await feeModuleImpl.getAddress(), initData);
    await feeModuleProxy.waitForDeployment();
    feeModuleAddress = await feeModuleProxy.getAddress();
    feeModule = ArmadaFeeModule.attach(feeModuleAddress);

    // Wire fee module into PrivacyPool and YieldVault
    await privacyPool.setFeeModule(feeModuleAddress);
    await armadaYieldVault.setFeeModule(feeModuleAddress);

    // ── Deploy yield adapter ──
    const MockAdapterRegistry = await ethers.getContractFactory("MockAdapterRegistry");
    const mockRegistry = await MockAdapterRegistry.deploy();
    const ArmadaYieldAdapter = await ethers.getContractFactory("ArmadaYieldAdapter");
    armadaYieldAdapter = await ArmadaYieldAdapter.deploy(
      usdcAddress,
      vaultAddress,
      await mockRegistry.getAddress()
    );
    adapterAddress = await armadaYieldAdapter.getAddress();
    await mockRegistry.setAuthorized(adapterAddress, true);
    await armadaYieldVault.setAdapter(adapterAddress);
    await armadaYieldAdapter.setPrivacyPool(privacyPoolAddress);
    await privacyPool.setPrivilegedShieldCaller(adapterAddress, true);

    // ── Deploy Client chain ──
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
      ethers.ZeroHash,
      deployerAddress
    );

    // Hook routers
    const CCTPHookRouter = await ethers.getContractFactory("CCTPHookRouter");
    hubHookRouter = await CCTPHookRouter.deploy(await hubMessageTransmitter.getAddress());
    clientHookRouter = await CCTPHookRouter.deploy(await clientMessageTransmitter.getAddress());

    // Link hub ↔ client
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

    // Fund Alice
    await hubUsdc.mint(aliceAddress, ethers.parseUnits("100000", 6));
    await clientUsdc.mint(aliceAddress, ethers.parseUnits("100000", 6));
  });

  after(async function () {
    await privacyPool.setTestingMode(false);
  });

  // ── Helpers ──

  function validNpk(seed: string = "test-npk"): string {
    const raw = BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed)));
    return ethers.zeroPadValue(ethers.toBeHex(raw % SNARK_SCALAR_FIELD), 32);
  }

  function makeShieldRequest(amount: bigint, npkSeed?: string) {
    return {
      preimage: {
        npk: validNpk(npkSeed ?? `shield-${Date.now()}-${Math.random()}`),
        token: { tokenType: 0, tokenAddress: usdcAddress, tokenSubID: 0 },
        value: amount,
      },
      ciphertext: {
        encryptedBundle: [
          ethers.keccak256(ethers.toUtf8Bytes("enc1")),
          ethers.keccak256(ethers.toUtf8Bytes("enc2")),
          ethers.keccak256(ethers.toUtf8Bytes("enc3")),
        ],
        shieldKey: ethers.keccak256(ethers.toUtf8Bytes("key")),
      },
    };
  }

  // ── Tests ──

  describe("Local shield with fee module (no integrator)", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("1000", 6); // 1000 USDC

    it("should deduct armada take and send to treasury", async function () {
      await hubUsdc.connect(alice).approve(privacyPoolAddress, SHIELD_AMOUNT);

      const treasuryBefore = await hubUsdc.balanceOf(treasuryAddress);
      const poolBefore = await hubUsdc.balanceOf(privacyPoolAddress);

      await privacyPool.connect(alice).shield([makeShieldRequest(SHIELD_AMOUNT)], ethers.ZeroAddress);

      // Default baseArmadaTakeBps = 50 (0.50%)
      const expectedArmadaTake = SHIELD_AMOUNT * 50n / BPS_DENOMINATOR;
      const expectedBase = SHIELD_AMOUNT - expectedArmadaTake;

      const treasuryAfter = await hubUsdc.balanceOf(treasuryAddress);
      const poolAfter = await hubUsdc.balanceOf(privacyPoolAddress);

      expect(treasuryAfter - treasuryBefore).to.equal(expectedArmadaTake);
      expect(poolAfter - poolBefore).to.equal(expectedBase);
    });

    it("should record fee in fee module cumulative counters", async function () {
      const cumulativeBefore = await feeModule.cumulativeArmadaFees();

      await hubUsdc.connect(alice).approve(privacyPoolAddress, SHIELD_AMOUNT);
      await privacyPool.connect(alice).shield([makeShieldRequest(SHIELD_AMOUNT)], ethers.ZeroAddress);

      const expectedArmadaTake = SHIELD_AMOUNT * 50n / BPS_DENOMINATOR;
      const cumulativeAfter = await feeModule.cumulativeArmadaFees();

      expect(cumulativeAfter - cumulativeBefore).to.equal(expectedArmadaTake);
    });

    it("should expose cumulative fees via IFeeCollector", async function () {
      const cumulative = await feeModule.cumulativeFeesCollected();
      const armadaFees = await feeModule.cumulativeArmadaFees();
      expect(cumulative).to.equal(armadaFees);
    });
  });

  describe("Local shield with registered integrator", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("1000", 6);
    const INTEGRATOR_FEE_BPS = 100n; // 1%

    before(async function () {
      // Integrator self-registers with 1% base fee
      await feeModule.connect(integrator).setIntegratorFee(INTEGRATOR_FEE_BPS);
    });

    it("should split fees between treasury and integrator", async function () {
      await hubUsdc.connect(alice).approve(privacyPoolAddress, SHIELD_AMOUNT);

      const treasuryBefore = await hubUsdc.balanceOf(treasuryAddress);
      const integratorBefore = await hubUsdc.balanceOf(integratorAddress);
      const poolBefore = await hubUsdc.balanceOf(privacyPoolAddress);

      await privacyPool.connect(alice).shield([makeShieldRequest(SHIELD_AMOUNT)], integratorAddress);

      // baseArmadaTakeBps = 50, integrator baseFee = 100
      // No tier discount yet (volume below $250k threshold) so bonus = 0
      const expectedArmadaTake = SHIELD_AMOUNT * 50n / BPS_DENOMINATOR;
      const expectedIntegratorFee = SHIELD_AMOUNT * INTEGRATOR_FEE_BPS / BPS_DENOMINATOR;
      const expectedBase = SHIELD_AMOUNT - expectedArmadaTake - expectedIntegratorFee;

      const treasuryAfter = await hubUsdc.balanceOf(treasuryAddress);
      const integratorAfter = await hubUsdc.balanceOf(integratorAddress);
      const poolAfter = await hubUsdc.balanceOf(privacyPoolAddress);

      expect(treasuryAfter - treasuryBefore).to.equal(expectedArmadaTake);
      expect(integratorAfter - integratorBefore).to.equal(expectedIntegratorFee);
      expect(poolAfter - poolBefore).to.equal(expectedBase);
    });

    it("should update integrator cumulative volume and earnings", async function () {
      const infoBefore = await feeModule.getIntegratorInfo(integratorAddress);

      await hubUsdc.connect(alice).approve(privacyPoolAddress, SHIELD_AMOUNT);
      await privacyPool.connect(alice).shield([makeShieldRequest(SHIELD_AMOUNT)], integratorAddress);

      const infoAfter = await feeModule.getIntegratorInfo(integratorAddress);

      expect(infoAfter.cumulativeVolume - infoBefore.cumulativeVolume).to.equal(SHIELD_AMOUNT);
      expect(infoAfter.cumulativeEarnings).to.be.gt(infoBefore.cumulativeEarnings);
    });
  });

  describe("Cross-chain shield with fee module", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("500", 6);

    it("should deduct fees from CCTP-minted amount on hub", async function () {
      await clientUsdc.connect(alice).approve(clientAddress, SHIELD_AMOUNT);

      const npk = validNpk("cross-chain-fee-module");
      const encryptedBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("cc-enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("cc-enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("cc-enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("cc-key"));

      // Initiate cross-chain shield (no CCTP fee for simplicity)
      const tx = await privacyPoolClient.connect(alice).crossChainShield(
        SHIELD_AMOUNT,
        0,    // maxFee
        0,    // minFinalityThreshold
        npk,
        encryptedBundle,
        shieldKey,
        ethers.ZeroHash,
        ethers.ZeroAddress  // no integrator
      );
      const receipt = await tx.wait();

      // Extract CCTP message
      const transmitterInterface = clientMessageTransmitter.interface;
      let encodedMessage: string | undefined;
      for (const log of receipt!.logs) {
        try {
          const parsed = transmitterInterface.parseLog(log);
          if (parsed?.name === "MessageSent") {
            encodedMessage = parsed.args.message;
            break;
          }
        } catch { /* not from this contract */ }
      }
      expect(encodedMessage).to.not.be.undefined;

      // Record balances before relay
      const poolBefore = await hubUsdc.balanceOf(privacyPoolAddress);
      const treasuryBefore = await hubUsdc.balanceOf(treasuryAddress);
      const cumulativeBefore = await feeModule.cumulativeArmadaFees();

      // Relay to hub
      await hubHookRouter.connect(relayer).relayWithHook(encodedMessage!, "0x");

      // Fee module applies 50 bps armada take to CCTP-minted amount
      const expectedArmadaTake = SHIELD_AMOUNT * 50n / BPS_DENOMINATOR;
      const expectedBase = SHIELD_AMOUNT - expectedArmadaTake;

      const poolAfter = await hubUsdc.balanceOf(privacyPoolAddress);
      const treasuryAfter = await hubUsdc.balanceOf(treasuryAddress);
      const cumulativeAfter = await feeModule.cumulativeArmadaFees();

      expect(poolAfter - poolBefore).to.equal(expectedBase);
      expect(treasuryAfter - treasuryBefore).to.equal(expectedArmadaTake);
      expect(cumulativeAfter - cumulativeBefore).to.equal(expectedArmadaTake);
    });
  });

  describe("Flat fee fallback (feeModule == address(0))", function () {
    const SHIELD_AMOUNT = ethers.parseUnits("100", 6);

    it("should use flat shieldFee when fee module is cleared", async function () {
      // Temporarily clear fee module
      await privacyPool.setFeeModule(ethers.ZeroAddress);

      await hubUsdc.connect(alice).approve(privacyPoolAddress, SHIELD_AMOUNT);

      const treasuryBefore = await hubUsdc.balanceOf(treasuryAddress);
      const poolBefore = await hubUsdc.balanceOf(privacyPoolAddress);

      await privacyPool.connect(alice).shield([makeShieldRequest(SHIELD_AMOUNT)], ethers.ZeroAddress);

      // Flat fee: 50 bps
      const expectedFee = SHIELD_AMOUNT * 50n / BPS_DENOMINATOR;
      const expectedBase = SHIELD_AMOUNT - expectedFee;

      const treasuryAfter = await hubUsdc.balanceOf(treasuryAddress);
      const poolAfter = await hubUsdc.balanceOf(privacyPoolAddress);

      expect(treasuryAfter - treasuryBefore).to.equal(expectedFee);
      expect(poolAfter - poolBefore).to.equal(expectedBase);

      // Restore fee module
      await privacyPool.setFeeModule(feeModuleAddress);
    });
  });

  describe("Yield vault fee module integration", function () {
    it("should read yield fee from fee module", async function () {
      const feeModuleYieldBps = await feeModule.getYieldFeeBps();
      // Default is 1500 (15%)
      expect(feeModuleYieldBps).to.equal(1500n);
    });

    it("should block setYieldFeeBps when fee module is set", async function () {
      await expect(
        armadaYieldVault.setYieldFeeBps(2000)
      ).to.be.revertedWith("ArmadaYieldVault: use fee module");
    });

    it("should record yield fee via recordYieldFee on redeem", async function () {
      // Deposit USDC into vault to generate shares
      const depositAmount = ethers.parseUnits("10000", 6);
      await hubUsdc.mint(deployerAddress, depositAmount);
      await hubUsdc.approve(vaultAddress, depositAmount);
      await armadaYieldVault.deposit(depositAmount, deployerAddress);

      // Simulate yield accrual by minting extra USDC to the Aave spoke
      const yieldAmount = ethers.parseUnits("1000", 6);
      await hubUsdc.mint(await mockAaveSpoke.getAddress(), yieldAmount);

      const shares = await armadaYieldVault.balanceOf(deployerAddress);
      expect(shares).to.be.gt(0n);

      const cumulativeBefore = await feeModule.cumulativeArmadaFees();

      // Redeem all shares
      await armadaYieldVault.redeem(shares, deployerAddress, deployerAddress);

      const cumulativeAfter = await feeModule.cumulativeArmadaFees();
      // Yield fee should have been recorded (15% of yield)
      expect(cumulativeAfter).to.be.gt(cumulativeBefore);
    });
  });

  describe("Privileged caller bypasses fee module", function () {
    it("adapter shields without fee even with fee module active", async function () {
      // Seed the pool with shielded USDC first
      const seedAmount = ethers.parseUnits("5000", 6);
      await hubUsdc.connect(alice).approve(privacyPoolAddress, seedAmount);
      await privacyPool.connect(alice).shield([makeShieldRequest(seedAmount)], ethers.ZeroAddress);

      const merkleRoot = await privacyPool.merkleRoot();
      const amount = ethers.parseUnits("1000", 6);

      // Build a lendAndShield transaction (testing mode bypasses SNARK)
      const npk = validNpk("adapter-fee-test");
      const encryptedBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("adapt-enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("adapt-enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("adapt-enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("adapt-key"));

      const adaptParamsEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32[3]", "bytes32"],
        [npk, encryptedBundle, shieldKey]
      );
      const adaptParams = ethers.keccak256(adaptParamsEncoded);

      const unshieldNpk = ethers.zeroPadValue(adapterAddress, 32);
      const tokenId = BigInt(usdcAddress);
      const commitmentHash = poseidon([F.e(BigInt(unshieldNpk)), F.e(tokenId), F.e(BigInt(amount))]);
      const commitmentHashBytes32 = ethers.zeroPadValue(
        ethers.toBeHex(BigInt(F.toString(commitmentHash))),
        32
      );

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const transaction = {
        proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
        merkleRoot,
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("null-adapter-fee"))],
        commitments: [commitmentHashBytes32],
        boundParams: {
          treeNumber: 0,
          minGasPrice: 0,
          unshield: 1,
          chainID: chainId,
          adaptContract: adapterAddress,
          adaptParams,
          commitmentCiphertext: [],
        },
        unshieldPreimage: {
          npk: unshieldNpk,
          token: { tokenType: 0, tokenAddress: usdcAddress, tokenSubID: 0 },
          value: amount,
        },
      };

      const treasuryBefore = await hubUsdc.balanceOf(treasuryAddress);
      const cumulativeBefore = await feeModule.cumulativeArmadaFees();

      await armadaYieldAdapter.lendAndShield(transaction, npk, { encryptedBundle, shieldKey });

      const treasuryAfter = await hubUsdc.balanceOf(treasuryAddress);
      const cumulativeAfter = await feeModule.cumulativeArmadaFees();

      // No shield fee charged — adapter is privileged
      expect(treasuryAfter).to.equal(treasuryBefore);
      expect(cumulativeAfter).to.equal(cumulativeBefore);
    });
  });
});
