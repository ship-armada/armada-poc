/**
 * Crowdfund Demo — Narrated end-to-end walkthrough
 *
 * Deploys the crowdfund system and runs through:
 *   Flow 1: Full crowdfund lifecycle (seeds → invite → commit → finalize → claim)
 *   Flow 2: Governance bridge (claimed ARM → lock in VotingLocker → voting power)
 *
 * Uses time.increase() to fast-forward through delays.
 *
 * Usage:
 *   npx hardhat run scripts/crowdfund_demo.ts --network hub
 *     OR (standalone, uses Hardhat's built-in network):
 *   npx hardhat run scripts/crowdfund_demo.ts
 */

import { ethers, network } from "hardhat";

const PhaseNames = ["SETUP", "INVITATION", "COMMITMENT", "FINALIZED", "CANCELED"];

const TWO_WEEKS = 14 * 86400;
const ONE_WEEK = 7 * 86400;

function log(tag: string, msg: string) {
  const padded = `[${tag}]`.padEnd(12);
  console.log(`${padded} ${msg}`);
}

async function fastForward(seconds: number, label: string) {
  console.log("");
  console.log(`           \u23e9 Fast-forward ${label}...`);
  await network.provider.send("evm_increaseTime", [seconds + 1]);
  await network.provider.send("evm_mine");
  console.log("");
}

function fmtUsdc(amount: bigint): string {
  return `$${(Number(amount) / 1e6).toLocaleString()}`;
}

