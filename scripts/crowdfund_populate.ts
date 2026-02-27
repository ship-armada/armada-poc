// ABOUTME: CLI script to populate a deployed crowdfund with enough commitments to reach a target.
// ABOUTME: Uses Hardhat signers as ephemeral participants. Local Anvil only.
/**
 * Crowdfund Populate — Fill a deployed crowdfund to a target commitment level
 *
 * Loads the existing deployment from deployments/crowdfund-hub.json and runs
 * through the full lifecycle: add seeds → start invitations → (optional hops)
 * → advance time → mint USDC → commit → advance past commitment.
 *
 * Leaves the contract ready for admin to finalize via the UI or CLI.
 *
 * Environment variables:
 *   TARGET  - Target total in whole USDC (default: 1050000 = just above $1M MIN_SALE)
 *   HOPS    - If "true", also populate hop-1 and hop-2 participants (default: false)
 *
 * Usage:
 *   npx hardhat run scripts/crowdfund_populate.ts --network hub
 *   TARGET=1200000 npx hardhat run scripts/crowdfund_populate.ts --network hub
 *   TARGET=1800000 HOPS=true npx hardhat run scripts/crowdfund_populate.ts --network hub
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getCrowdfundDeploymentFile } from "../config/networks";

const TWO_WEEKS = 14 * 86400;
const ONE_WEEK = 7 * 86400;

const SEED_CAP = 15_000;  // $15,000 per seed
const HOP1_CAP = 4_000;   // $4,000 per hop-1
const HOP2_CAP = 1_000;   // $1,000 per hop-2

const BATCH_SIZE = 20;
const SEED_BATCH_SIZE = 50; // for addSeeds() calls

function log(tag: string, msg: string) {
  const padded = `[${tag}]`.padEnd(14);
  console.log(`${padded} ${msg}`);
}

function fmtUsdc(amount: bigint): string {
  return `$${(Number(amount) / 1e6).toLocaleString()}`;
}

interface Deployment {
  contracts: {
    armToken: string;
    usdc: string;
    crowdfund: string;
  };
}

function loadDeployment(): Deployment {
  const filename = getCrowdfundDeploymentFile();
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(deploymentsDir, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Deployment file not found: ${filePath}\n` +
      `Run 'npm run setup' first to deploy contracts.`
    );
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

async function main() {
  const targetUsdc = parseInt(process.env.TARGET || "1050000", 10);
  const includeHops = process.env.HOPS === "true";

  console.log("=".repeat(70));
  console.log("  CROWDFUND POPULATE");
  console.log("=".repeat(70));
  console.log("");
  log("CONFIG", `Target: $${targetUsdc.toLocaleString()}`);
  log("CONFIG", `Include hops: ${includeHops}`);
  console.log("");

  // Load deployment
  const deployment = loadDeployment();
  log("DEPLOY", `Crowdfund: ${deployment.contracts.crowdfund}`);
  log("DEPLOY", `USDC: ${deployment.contracts.usdc}`);

  // Get contracts
  const crowdfund = await ethers.getContractAt(
    "ArmadaCrowdfund",
    deployment.contracts.crowdfund
  );
  const usdc = await ethers.getContractAt(
    "MockUSDCV2",
    deployment.contracts.usdc
  );

  // Check phase
  const phase = Number(await crowdfund.phase());
  const PhaseNames = ["SETUP", "INVITATION", "COMMITMENT", "FINALIZED", "CANCELED"];
  if (phase !== 0) {
    throw new Error(
      `Contract is in ${PhaseNames[phase]} phase (expected SETUP).\n` +
      `Redeploy with 'npm run chains && npm run setup' for a fresh contract.`
    );
  }
  log("PHASE", `Current phase: ${PhaseNames[phase]}`);

  // Get signers — Hardhat provides 200 by default
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  // Reserve signers[0] for admin, signers[1-10] for the UI's Anvil accounts
  // Use signers[11+] for generated participants
  const availableSigners = signers.slice(11);

  // UI seed accounts (signers[1-3]) — added as seeds and committed so they
  // appear in the UI dropdown with real participation for testing claims.
  const uiSeeds = signers.slice(1, 4);

  // Calculate participant counts
  let seedCount: number;
  let hop1Count = 0;
  let hop2Count = 0;

  if (includeHops) {
    // With hops: allocate some capacity to each level
    // Each seed can invite 3 hop-1, each hop-1 can invite 2 hop-2
    // Use 3 seeds for invitations, rest as seeds for volume
    const inviteSeeds = 3;
    hop1Count = inviteSeeds * 3; // 9 hop-1
    hop2Count = hop1Count * 2;   // 18 hop-2

    const hop1Total = hop1Count * HOP1_CAP;
    const hop2Total = hop2Count * HOP2_CAP;
    const remainingTarget = Math.max(0, targetUsdc - hop1Total - hop2Total);
    seedCount = Math.max(inviteSeeds, Math.ceil(remainingTarget / SEED_CAP));
  } else {
    seedCount = Math.ceil(targetUsdc / SEED_CAP);
  }

  // Ensure we have enough signers
  const totalParticipants = seedCount + hop1Count + hop2Count;
  if (totalParticipants > availableSigners.length) {
    throw new Error(
      `Need ${totalParticipants} signers but only ${availableSigners.length} available.\n` +
      `Reduce TARGET or increase hardhat accounts count.`
    );
  }

  const seedSigners = availableSigners.slice(0, seedCount);
  const hop1Signers = availableSigners.slice(seedCount, seedCount + hop1Count);
  const hop2Signers = availableSigners.slice(seedCount + hop1Count, seedCount + hop1Count + hop2Count);

  const expectedTotal = (seedCount * SEED_CAP) + (hop1Count * HOP1_CAP) + (hop2Count * HOP2_CAP);
  log("PLAN", `Seeds: ${seedCount} × $${SEED_CAP.toLocaleString()} = $${(seedCount * SEED_CAP).toLocaleString()}`);
  if (includeHops) {
    log("PLAN", `Hop-1: ${hop1Count} × $${HOP1_CAP.toLocaleString()} = $${(hop1Count * HOP1_CAP).toLocaleString()}`);
    log("PLAN", `Hop-2: ${hop2Count} × $${HOP2_CAP.toLocaleString()} = $${(hop2Count * HOP2_CAP).toLocaleString()}`);
  }
  log("PLAN", `Expected total: $${expectedTotal.toLocaleString()}`);
  console.log("");

  // ============ ADD SEEDS ============
  console.log("-".repeat(70));

  // Add UI seed accounts first (signers[1-3]) so they can test claiming via UI
  const uiSeedAddresses = uiSeeds.map(s => s.address);
  const uiSeedTx = await crowdfund.addSeeds(uiSeedAddresses);
  await uiSeedTx.wait();
  log("SEEDS", `Added ${uiSeedAddresses.length} UI seed accounts (for UI testing)`);

  // Add generated seed addresses
  log("SEEDS", `Adding ${seedCount} generated seed addresses...`);
  const seedAddresses = seedSigners.map(s => s.address);
  for (let i = 0; i < seedAddresses.length; i += SEED_BATCH_SIZE) {
    const batch = seedAddresses.slice(i, i + SEED_BATCH_SIZE);
    const tx = await crowdfund.addSeeds(batch);
    await tx.wait();
    log("SEEDS", `  Batch ${Math.floor(i / SEED_BATCH_SIZE) + 1}: added ${batch.length} seeds`);
  }

  // ============ START INVITATIONS ============
  const startTx = await crowdfund.startInvitations();
  await startTx.wait();
  log("PHASE", "Invitation window opened");

  // ============ INVITATIONS (if hops enabled) ============
  if (includeHops) {
    console.log("-".repeat(70));
    log("INVITE", "Sending invitations...");

    // First 3 seeds each invite 3 hop-1 addresses
    let h1idx = 0;
    for (let i = 0; i < 3 && i < seedSigners.length; i++) {
      for (let j = 0; j < 3 && h1idx < hop1Signers.length; j++) {
        const tx = await crowdfund.connect(seedSigners[i]).invite(hop1Signers[h1idx].address);
        await tx.wait();
        h1idx++;
      }
    }
    log("INVITE", `${h1idx} hop-1 addresses invited`);

    // Each hop-1 invites 2 hop-2 addresses
    let h2idx = 0;
    for (let i = 0; i < hop1Signers.length; i++) {
      for (let j = 0; j < 2 && h2idx < hop2Signers.length; j++) {
        const tx = await crowdfund.connect(hop1Signers[i]).invite(hop2Signers[h2idx].address);
        await tx.wait();
        h2idx++;
      }
    }
    log("INVITE", `${h2idx} hop-2 addresses invited`);
  }

  // ============ ADVANCE TO COMMITMENT ============
  console.log("-".repeat(70));

  // Read exact commitment window from contract and jump to it
  const commStart = Number(await crowdfund.commitmentStart());
  const commEnd = Number(await crowdfund.commitmentEnd());
  const curBlock = await ethers.provider.getBlock("latest");
  const curTs = curBlock!.timestamp;
  const jump = commStart - curTs + 1;

  log("TIME", `Advancing to commitment window (${jump}s jump)...`);
  await network.provider.send("evm_increaseTime", [jump]);
  await network.provider.send("evm_mine");

  // ============ MINT + APPROVE + COMMIT ============
  console.log("-".repeat(70));
  log("COMMIT", "Minting USDC and committing...");

  const crowdfundAddr = await crowdfund.getAddress();

  // Helper to process a batch of participants
  async function commitBatch(
    participants: typeof seedSigners,
    capUsdc: number,
    label: string
  ) {
    const amount = ethers.parseUnits(capUsdc.toString(), 6);
    let committed = 0;

    // With Anvil's --block-time 1, `await contract.method()` resolves on tx
    // submission, not mining. Every tx needs an explicit .wait() to ensure
    // it's mined before the next step depends on its state change.
    for (let i = 0; i < participants.length; i += BATCH_SIZE) {
      const batch = participants.slice(i, i + BATCH_SIZE);

      // Mint sequentially — all mints use the deployer signer (shared nonce).
      for (const p of batch) {
        const tx = await usdc.mint(p.address, amount);
        await tx.wait();
      }

      // Approve + commit per participant — sequential to guarantee each
      // approve is mined before its corresponding commit executes.
      for (const p of batch) {
        const appTx = await usdc.connect(p).approve(crowdfundAddr, amount);
        await appTx.wait();
        const cmtTx = await crowdfund.connect(p).commit(amount);
        await cmtTx.wait();
      }

      committed += batch.length;
      if (participants.length > BATCH_SIZE) {
        log("COMMIT", `  ${label}: ${committed}/${participants.length} committed`);
      }
    }
    log("COMMIT", `  ${label}: ${committed} × $${capUsdc.toLocaleString()} = $${(committed * capUsdc).toLocaleString()}`);
  }

  // Commit UI seed accounts (signers[1-3]) so they can test claiming via UI
  await commitBatch(uiSeeds, SEED_CAP, "UI Seeds");

  await commitBatch(seedSigners, SEED_CAP, "Seeds");
  if (includeHops) {
    await commitBatch(hop1Signers, HOP1_CAP, "Hop-1");
    await commitBatch(hop2Signers, HOP2_CAP, "Hop-2");
  }

  // ============ ADVANCE PAST COMMITMENT ============
  console.log("-".repeat(70));
  log("TIME", "Advancing past commitment window (1 week)...");
  await network.provider.send("evm_increaseTime", [ONE_WEEK + 1]);
  await network.provider.send("evm_mine");

  // ============ SUMMARY ============
  console.log("");
  console.log("=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));
  console.log("");

  const totalCommitted = await crowdfund.totalCommitted();
  const finalPhase = Number(await crowdfund.phase());
  log("RESULT", `Total committed: ${fmtUsdc(totalCommitted)}`);
  log("RESULT", `Phase: ${PhaseNames[finalPhase]}`);

  for (let h = 0; h < 3; h++) {
    const [tc, uc, wc] = await crowdfund.getHopStats(h);
    if (Number(wc) > 0) {
      log("STATS", `  Hop ${h}: ${wc} whitelisted, ${uc} committers, ${fmtUsdc(tc)} committed`);
    }
  }

  const minSale = BigInt("1000000000000"); // $1M in USDC units
  if (totalCommitted >= minSale) {
    console.log("");
    log("READY", "Above MIN_SALE — admin can finalize via UI or CLI");
    log("READY", "  npx hardhat cf-finalize --network hub");
  } else {
    console.log("");
    log("WARN", `Below MIN_SALE ($1M) — finalize will cancel the sale`);
  }

  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
