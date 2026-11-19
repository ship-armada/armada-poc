// ABOUTME: Tests that claim() atomically delegates ARM voting power via delegateOnBehalf.
// ABOUTME: Covers delegation after claim, zero-allocation skip, and delegate-to-self.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

describe("Crowdfund: Atomic Delegation on Claim", function () {
  let deployer: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let securityCouncil: HardhatEthersSigner;
  let delegateTarget: HardhatEthersSigner;
  let allSigners: HardhatEthersSigner[];
  let usdc: any;
  let armToken: any;

  async function fundAndApprove(signer: HardhatEthersSigner, amount: bigint, cf: any) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await cf.getAddress(), amount);
  }

  async function deployCrowdfund() {
    const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
    const openTimestamp = (await time.latest()) + 300;
    const crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasury.address,
      deployer.address,         // launchTeam
      securityCouncil.address,
      openTimestamp
    );
    await crowdfund.waitForDeployment();

    // Whitelist crowdfund for ARM transfers and authorize for delegateOnBehalf
    const cfAddr = await crowdfund.getAddress();
    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);

    // Fund ARM and verify pre-load
    await armToken.transfer(cfAddr, ARM(1_800_000));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());
    return crowdfund;
  }

  // Minimal scenario: 70 seeds committing $15k each ($1.05M) — clears MIN_SALE ($250K) and
  // fits the $1.8M sale, so every seed is allocated its full commitment.
  async function setupAndFinalize(crowdfund: any) {
    const seeds = allSigners.slice(5, 75); // 70 seeds
    await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));

    for (const s of seeds) {
      await fundAndApprove(s, USDC(15_000), crowdfund);
      await crowdfund.connect(s).commit(0, USDC(15_000));
    }

    await time.increaseTo((await crowdfund.windowEnd()) + 1n);
    await crowdfund.finalize();

    return { seeds };
  }

  beforeEach(async function () {
    allSigners = await ethers.getSigners();
    deployer = allSigners[0];
    treasury = allSigners[1];
    securityCouncil = allSigners[2];
    delegateTarget = allSigners[3];

    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
    await armToken.waitForDeployment();
    await armToken.initWhitelist([deployer.address]);
  });

  it("claim() delegates voting power to specified delegate", async function () {
    const crowdfund = await deployCrowdfund();
    const { seeds } = await setupAndFinalize(crowdfund);

    const claimant = seeds[0];
    const [allocArm] = await crowdfund.computeAllocation(claimant.address);
    expect(allocArm).to.be.gt(0n);

    // Before claim: no delegation
    expect(await armToken.delegates(claimant.address)).to.equal(ethers.ZeroAddress);

    await crowdfund.connect(claimant).claim(delegateTarget.address);

    // After claim: voting power delegated to target
    expect(await armToken.delegates(claimant.address)).to.equal(delegateTarget.address);
    expect(await armToken.getVotes(delegateTarget.address)).to.equal(allocArm);
  });

  it("claim() with self-delegation works", async function () {
    const crowdfund = await deployCrowdfund();
    const { seeds } = await setupAndFinalize(crowdfund);

    const claimant = seeds[1];
    await crowdfund.connect(claimant).claim(claimant.address);

    expect(await armToken.delegates(claimant.address)).to.equal(claimant.address);
    expect(await armToken.getVotes(claimant.address)).to.be.gt(0n);
  });

  it("claim(address(0)) reverts — delegation is mandatory", async function () {
    const crowdfund = await deployCrowdfund();
    const { seeds } = await setupAndFinalize(crowdfund);

    const claimant = seeds[2];
    await expect(
      crowdfund.connect(claimant).claim(ethers.ZeroAddress)
    ).to.be.revertedWith("ArmadaCrowdfund: delegate required");
  });
});
