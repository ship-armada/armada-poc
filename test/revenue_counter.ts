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

    // WHY: A misdeploy that passes address(0) as the owner would leave the
    // contract ungovernable. _transferOwnership in OZ Ownable does NOT reject
    // address(0) (it's used internally for renounceOwnership), so the explicit
    // check at the top of initialize is the only defense.
    it("should reject zero owner", async function () {
      const RevenueCounter = await ethers.getContractFactory("RevenueCounter");
      const impl = await RevenueCounter.deploy();
      await impl.waitForDeployment();
      const initData = RevenueCounter.interface.encodeFunctionData("initialize", [
        ethers.ZeroAddress,
      ]);
      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await impl.getAddress(), initData)
      ).to.be.revertedWith("RevenueCounter: zero owner");
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

    // WHY: audit-18 — the live ArmadaFeeModule is monotonic by construction,
    // but the contract still subtracts unguarded. A regressed collector
    // (replacement implementation, storage corruption) would brick all
    // permissionless syncs via 0.8.x underflow revert. The saturating-delta
    // guard advances the baseline to track the new (lower) collector value
    // without decreasing recognizedRevenueUsd (still monotonic by spec) and
    // without reverting.
    it("should not revert when collector reports a lower cumulative (regression)", async function () {
      // Establish a baseline at 100K.
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("100000", 6));
      await revenueCounter.syncStablecoinRevenue();
      expect(await revenueCounter.lastSyncedCumulative()).to.equal(
        ethers.parseUnits("100000", 6)
      );

      // Collector regresses to 80K (e.g. replacement collector that hasn't
      // accumulated as much yet). The previous behavior would underflow.
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("80000", 6));
      await expect(revenueCounter.syncStablecoinRevenue()).to.not.be.reverted;

      // Baseline tracks the new lower value; recognized counter unchanged.
      expect(await revenueCounter.lastSyncedCumulative()).to.equal(
        ethers.parseUnits("80000", 6)
      );
      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(
        ethers.parseUnits("100000", 18)
      );
    });

    // WHY: After a regression resets the baseline, future legitimate increments
    // from the new (lower) baseline must be captured correctly. Verifies the
    // baseline-reset path doesn't strand future revenue.
    it("should capture future increments correctly after a regression", async function () {
      // Sync to 100K.
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("100000", 6));
      await revenueCounter.syncStablecoinRevenue();

      // Regression to 80K — recognized stays at 100K, baseline resets to 80K.
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("80000", 6));
      await revenueCounter.syncStablecoinRevenue();
      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(
        ethers.parseUnits("100000", 18)
      );

      // New collector (or recovering collector) accrues to 110K. Delta from
      // the 80K baseline is 30K, which adds to recognized → 130K total.
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("110000", 6));
      await revenueCounter.syncStablecoinRevenue();
      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(
        ethers.parseUnits("130000", 18)
      );
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
  // 3b. addRevenue (increment-style, routine non-stable path)
  // ============================================================

  describe("addRevenue", function () {
    // WHY: addRevenue is the routine non-stable revenue path. Increment semantics
    // mean the proposer commits a delta they can verify against on-chain receipts;
    // the contract integrates it without overwriting concurrent stable accrual.
    it("should increment recognizedRevenueUsd by deltaUsd", async function () {
      await revenueCounter.addRevenue(ethers.parseUnits("100", 18));
      expect(await revenueCounter.recognizedRevenueUsd())
        .to.equal(ethers.parseUnits("100", 18));

      await revenueCounter.addRevenue(ethers.parseUnits("50", 18));
      expect(await revenueCounter.recognizedRevenueUsd())
        .to.equal(ethers.parseUnits("150", 18));
    });

    // WHY: Zero-delta no-op matches the attestRevenue same-value early-return —
    // gas-cheap and avoids spurious RevenueUpdated events.
    it("should be a no-op for zero delta (no event emitted)", async function () {
      await revenueCounter.addRevenue(ethers.parseUnits("200", 18));

      await expect(revenueCounter.addRevenue(0))
        .to.not.emit(revenueCounter, "RevenueUpdated");

      expect(await revenueCounter.recognizedRevenueUsd())
        .to.equal(ethers.parseUnits("200", 18));
    });

    it("should reject calls from non-owner", async function () {
      await expect(
        revenueCounter.connect(alice).addRevenue(ethers.parseUnits("100", 18))
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should emit RevenueUpdated event with correct values", async function () {
      await revenueCounter.addRevenue(ethers.parseUnits("100", 18));

      await expect(revenueCounter.addRevenue(ethers.parseUnits("50", 18)))
        .to.emit(revenueCounter, "RevenueUpdated")
        .withArgs(ethers.parseUnits("150", 18), ethers.parseUnits("100", 18));
    });

    // WHY: The core bug-fix property. attestRevenue's SET semantics race against
    // permissionless syncStablecoinRevenue: any stable accrual synced during a
    // proposal's lifecycle is silently overwritten by the SET, and is NOT
    // re-credited because lastSyncedCumulative is not touched. addRevenue's
    // increment semantics commute with concurrent syncs — stable and non-stable
    // streams integrate independently into the same counter without loss.
    // (See audit-80 PoC test_attestRevenue_permanently_overwrites_concurrent_stable_sync.)
    it("should be commutative with concurrent syncStablecoinRevenue (no leak)", async function () {
      await revenueCounter.setFeeCollector(await mockFeeCollector.getAddress());

      // Step 1: stable accrues to $800, sync.
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("800", 6));
      await revenueCounter.syncStablecoinRevenue();
      // counter = $800, lastSync = $800.

      // Step 2: non-stable attestation +$200 (e.g. ETH receipt).
      await revenueCounter.addRevenue(ethers.parseUnits("200", 18));
      // counter = $1000, lastSync = $800 (unchanged — addRevenue doesn't touch sync).

      // Step 3: stable advances to $850 during a future proposal's window. Sync.
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("850", 6));
      await revenueCounter.syncStablecoinRevenue();
      // counter = $1050, lastSync = $850.

      // Step 4: another non-stable attestation +$100.
      await revenueCounter.addRevenue(ethers.parseUnits("100", 18));
      // counter = $1150.

      // Step 5: stable advances to $950, sync.
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("950", 6));
      await revenueCounter.syncStablecoinRevenue();
      // counter = $1250 ($1150 + $100 stable delta).

      // Truth check: stable contributed $950, non-stable $300 → expected $1250.
      expect(await revenueCounter.recognizedRevenueUsd())
        .to.equal(ethers.parseUnits("1250", 18));
      // Compare against the audit-80 PoC: under attestRevenue (SET), an
      // analogous interleave would have leaked the inter-attestation stable
      // accrual permanently. addRevenue does not.
    });

    // WHY: After wind-down trigger, the counter is frozen. addRevenue must
    // respect the same gate as attestRevenue / syncStablecoinRevenue.
    it("should revert when counter is frozen", async function () {
      // Bootstrap a wind-down contract authorized to call freeze.
      await revenueCounter.setWindDownContract(alice.address);
      await revenueCounter.connect(alice).freeze();

      await expect(
        revenueCounter.addRevenue(ethers.parseUnits("100", 18))
      ).to.be.revertedWith("RevenueCounter: frozen");
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

    // WHY: audit-18 — setFeeCollector exists specifically to recover from a
    // compromised or misbehaving collector. If the old collector regresses,
    // the inline sync inside setFeeCollector previously underflowed and blocked
    // the recovery itself. The saturating-delta guard ensures the function
    // always succeeds; recognizedRevenueUsd is left unchanged on regression
    // (monotonic by spec) and lastSyncedCumulative resets to the new
    // collector's value on the next line below the guard.
    it("should not revert when rotating away from a regressed collector", async function () {
      // Establish a baseline: old collector at 100K, recognized = 100K.
      await revenueCounter.setFeeCollector(await mockFeeCollector.getAddress());
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("100000", 6));
      await revenueCounter.syncStablecoinRevenue();

      // Old collector regresses (e.g. malicious upgrade resets its counter).
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("60000", 6));

      // Deploy fresh replacement collector at 0.
      const MockFeeCollector = await ethers.getContractFactory("MockFeeCollector");
      const replacement = await MockFeeCollector.deploy();
      await replacement.waitForDeployment();

      // Rotation must succeed despite the old collector's regression.
      await expect(
        revenueCounter.setFeeCollector(await replacement.getAddress())
      ).to.not.be.reverted;

      // recognizedRevenueUsd is preserved (monotonic).
      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(
        ethers.parseUnits("100000", 18)
      );
      // Baseline is set from the new collector's current value (0).
      expect(await revenueCounter.lastSyncedCumulative()).to.equal(0);
      expect(await revenueCounter.feeCollector()).to.equal(await replacement.getAddress());
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
