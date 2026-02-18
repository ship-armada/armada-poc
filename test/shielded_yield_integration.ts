/**
 * Shielded Yield Integration Tests
 *
 * Tests the trustless lendAndShield and redeemAndShield flows via ArmadaYieldAdapter.
 * Uses testing mode (proof verification bypass) to test the full flow without SNARK proofs.
 *
 * - lendAndShield: shielded USDC -> unshield to adapter -> deposit -> shield ayUSDC
 * - redeemAndShield: shielded ayUSDC -> unshield to adapter -> redeem -> shield USDC
 * - Adapter validation: invalid adaptContract, invalid adaptParams
 * - Fee exemption: covered by Privileged Shield Callers in privacy_pool_adversarial.ts
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

const DOMAINS = { hub: 100 };
const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Encode YieldAdaptParams - must match Solidity YieldAdaptParams.encode
 */
function encodeYieldAdaptParams(
  npk: string,
  encryptedBundle: [string, string, string],
  shieldKey: string
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32[3]", "bytes32"],
    [npk, encryptedBundle, shieldKey]
  );
  return ethers.keccak256(encoded);
}

describe("Shielded Yield (lendAndShield / redeemAndShield)", function () {
  let hubUsdc: Contract;
  let hubTokenMessenger: Contract;
  let hubMessageTransmitter: Contract;
  let privacyPool: Contract;
  let merkleModule: Contract;
  let verifierModule: Contract;
  let shieldModule: Contract;
  let transactModule: Contract;
  let mockAaveSpoke: Contract;
  let armadaTreasury: Contract;
  let armadaYieldVault: Contract;
  let armadaYieldAdapter: Contract;

  let deployer: Signer;
  let alice: Signer;
  let relayer: Signer;

  let deployerAddress: string;
  let aliceAddress: string;
  let privacyPoolAddress: string;
  let adapterAddress: string;
  let usdcAddress: string;
  let vaultAddress: string;

  let poseidon: any;
  let F: any;

  before(async function () {
    [deployer, alice, relayer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    aliceAddress = await alice.getAddress();

    poseidon = await buildPoseidon();
    F = poseidon.F;

    // Deploy hub chain (PrivacyPool + CCTP)
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    hubUsdc = await MockUSDCV2.deploy("Mock USDC", "USDC");

    const MockMessageTransmitterV2 = await ethers.getContractFactory("MockMessageTransmitterV2");
    hubMessageTransmitter = await MockMessageTransmitterV2.deploy(
      DOMAINS.hub,
      await relayer.getAddress()
    );

    const MockTokenMessengerV2 = await ethers.getContractFactory("MockTokenMessengerV2");
    hubTokenMessenger = await MockTokenMessengerV2.deploy(
      await hubMessageTransmitter.getAddress(),
      await hubUsdc.getAddress(),
      DOMAINS.hub
    );
    await hubMessageTransmitter.setTokenMessenger(await hubTokenMessenger.getAddress());
    await hubUsdc.addMinter(await hubTokenMessenger.getAddress());

    const poseidonT3Tx = await deployer.sendTransaction({
      data: poseidonBytecode.PoseidonT3.bytecode,
    });
    const poseidonT3Address = (await poseidonT3Tx.wait())!.contractAddress!;
    const poseidonT4Tx = await deployer.sendTransaction({
      data: poseidonBytecode.PoseidonT4.bytecode,
    });
    const poseidonT4Address = (await poseidonT4Tx.wait())!.contractAddress!;

    merkleModule = await (
      await ethers.getContractFactory("MerkleModule", {
        libraries: { PoseidonT3: poseidonT3Address },
      })
    ).deploy();
    verifierModule = await (await ethers.getContractFactory("VerifierModule")).deploy();
    shieldModule = await (
      await ethers.getContractFactory("ShieldModule", {
        libraries: { PoseidonT4: poseidonT4Address },
      })
    ).deploy();
    transactModule = await (
      await ethers.getContractFactory("TransactModule", {
        libraries: { PoseidonT4: poseidonT4Address },
      })
    ).deploy();

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
    await privacyPool.setShieldFee(50);

    // Deploy yield (vault, adapter)
    const MockAaveSpoke = await ethers.getContractFactory("MockAaveSpoke");
    mockAaveSpoke = await MockAaveSpoke.deploy();
    await hubUsdc.addMinter(await mockAaveSpoke.getAddress());
    await mockAaveSpoke.addReserve(await hubUsdc.getAddress(), 500, true);

    const ArmadaTreasury = await ethers.getContractFactory("ArmadaTreasury");
    armadaTreasury = await ArmadaTreasury.deploy();

    const ArmadaYieldVault = await ethers.getContractFactory("ArmadaYieldVault");
    armadaYieldVault = await ArmadaYieldVault.deploy(
      await mockAaveSpoke.getAddress(),
      0,
      await armadaTreasury.getAddress(),
      "Armada Yield USDC",
      "ayUSDC"
    );
    vaultAddress = await armadaYieldVault.getAddress();

    const ArmadaYieldAdapter = await ethers.getContractFactory("ArmadaYieldAdapter");
    armadaYieldAdapter = await ArmadaYieldAdapter.deploy(
      await hubUsdc.getAddress(),
      vaultAddress
    );
    adapterAddress = await armadaYieldAdapter.getAddress();
    usdcAddress = await hubUsdc.getAddress();

    await armadaYieldVault.setAdapter(adapterAddress);
    await armadaYieldAdapter.setPrivacyPool(privacyPoolAddress);
    await privacyPool.setPrivilegedShieldCaller(adapterAddress, true);

    await hubUsdc.mint(aliceAddress, ethers.parseUnits("100000", 6));
  });

  function validNpk(): string {
    const raw = BigInt(ethers.keccak256(ethers.toUtf8Bytes("test-npk")));
    return ethers.zeroPadValue(ethers.toBeHex(raw % SNARK_SCALAR_FIELD), 32);
  }

  function computeCommitmentHash(npkBigInt: bigint, tokenId: bigint, value: bigint): string {
    const hash = poseidon([F.e(npkBigInt), F.e(tokenId), F.e(value)]);
    return ethers.zeroPadValue(ethers.toBeHex(BigInt(F.toString(hash))), 32);
  }

  function makeShieldRequest(token: string, amount: bigint, npk?: string) {
    return {
      preimage: {
        npk: npk ?? validNpk(),
        token: { tokenType: 0, tokenAddress: token, tokenSubID: 0 },
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

  async function makeLendTransaction(opts: {
    merkleRoot: string;
    nullifier: string;
    unshieldPreimage: { npk: string; tokenAddress: string; value: bigint };
    adaptContract: string;
    adaptParams: string;
    npk: string;
    encryptedBundle: [string, string, string];
    shieldKey: string;
  }) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const unshieldHash = computeCommitmentHash(
      BigInt(opts.unshieldPreimage.npk),
      BigInt(opts.unshieldPreimage.tokenAddress),
      opts.unshieldPreimage.value
    );
    return {
      proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
      merkleRoot: opts.merkleRoot,
      nullifiers: [opts.nullifier],
      commitments: [unshieldHash],
      boundParams: {
        treeNumber: 0,
        minGasPrice: 0,
        unshield: 1,
        chainID: chainId,
        adaptContract: opts.adaptContract,
        adaptParams: opts.adaptParams,
        commitmentCiphertext: [],
      },
      unshieldPreimage: {
        npk: opts.unshieldPreimage.npk,
        token: {
          tokenType: 0,
          tokenAddress: opts.unshieldPreimage.tokenAddress,
          tokenSubID: 0,
        },
        value: opts.unshieldPreimage.value,
      },
    };
  }

  async function shieldAndGetRoot(amount: bigint): Promise<string> {
    await hubUsdc.connect(alice).approve(privacyPoolAddress, amount);
    await privacyPool.connect(alice).shield([makeShieldRequest(usdcAddress, amount)]);
    return await privacyPool.merkleRoot();
  }

  describe("Adapter validation", function () {
    it("reverts when adaptContract is wrong", async function () {
      const amount = ethers.parseUnits("100", 6);
      const root = await shieldAndGetRoot(amount);

      const npk = validNpk();
      const encryptedBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("key"));
      const adaptParams = encodeYieldAdaptParams(npk, encryptedBundle, shieldKey);

      const tx = await makeLendTransaction({
        merkleRoot: root,
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("null-invalid-adapt")),
        unshieldPreimage: {
          npk: ethers.zeroPadValue(adapterAddress, 32),
          tokenAddress: usdcAddress,
          value: amount,
        },
        adaptContract: ethers.ZeroAddress,
        adaptParams,
        npk,
        encryptedBundle,
        shieldKey,
      });

      await expect(
        armadaYieldAdapter.lendAndShield(tx, npk, { encryptedBundle, shieldKey })
      ).to.be.revertedWith("ArmadaYieldAdapter: invalid adaptContract");
    });

    it("reverts when adaptParams mismatch (wrong npk)", async function () {
      const amount = ethers.parseUnits("100", 6);
      const root = await shieldAndGetRoot(amount);

      const npk = validNpk();
      const wrongNpk = ethers.zeroPadValue("0x01", 32);
      const encryptedBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("key"));
      const adaptParams = encodeYieldAdaptParams(wrongNpk, encryptedBundle, shieldKey);

      const tx = await makeLendTransaction({
        merkleRoot: root,
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("null-adapt-params")),
        unshieldPreimage: {
          npk: ethers.zeroPadValue(adapterAddress, 32),
          tokenAddress: usdcAddress,
          value: amount,
        },
        adaptContract: adapterAddress,
        adaptParams,
        npk: wrongNpk,
        encryptedBundle,
        shieldKey,
      });

      await expect(
        armadaYieldAdapter.lendAndShield(tx, npk, { encryptedBundle, shieldKey })
      ).to.be.revertedWith("ArmadaYieldAdapter: adaptParams mismatch");
    });
  });

  describe("lendAndShield", function () {
    it("should allow trustless lend: shielded USDC -> shielded ayUSDC", async function () {
      const amount = ethers.parseUnits("1000", 6);
      const root = await shieldAndGetRoot(amount);

      const npk = validNpk();
      const encryptedBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("key"));
      const adaptParams = encodeYieldAdaptParams(npk, encryptedBundle, shieldKey);

      const tx = await makeLendTransaction({
        merkleRoot: root,
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("null-lend-1")),
        unshieldPreimage: {
          npk: ethers.zeroPadValue(adapterAddress, 32),
          tokenAddress: usdcAddress,
          value: amount,
        },
        adaptContract: adapterAddress,
        adaptParams,
        npk,
        encryptedBundle,
        shieldKey,
      });

      const poolUsdcBefore = await hubUsdc.balanceOf(privacyPoolAddress);
      const poolAyBefore = await armadaYieldVault.balanceOf(privacyPoolAddress);

      const shares = await armadaYieldAdapter.lendAndShield.staticCall(
        tx,
        npk,
        { encryptedBundle, shieldKey }
      );
      await armadaYieldAdapter.lendAndShield(tx, npk, { encryptedBundle, shieldKey });

      const poolUsdcAfter = await hubUsdc.balanceOf(privacyPoolAddress);
      const poolAyAfter = await armadaYieldVault.balanceOf(privacyPoolAddress);

      expect(shares).to.be.gt(0n);
      expect(poolUsdcBefore - poolUsdcAfter).to.equal(amount);
      expect(poolAyAfter - poolAyBefore).to.equal(shares);
    });
  });

  describe("redeemAndShield", function () {
    it("should allow trustless redeem: shielded ayUSDC -> shielded USDC", async function () {
      const lendAmount = ethers.parseUnits("1000", 6);
      await shieldAndGetRoot(lendAmount);

      const npk = validNpk();
      const encryptedBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("enc3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("key"));
      const adaptParams = encodeYieldAdaptParams(npk, encryptedBundle, shieldKey);

      const lendTx = await makeLendTransaction({
        merkleRoot: await privacyPool.merkleRoot(),
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("null-lend-redeem")),
        unshieldPreimage: {
          npk: ethers.zeroPadValue(adapterAddress, 32),
          tokenAddress: usdcAddress,
          value: lendAmount,
        },
        adaptContract: adapterAddress,
        adaptParams,
        npk,
        encryptedBundle,
        shieldKey,
      });

      await armadaYieldAdapter.lendAndShield(lendTx, npk, { encryptedBundle, shieldKey });

      const shares = await armadaYieldVault.balanceOf(privacyPoolAddress);
      expect(shares).to.be.gt(0n);

      const redeemAdaptParams = encodeYieldAdaptParams(npk, encryptedBundle, shieldKey);
      const unshieldHash = computeCommitmentHash(
        BigInt(ethers.zeroPadValue(adapterAddress, 32)),
        BigInt(vaultAddress),
        shares
      );

      const redeemTx = {
        proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
        merkleRoot: await privacyPool.merkleRoot(),
        nullifiers: [ethers.keccak256(ethers.toUtf8Bytes("null-redeem-1"))],
        commitments: [unshieldHash],
        boundParams: {
          treeNumber: 0,
          minGasPrice: 0,
          unshield: 1,
          chainID: (await ethers.provider.getNetwork()).chainId,
          adaptContract: adapterAddress,
          adaptParams: redeemAdaptParams,
          commitmentCiphertext: [],
        },
        unshieldPreimage: {
          npk: ethers.zeroPadValue(adapterAddress, 32),
          token: {
            tokenType: 0,
            tokenAddress: vaultAddress,
            tokenSubID: 0,
          },
          value: shares,
        },
      };

      const poolUsdcBefore = await hubUsdc.balanceOf(privacyPoolAddress);
      const poolAyBefore = await armadaYieldVault.balanceOf(privacyPoolAddress);

      const assets = await armadaYieldAdapter.redeemAndShield.staticCall(
        redeemTx,
        npk,
        { encryptedBundle, shieldKey }
      );
      await armadaYieldAdapter.redeemAndShield(redeemTx, npk, {
        encryptedBundle,
        shieldKey,
      });

      const poolUsdcAfter = await hubUsdc.balanceOf(privacyPoolAddress);
      const poolAyAfter = await armadaYieldVault.balanceOf(privacyPoolAddress);

      expect(assets).to.be.gt(0n);
      expect(poolAyAfter - poolAyBefore).to.equal(-shares);
      expect(poolUsdcAfter - poolUsdcBefore).to.be.closeTo(assets, 10n);
    });
  });

  describe("fee exemption", function () {
    it("adapter shields without fee when privileged", async function () {
      const amount = ethers.parseUnits("500", 6);
      const root = await shieldAndGetRoot(amount);

      const npk = validNpk();
      const encryptedBundle: [string, string, string] = [
        ethers.keccak256(ethers.toUtf8Bytes("enc-fee")),
        ethers.keccak256(ethers.toUtf8Bytes("enc-fee2")),
        ethers.keccak256(ethers.toUtf8Bytes("enc-fee3")),
      ];
      const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("key-fee"));
      const adaptParams = encodeYieldAdaptParams(npk, encryptedBundle, shieldKey);

      const tx = await makeLendTransaction({
        merkleRoot: root,
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("null-fee-exempt")),
        unshieldPreimage: {
          npk: ethers.zeroPadValue(adapterAddress, 32),
          tokenAddress: usdcAddress,
          value: amount,
        },
        adaptContract: adapterAddress,
        adaptParams,
        npk,
        encryptedBundle,
        shieldKey,
      });

      const treasuryBefore = await hubUsdc.balanceOf(deployerAddress);

      await armadaYieldAdapter.lendAndShield(tx, npk, { encryptedBundle, shieldKey });

      const treasuryAfter = await hubUsdc.balanceOf(deployerAddress);
      expect(treasuryAfter - treasuryBefore).to.equal(0n);
    });
  });
});
