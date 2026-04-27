// ABOUTME: Tests for native ETH distribution from ArmadaTreasuryGov.
// ABOUTME: Covers happy path, access control, and outflow enforcement under the address(0) sentinel.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const ONE_DAY = 86400;
const THIRTY_DAYS = 30 * ONE_DAY;

const ETH = (n: string) => ethers.parseEther(n);
const ETH_SENTINEL = ethers.ZeroAddress;

describe("Treasury ETH Distribution", function () {
  let treasury: any;
  let deployer: SignerWithAddress;
  let stranger: SignerWithAddress;
  let recipient: SignerWithAddress;

  async function deployTreasury() {
    [deployer, stranger, recipient] = await ethers.getSigners();
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(deployer.address);
    await treasury.waitForDeployment();
  }

  async function fundTreasury(amount: bigint) {
    await deployer.sendTransaction({ to: await treasury.getAddress(), value: amount });
  }

  // Initialize outflow config for ETH using the address(0) sentinel.
  // Effective limit shape: max(bps * balance, absolute), floored by floorAbsolute.
  async function initEthOutflow(opts?: {
    window?: number;
    bps?: number;
    absolute?: bigint;
    floor?: bigint;
  }) {
    const window = opts?.window ?? THIRTY_DAYS;
    const bps = opts?.bps ?? 1000; // 10%
    const absolute = opts?.absolute ?? ETH("100"); // 100 ETH absolute cap
    const floor = opts?.floor ?? ETH("10"); // 10 ETH immutable floor
    await treasury.initOutflowConfig(ETH_SENTINEL, window, bps, absolute, floor);
  }

  beforeEach(async function () {
    await deployTreasury();
  });

  // WHY: Issue #8 — the contract previously had no governed pre-wind-down ETH distribution
  // path. distributeETH must use address(0) as the outflow-accounting sentinel so the same
  // rolling-window machinery applies to ETH as to ERC20s.
  describe("Happy path", function () {
    it("transfers ETH to recipient and emits DirectDistribution(token=address(0))", async function () {
      await fundTreasury(ETH("1000"));
      await initEthOutflow();

      const before = await ethers.provider.getBalance(recipient.address);

      await expect(treasury.distributeETH(recipient.address, ETH("5")))
        .to.emit(treasury, "DirectDistribution")
        .withArgs(ETH_SENTINEL, recipient.address, ETH("5"));

      const after = await ethers.provider.getBalance(recipient.address);
      expect(after - before).to.equal(ETH("5"));
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(ETH("995"));
    });

    // WHY: getOutflowStatus reads via _effectiveParams + balanceOf. For ETH the contract
    // must read address(this).balance instead of IERC20(0).balanceOf to avoid an
    // EXTCODESIZE revert. This pins that the recorded outflow accumulates correctly.
    it("records the outflow under the address(0) bucket for rolling-window accounting", async function () {
      await fundTreasury(ETH("1000"));
      // 10 ETH absolute cap, 0 bps so absolute dominates and the limit is independent of balance.
      await initEthOutflow({ bps: 1, absolute: ETH("10"), floor: ETH("10") });

      await treasury.distributeETH(recipient.address, ETH("4"));
      await treasury.distributeETH(recipient.address, ETH("4"));

      // 8 ETH used; 2 ETH headroom. 3 ETH next call should exceed the cap.
      await expect(
        treasury.distributeETH(recipient.address, ETH("3"))
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow limit exceeded");
    });
  });

  // WHY: distributeETH inherits the same input-validation surface as distribute. These
  // tests pin each revert path so a future refactor cannot silently relax them.
  describe("Input validation", function () {
    beforeEach(async function () {
      await fundTreasury(ETH("100"));
      await initEthOutflow();
    });

    it("rejects zero recipient", async function () {
      await expect(
        treasury.distributeETH(ethers.ZeroAddress, ETH("1"))
      ).to.be.revertedWith("ArmadaTreasuryGov: zero recipient");
    });

    it("rejects zero amount", async function () {
      await expect(
        treasury.distributeETH(recipient.address, 0n)
      ).to.be.revertedWith("ArmadaTreasuryGov: zero amount");
    });

    it("rejects non-owner caller", async function () {
      await expect(
        treasury.connect(stranger).distributeETH(recipient.address, ETH("1"))
      ).to.be.revertedWith("ArmadaTreasuryGov: not owner");
    });

    // WHY: All outflow paths require an initialized config for the token. Without this
    // gate, a fresh deployment would let governance drain ETH at unlimited rate before
    // the limit machinery is even configured.
    it("reverts if no outflow config has been initialized for ETH", async function () {
      await deployTreasury();
      await fundTreasury(ETH("100"));
      // No initOutflowConfig(address(0), ...)
      await expect(
        treasury.distributeETH(recipient.address, ETH("1"))
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow config required");
    });
  });

  // WHY: The bps-based portion of the limit reads the treasury's spot balance. For ETH
  // that means address(this).balance, not IERC20(0).balanceOf — a difference that would
  // otherwise cause every distributeETH call to revert at the EXTCODESIZE check.
  describe("Outflow enforcement", function () {
    it("uses percentage limit on large treasury (pct > absolute)", async function () {
      // 1000 ETH treasury, 10% = 100 ETH > 50 ETH absolute → effective limit = 100 ETH
      await fundTreasury(ETH("1000"));
      await initEthOutflow({ bps: 1000, absolute: ETH("50"), floor: ETH("10") });

      // 90 ETH should succeed (under the 100 ETH pct limit)
      await treasury.distributeETH(recipient.address, ETH("90"));

      // 11 more would exceed (90 + 11 = 101 > 100)
      await expect(
        treasury.distributeETH(recipient.address, ETH("11"))
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow limit exceeded");
    });

    it("uses absolute limit on small treasury (absolute > pct)", async function () {
      // 100 ETH treasury, 10% = 10 ETH < 50 ETH absolute → effective limit = 50 ETH
      await fundTreasury(ETH("100"));
      await initEthOutflow({ bps: 1000, absolute: ETH("50"), floor: ETH("10") });

      await treasury.distributeETH(recipient.address, ETH("40"));

      // 11 more would exceed (40 + 11 = 51 > 50)
      await expect(
        treasury.distributeETH(recipient.address, ETH("11"))
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow limit exceeded");
    });

    // WHY: Rolling-window semantics — once the window passes, prior outflows fall off
    // the running sum and budget refreshes. Same behavior as ERC20 distribute().
    it("refreshes available budget after the rolling window expires", async function () {
      await fundTreasury(ETH("1000"));
      await initEthOutflow({ bps: 1, absolute: ETH("50"), floor: ETH("10") });

      await treasury.distributeETH(recipient.address, ETH("50"));

      // Advance past the 30-day window
      await time.increase(THIRTY_DAYS + 1);

      // Should be able to spend the full limit again (old record dropped from sum)
      await treasury.distributeETH(recipient.address, ETH("50"));
    });
  });
});
