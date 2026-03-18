// ABOUTME: CLI script to populate a deployed crowdfund with enough commitments to reach a target.
// ABOUTME: Uses Hardhat signers as ephemeral participants. Local Anvil only.
/**
 * Crowdfund Populate — Fill a deployed crowdfund to a target commitment level
 *
 * Loads the existing deployment from deployments/crowdfund-hub.json and runs
 * through the full lifecycle: add seeds → start window → invite + commit
 * (concurrent) → advance past window.
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

const THREE_WEEKS = 21 * 86400;

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
  const PhaseNames = ["SETUP", "ACTIVE", "FINALIZED", "CANCELED"];
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

  // Signer allocation mirrors the UI's dropdown (crowdfund-frontend/src/config/accounts.ts):
  //   signers[0]   = Admin / Deployer
  //   signers[1-3] = Seed A/B/C (hop-0)   — UI accounts
  //   signers[4-6] = Hop-1 A/B/C          — UI accounts
  //   signers[7-9] = Hop-2 A/B/C          — UI accounts
  //   signers[11+] = generated participants (bulk seeds, extra hop-1/hop-2)
  const availableSigners = signers.slice(11);

  // UI accounts — these match the predefined addresses in the UI dropdown
  const uiSeeds = signers.slice(1, 4);     // Seed A/B/C
  const uiHop1  = signers.slice(4, 7);     // Hop-1 A/B/C
  const uiHop2  = signers.slice(7, 10);    // Hop-2 A/B/C

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

  // Build participant arrays: UI accounts first, then generated signers for the rest.
  // This ensures the UI dropdown addresses are real participants in the crowdfund.
  const seedSigners = availableSigners.slice(0, seedCount);

  let hop1Signers: typeof seedSigners = [];
  let hop2Signers: typeof seedSigners = [];
  if (includeHops) {
    // UI hop-1 accounts (3) + generated hop-1 for the remainder
    const generatedHop1 = availableSigners.slice(seedCount, seedCount + hop1Count - uiHop1.length);
    hop1Signers = [...uiHop1, ...generatedHop1];

    // UI hop-2 accounts (3) + generated hop-2 for the remainder
    const genHop2Start = seedCount + hop1Count - uiHop1.length;
    const generatedHop2 = availableSigners.slice(genHop2Start, genHop2Start + hop2Count - uiHop2.length);
    hop2Signers = [...uiHop2, ...generatedHop2];
  }

  // Ensure we have enough signers
  const totalParticipants = seedCount + Math.max(0, hop1Count - uiHop1.length) + Math.max(0, hop2Count - uiHop2.length);
  if (totalParticipants > availableSigners.length) {
    throw new Error(
      `Need ${totalParticipants} signers but only ${availableSigners.length} available.\n` +
      `Reduce TARGET or increase hardhat accounts count.`
    );
  }

  const expectedTotal = (seedCount * SEED_CAP) + (hop1Count * HOP1_CAP) + (hop2Count * HOP2_CAP);
  log("PLAN", `Seeds: ${seedCount} × $${SEED_CAP.toLocaleString()} = $${(seedCount * SEED_CAP).toLocaleString()}`);
  if (includeHops) {
    log("PLAN", `Hop-1: ${hop1Count} × $${HOP1_CAP.toLocaleString()} = $${(hop1Count * HOP1_CAP).toLocaleString()}`);
    log("PLAN", `Hop-2: ${hop2Count} × $${HOP2_CAP.toLocaleString()} = $${(hop2Count * HOP2_CAP).toLocaleString()}`);
  }
  log("PLAN", `Expected total: $${expectedTotal.toLocaleString()}`);
  console.log("");

  // ============ FUND PARTICIPANTS WITH ETH ============
  // On Anvil with --network hub, only the first ~10 accounts have ETH.
  // Participant signers (index 11+) need gas money for invite/approve/commit.
  console.log("-".repeat(70));
  log("FUND", "Sending ETH to participant signers for gas...");
  const ethPerParticipant = ethers.parseEther("1");
  const allParticipants = [...uiSeeds, ...seedSigners, ...hop1Signers, ...hop2Signers];
  for (let i = 0; i < allParticipants.length; i += BATCH_SIZE) {
    const batch = allParticipants.slice(i, i + BATCH_SIZE);
    for (const p of batch) {
      const tx = await deployer.sendTransaction({ to: p.address, value: ethPerParticipant });
      await tx.wait();
    }
    log("FUND", `  ${Math.min(i + BATCH_SIZE, allParticipants.length)}/${allParticipants.length} funded`);
  }

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

  // ============ START WINDOW ============
  const startTx = await crowdfund.startWindow();
  await startTx.wait();
  log("PHASE", "Crowdfund window opened (invites + commits concurrent)");

  // ============ INVITATIONS (if hops enabled) ============
  if (includeHops) {
    console.log("-".repeat(70));
    log("INVITE", "Sending invitations...");

    // UI seeds (signers[1-3]) each invite 3 hop-1 addresses.
    // This ensures the UI hop-1 dropdown accounts are real participants.
    let h1idx = 0;
    for (let i = 0; i < uiSeeds.length; i++) {
      for (let j = 0; j < 3 && h1idx < hop1Signers.length; j++) {
        const tx = await crowdfund.connect(uiSeeds[i]).invite(hop1Signers[h1idx].address, 0);
        await tx.wait();
        h1idx++;
      }
    }
    log("INVITE", `${h1idx} hop-1 addresses invited (by UI seeds)`);

    // Each hop-1 invites 2 hop-2 addresses
    let h2idx = 0;
    for (let i = 0; i < hop1Signers.length; i++) {
      for (let j = 0; j < 2 && h2idx < hop2Signers.length; j++) {
        const tx = await crowdfund.connect(hop1Signers[i]).invite(hop2Signers[h2idx].address, 1);
        await tx.wait();
        h2idx++;
      }
    }
    log("INVITE", `${h2idx} hop-2 addresses invited`);
  }

  // ============ MINT + APPROVE + COMMIT ============
  // Invites and commits are both open from window start.
  console.log("-".repeat(70));
  log("COMMIT", "Minting USDC and committing...");

  const crowdfundAddr = await crowdfund.getAddress();

  // Helper to process a batch of participants
  async function commitBatch(
    participants: typeof seedSigners,
    capUsdc: number,
    hop: number,
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
        const cmtTx = await crowdfund.connect(p).commit(amount, hop);
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
  await commitBatch(uiSeeds, SEED_CAP, 0, "UI Seeds");

  await commitBatch(seedSigners, SEED_CAP, 0, "Seeds");
  if (includeHops) {
    await commitBatch(hop1Signers, HOP1_CAP, 1, "Hop-1");
    await commitBatch(hop2Signers, HOP2_CAP, 2, "Hop-2");
  }

  // ============ ADVANCE PAST WINDOW ============
  console.log("-".repeat(70));

  // Read exact window end from contract and jump past it
  const windowEnd = Number(await crowdfund.windowEnd());
  const curBlock = await ethers.provider.getBlock("latest");
  const curTs = curBlock!.timestamp;
  const jump = windowEnd - curTs + 1;

  log("TIME", `Advancing past crowdfund window (${jump}s jump)...`);
  await network.provider.send("evm_increaseTime", [jump]);
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
