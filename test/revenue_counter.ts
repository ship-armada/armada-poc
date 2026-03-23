// ABOUTME: Tests for RevenueCounter — UUPS upgradeable monotonic revenue tracker.
// ABOUTME: Covers sync from fee collector, governance attestation, upgrade safety, and access control.

/**
 * RevenueCounter Tests (Tasks 6.1, 6.2)
 *
 * RevenueCounter is a UUPS-upgradeable contract that maintains a monotonic
 * cumulative revenue counter (in 18-decimal USD). Revenue enters via two paths:
 *   1. syncStablecoinRevenue() — permissionless, reads from a fee collector
 *   2. attestRevenue() — governance-only, for off-chain or non-USDC revenue
 *
 * The counter is used by downstream systems (wind-down triggers, token unlocks)
 * to gate actions on cumulative protocol revenue.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("RevenueCounter", function () {
  let revenueCounter: any;
  let mockFeeCollector: any;

  let owner: SignerWithAddress; // timelock (governance)
  let alice: SignerWithAddress; // random user
  let bob: SignerWithAddress;

  // Deploy RevenueCounter behind an ERC1967Proxy (UUPS pattern)
  async function deployProxy() {
    [owner, alice, bob] = await ethers.getSigners();

    // Deploy mock fee collector
    const MockFeeCollector = await ethers.getContractFactory("MockFeeCollector");
    mockFeeCollector = await MockFeeCollector.deploy();
    await mockFeeCollector.waitForDeployment();

    // Deploy implementation
    const RevenueCounter = await ethers.getContractFactory("RevenueCounter");
    const impl = await RevenueCounter.deploy();
    await impl.waitForDeployment();

    // Deploy ERC1967Proxy pointing to implementation, calling initialize()
    const initData = RevenueCounter.interface.encodeFunctionData("initialize", [owner.address]);
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();

    // Attach RevenueCounter ABI to proxy address
    revenueCounter = RevenueCounter.attach(await proxy.getAddress());
  }

  beforeEach(async function () {
    await deployProxy();
  });

  // ============================================================
  // 1. Initialization
  // ============================================================

  describe("Initialization", function () {
    it("should initialize with zero revenue", async function () {
      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(0);
    });

    it("should set owner correctly", async function () {
      expect(await revenueCounter.owner()).to.equal(owner.address);
    });

    it("should not allow re-initialization", async function () {
      await expect(
        revenueCounter.initialize(alice.address)
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });
  });

  // ============================================================
  // 2. syncStablecoinRevenue
  // ============================================================

  describe("syncStablecoinRevenue", function () {
    beforeEach(async function () {
      await revenueCounter.setFeeCollector(await mockFeeCollector.getAddress());
    });

    it("should read fee collector and increment revenue counter", async function () {
      // Fee collector reports 50,000 USDC (6 decimals)
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("50000", 6));

      await revenueCounter.syncStablecoinRevenue();

      // Revenue should be scaled to 18 decimals: 50,000 * 1e12 = 50,000e18
      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(
        ethers.parseUnits("50000", 18)
      );
    });

    it("should compute delta correctly on subsequent syncs", async function () {
      // First sync: 50K USDC
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("50000", 6));
      await revenueCounter.syncStablecoinRevenue();

      // Second sync: fee collector now at 120K USDC (delta = 70K)
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("120000", 6));
      await revenueCounter.syncStablecoinRevenue();

      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(
        ethers.parseUnits("120000", 18)
      );
    });

    it("should be a no-op if no new fees since last sync", async function () {
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("50000", 6));
      await revenueCounter.syncStablecoinRevenue();

      // Sync again with no change
      await revenueCounter.syncStablecoinRevenue();

      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(
        ethers.parseUnits("50000", 18)
      );
    });

    it("should be callable by anyone (permissionless)", async function () {
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("10000", 6));

      // Alice (non-owner) can sync
      await revenueCounter.connect(alice).syncStablecoinRevenue();

      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(
        ethers.parseUnits("10000", 18)
      );
    });

    it("should revert if no fee collector is set", async function () {
      // Deploy a fresh counter without setting fee collector
      const RevenueCounter = await ethers.getContractFactory("RevenueCounter");
      const impl = await RevenueCounter.deploy();
      await impl.waitForDeployment();

      const initData = RevenueCounter.interface.encodeFunctionData("initialize", [owner.address]);
      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), initData);
      await proxy.waitForDeployment();

      const freshCounter = RevenueCounter.attach(await proxy.getAddress());

      await expect(
        freshCounter.syncStablecoinRevenue()
      ).to.be.revertedWith("RevenueCounter: no fee collector");
    });

    it("should scale USDC 6-decimal to 18-decimal USD correctly", async function () {
      // 1 USDC = 1e6. Should become 1e18 USD.
      await mockFeeCollector.setCumulativeFees(1_000_000n); // 1 USDC

      await revenueCounter.syncStablecoinRevenue();

      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(
        ethers.parseUnits("1", 18)
      );
    });

    it("should emit RevenueUpdated event on sync", async function () {
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("50000", 6));

      await expect(revenueCounter.syncStablecoinRevenue())
        .to.emit(revenueCounter, "RevenueUpdated")
        .withArgs(ethers.parseUnits("50000", 18), 0);
    });
  });

  // ============================================================
  // 3. attestRevenue
  // ============================================================

  describe("attestRevenue", function () {
    it("should allow owner to attest revenue", async function () {
      const amount = ethers.parseUnits("100000", 18); // $100K
      await revenueCounter.attestRevenue(amount);

      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(amount);
    });

    it("should be monotonic — cannot decrease", async function () {
      const first = ethers.parseUnits("100000", 18);
      await revenueCounter.attestRevenue(first);

      // Attestation below current should revert
      await expect(
        revenueCounter.attestRevenue(ethers.parseUnits("50000", 18))
      ).to.be.revertedWith("RevenueCounter: not monotonic");
    });

    it("should be a no-op if attesting same value", async function () {
      const amount = ethers.parseUnits("100000", 18);
      await revenueCounter.attestRevenue(amount);

      // Same value — should not revert, just no-op
      await revenueCounter.attestRevenue(amount);

      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(amount);
    });

    it("should reject attestation from non-owner", async function () {
      await expect(
        revenueCounter.connect(alice).attestRevenue(ethers.parseUnits("100000", 18))
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should emit RevenueUpdated event on attestation", async function () {
      const amount = ethers.parseUnits("100000", 18);
      await expect(revenueCounter.attestRevenue(amount))
        .to.emit(revenueCounter, "RevenueUpdated")
        .withArgs(amount, 0);
    });

    it("should combine with synced revenue", async function () {
      // Sync 50K from fee collector
      await revenueCounter.setFeeCollector(await mockFeeCollector.getAddress());
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("50000", 6));
      await revenueCounter.syncStablecoinRevenue();

      // Attest to $200K total (includes $50K synced + $150K off-chain)
      const total = ethers.parseUnits("200000", 18);
      await revenueCounter.attestRevenue(total);

      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(total);
    });
  });

  // ============================================================
  // 4. setFeeCollector
  // ============================================================

  describe("setFeeCollector", function () {
    it("should allow owner to set fee collector", async function () {
      await revenueCounter.setFeeCollector(await mockFeeCollector.getAddress());
      expect(await revenueCounter.feeCollector()).to.equal(await mockFeeCollector.getAddress());
    });

    it("should reject setFeeCollector from non-owner", async function () {
      await expect(
        revenueCounter.connect(alice).setFeeCollector(await mockFeeCollector.getAddress())
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should allow changing fee collector", async function () {
      await revenueCounter.setFeeCollector(await mockFeeCollector.getAddress());

      // Deploy second fee collector
      const MockFeeCollector = await ethers.getContractFactory("MockFeeCollector");
      const secondCollector = await MockFeeCollector.deploy();
      await secondCollector.waitForDeployment();

      await revenueCounter.setFeeCollector(await secondCollector.getAddress());
      expect(await revenueCounter.feeCollector()).to.equal(await secondCollector.getAddress());
    });
  });

  // ============================================================
  // 5. UUPS Upgrade
  // ============================================================

  describe("UUPS Upgrade", function () {
    it("should preserve state across upgrade", async function () {
      // Set some state
      await revenueCounter.setFeeCollector(await mockFeeCollector.getAddress());
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("75000", 6));
      await revenueCounter.syncStablecoinRevenue();

      const revenueBefore = await revenueCounter.recognizedRevenueUsd();
      expect(revenueBefore).to.equal(ethers.parseUnits("75000", 18));

      // Deploy new implementation
      const RevenueCounterV2 = await ethers.getContractFactory("RevenueCounter");
      const newImpl = await RevenueCounterV2.deploy();
      await newImpl.waitForDeployment();

      // Upgrade via UUPS (owner calls upgradeToAndCall)
      await revenueCounter.upgradeTo(await newImpl.getAddress());

      // State should be preserved
      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(revenueBefore);
      expect(await revenueCounter.feeCollector()).to.equal(await mockFeeCollector.getAddress());
    });

    it("should reject upgrade from non-owner", async function () {
      const RevenueCounterV2 = await ethers.getContractFactory("RevenueCounter");
      const newImpl = await RevenueCounterV2.deploy();
      await newImpl.waitForDeployment();

      await expect(
        revenueCounter.connect(alice).upgradeTo(await newImpl.getAddress())
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });
});