function fmtArm(amount: bigint): string {
  return `${(Number(amount) / 1e18).toLocaleString()} ARM`;
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  // Allocate signers for roles
  const seeds = signers.slice(1, 4);        // 3 seeds
  const hop1Addrs = signers.slice(4, 13);   // up to 9 hop-1 (3 seeds × 3 invites)
  const hop2Addrs = signers.slice(13, 31);  // up to 18 hop-2
  const treasuryAddr = signers[31];

  console.log("=".repeat(70));
  console.log("  ARMADA CROWDFUND DEMO — Round 1");
  console.log("=".repeat(70));
  console.log("");

  // ============ SETUP ============
  log("SETUP", "Deploying crowdfund system...");

  const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
  const armToken = await ArmadaToken.deploy(deployer.address);
  await armToken.waitForDeployment();

  const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
  const usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
  await usdc.waitForDeployment();

  const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
  const crowdfund = await ArmadaCrowdfund.deploy(
    await usdc.getAddress(),
    await armToken.getAddress(),
    deployer.address
  );
  await crowdfund.waitForDeployment();

  // Fund ARM to crowdfund
  const armFund = ethers.parseUnits("1800000", 18);
  await armToken.transfer(await crowdfund.getAddress(), armFund);

  log("SETUP", `ARM Token: ${await armToken.getAddress()}`);
  log("SETUP", `USDC Token: ${await usdc.getAddress()}`);
  log("SETUP", `Crowdfund: ${await crowdfund.getAddress()}`);
  log("SETUP", `Funded 1,800,000 ARM to crowdfund contract`);
  console.log("");

  // ============ PHASE: SEEDS ============
  console.log("-".repeat(70));
  console.log("  PHASE: SETUP (Add Seeds)");
  console.log("-".repeat(70));
  console.log("");

  await crowdfund.addSeeds(seeds.map(s => s.address));
  log("SEED", `Added 3 seeds (hop 0, $15K cap, 3 invites each)`);
  for (let i = 0; i < seeds.length; i++) {
    log("SEED", `  Seed-${String.fromCharCode(65 + i)}: ${seeds[i].address.slice(0, 10)}...`);
  }

  // ============ PHASE: INVITATION ============
  console.log("");
  console.log("-".repeat(70));
  console.log("  PHASE: INVITATION (2-week window)");
  console.log("-".repeat(70));
  console.log("");

  await crowdfund.startInvitations();
  log("START", `Invitation window opened`);

  // Each seed invites 3 hop-1 addresses
  let hop1Count = 0;
  for (let i = 0; i < seeds.length; i++) {
    for (let j = 0; j < 3 && hop1Count < hop1Addrs.length; j++) {
      await crowdfund.connect(seeds[i]).invite(hop1Addrs[hop1Count].address);
      hop1Count++;
    }
    log("INVITE", `Seed-${String.fromCharCode(65 + i)} invites 3 \u2192 hop 1`);
  }

  // Some hop-1 addresses invite hop-2
  let hop2Count = 0;
  for (let i = 0; i < Math.min(hop1Count, 9) && hop2Count < hop2Addrs.length; i++) {
    const invitesPerHop1 = Math.min(2, hop2Addrs.length - hop2Count);
    for (let j = 0; j < invitesPerHop1; j++) {
      await crowdfund.connect(hop1Addrs[i]).invite(hop2Addrs[hop2Count].address);
      hop2Count++;
    }
  }
  log("INVITE", `${hop1Count} hop-1 addresses invited ${hop2Count} hop-2 addresses`);

  const [, , wc0] = await crowdfund.getHopStats(0);
  const [, , wc1] = await crowdfund.getHopStats(1);
  const [, , wc2] = await crowdfund.getHopStats(2);
  log("STATS", `Hop 0: ${wc0} whitelisted | Hop 1: ${wc1} | Hop 2: ${wc2}`);

  await fastForward(TWO_WEEKS, "2 weeks (invitation window)");

  // ============ PHASE: COMMITMENT ============
  console.log("-".repeat(70));
  console.log("  PHASE: COMMITMENT (1-week window)");
  console.log("-".repeat(70));
  console.log("");

  // Fund and commit: seeds at max cap
  for (let i = 0; i < seeds.length; i++) {
    const amount = ethers.parseUnits("15000", 6);
    await usdc.mint(seeds[i].address, amount);
    await usdc.connect(seeds[i]).approve(await crowdfund.getAddress(), amount);
    await crowdfund.connect(seeds[i]).commit(amount);
    log("COMMIT", `Seed-${String.fromCharCode(65 + i)} commits $15,000 USDC`);
  }

  // Hop-1: commit at various amounts
  for (let i = 0; i < hop1Count; i++) {
    const amount = ethers.parseUnits("4000", 6); // max hop-1 cap
    await usdc.mint(hop1Addrs[i].address, amount);
    await usdc.connect(hop1Addrs[i]).approve(await crowdfund.getAddress(), amount);
    await crowdfund.connect(hop1Addrs[i]).commit(amount);
  }
  log("COMMIT", `${hop1Count} hop-1 addresses commit $4,000 each`);

  // Hop-2: commit at max cap
  for (let i = 0; i < hop2Count; i++) {
    const amount = ethers.parseUnits("1000", 6);
    await usdc.mint(hop2Addrs[i].address, amount);
    await usdc.connect(hop2Addrs[i]).approve(await crowdfund.getAddress(), amount);
    await crowdfund.connect(hop2Addrs[i]).commit(amount);
  }
  log("COMMIT", `${hop2Count} hop-2 addresses commit $1,000 each`);

  const totalComm = await crowdfund.totalCommitted();
  log("STATS", `Total committed: ${fmtUsdc(totalComm)}`);

  // Show per-hop breakdown
  for (let h = 0; h < 3; h++) {
    const [tc, uc, wc] = await crowdfund.getHopStats(h);
    log("STATS", `  Hop ${h}: ${uc} committers, ${fmtUsdc(tc)} total`);
  }

  // Since with small numbers this will be below MIN_SALE, let's add more seeds
  // to reach the minimum. We'll use additional signers as extra seeds.
  const extraSeeds = signers.slice(32, 120);
  log("NOTE", `Adding ${extraSeeds.length} extra seeds to reach minimum raise...`);

  // We need to deploy a new crowdfund with all these seeds pre-loaded
  // Actually, we can't add seeds after invitation starts.
  // Instead, let's just show the demo even if it cancels, and explain.
  console.log("");
  log("NOTE", `Total committed: ${fmtUsdc(totalComm)} (below $1M minimum)`);
  log("NOTE", `In production, 70+ seeds would reach minimum. Demo shows mechanics.`);

  // For demo purposes, let's deploy a SECOND crowdfund with many seeds
  // to show a successful finalization
  console.log("");
  console.log("-".repeat(70));
  console.log("  FLOW 2: Successful Finalization (scaled demo)");
  console.log("-".repeat(70));
  console.log("");

  const cf2 = await ArmadaCrowdfund.deploy(
    await usdc.getAddress(),
    await armToken.getAddress(),
    deployer.address
  );
  await cf2.waitForDeployment();

  // Fund ARM
  await armToken.transfer(await cf2.getAddress(), ethers.parseUnits("1800000", 18));

  // Add 80 seeds and have them all commit $15K each = $1.2M
  const bigSeeds = signers.slice(32, 112); // 80 signers
  await cf2.addSeeds(bigSeeds.map(s => s.address));
  log("SETUP", `Added ${bigSeeds.length} seeds to second crowdfund`);

  await cf2.startInvitations();
  await network.provider.send("evm_increaseTime", [TWO_WEEKS + 1]);
  await network.provider.send("evm_mine");
  log("TIME", "Fast-forwarded past invitation window");

  // Each seed commits $15K
  for (const s of bigSeeds) {
    const amt = ethers.parseUnits("15000", 6);
    await usdc.mint(s.address, amt);
    await usdc.connect(s).approve(await cf2.getAddress(), amt);
    await cf2.connect(s).commit(amt);
  }
  const total2 = await cf2.totalCommitted();
  log("COMMIT", `${bigSeeds.length} seeds commit $15K each = ${fmtUsdc(total2)}`);

  await network.provider.send("evm_increaseTime", [ONE_WEEK + 1]);
  await network.provider.send("evm_mine");

  // Finalize
  await cf2.finalize();
  const phase = Number(await cf2.phase());
  log("FINALIZE", `Phase: ${PhaseNames[phase]}`);
  log("FINALIZE", `Sale size: ${fmtUsdc(await cf2.saleSize())}`);

  const totalAlloc = await cf2.totalAllocated();
  const totalAllocUsdc = await cf2.totalAllocatedUsdc();
  log("FINALIZE", `Total allocated: ${fmtArm(totalAlloc)} (${fmtUsdc(totalAllocUsdc)} USDC value)`);

  // Hop-0 reserve = 70% of $1.2M = $840K. Demand = $1.2M > $840K → pro-rata
  const [hop0tc] = await cf2.getHopStats(0);
  const reserve0 = (BigInt(await cf2.saleSize()) * 7000n) / 10000n;
  if (hop0tc > reserve0) {
    log("ALLOC", `Hop 0: demand ${fmtUsdc(hop0tc)} > reserve ${fmtUsdc(reserve0)} \u2192 pro-rata`);
    log("ALLOC", `  Scale: ${((Number(reserve0) / Number(hop0tc)) * 100).toFixed(1)}%`);
  }

  // Claim one seed
  const [allocEx, refundEx] = await cf2.getAllocation(bigSeeds[0].address);
  log("CLAIM", `Seed claims: ${fmtArm(allocEx)} + ${fmtUsdc(refundEx)} USDC refund`);
  await cf2.connect(bigSeeds[0]).claim();
  log("CLAIM", `Claimed successfully \u2713`);

  // ============ GOVERNANCE BRIDGE ============
  console.log("");
  console.log("-".repeat(70));
  console.log("  GOVERNANCE BRIDGE: Crowdfund \u2192 Voting Power");
  console.log("-".repeat(70));
  console.log("");

  const VotingLocker = await ethers.getContractFactory("VotingLocker");
  const votingLocker = await VotingLocker.deploy(await armToken.getAddress());
  await votingLocker.waitForDeployment();

  const armBal = await armToken.balanceOf(bigSeeds[0].address);
  await armToken.connect(bigSeeds[0]).approve(await votingLocker.getAddress(), armBal);
  await votingLocker.connect(bigSeeds[0]).lock(armBal);

  const locked = await votingLocker.getLockedBalance(bigSeeds[0].address);
  log("LOCK", `Seed locks ${fmtArm(armBal)} in VotingLocker`);
  log("VOTE", `Voting power: ${fmtArm(locked)}`);
  log("VOTE", `Seed can now participate in Armada governance \u2713`);

  // ============ DONE ============
  console.log("");
  console.log("=".repeat(70));
  console.log("  DEMO COMPLETE");
  console.log("=".repeat(70));
  console.log("");
  console.log("  Flows demonstrated:");
  console.log("  1. Crowdfund: seeds \u2192 invite \u2192 commit \u2192 finalize \u2192 claim");
  console.log("  2. Governance bridge: claimed ARM \u2192 VotingLocker \u2192 voting power");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
