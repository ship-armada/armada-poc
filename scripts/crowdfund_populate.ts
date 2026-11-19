// ABOUTME: CLI script to populate a deployed crowdfund with enough commitments to reach a target.
// ABOUTME: Uses Hardhat signers as ephemeral participants. Local Anvil only.
/**
 * Crowdfund Populate — Fill a deployed crowdfund to a target commitment level
 *
 * Loads the existing deployment from deployments/crowdfund-hub.json and runs
 * through the full lifecycle: add seeds → start window → invite + commit
 * (concurrent) → advance past window. Per-hop caps and the minimum sale are read
 * from the deployed contract.
 *
 * Tiers: Known contributors (hop 0, added as seeds) commit their full cap. With
 * HOPS, the launch team also places team inviter wallets (hop 1, $0 cap, never
 * commit) and those wallets invite Invited contributors (hop 2), who commit their
 * full cap. Known contributors cannot invite.
 *
 * Leaves the contract ready for admin to finalize via the UI or CLI.
 *
 * Environment variables:
 *   TARGET  - Target total in whole USDC (default: 500000, above the $250K MIN_SALE)
 *   HOPS    - If "true", also place team wallets and Invited contributors (default: false)
 *   INVITED - Invited contributors to add when HOPS is set (default: 12)
 *
 * Usage:
 *   npx hardhat run scripts/crowdfund_populate.ts --network hub
 *   TARGET=1200000 npx hardhat run scripts/crowdfund_populate.ts --network hub
 *   TARGET=1500000 HOPS=true INVITED=30 npx hardhat run scripts/crowdfund_populate.ts --network hub
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getCrowdfundDeploymentFile } from "../config/networks";

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
  const targetUsdc = parseInt(process.env.TARGET || "500000", 10);
  const includeHops = process.env.HOPS === "true";
  const invitedTarget = includeHops ? parseInt(process.env.INVITED || "12", 10) : 0;

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
  const PhaseNames = ["ACTIVE", "FINALIZED", "CANCELED"];
  if (phase !== 0) {
    throw new Error(
      `Contract is in ${PhaseNames[phase]} phase (expected ACTIVE).\n` +
      `Redeploy with 'npm run chains && npm run setup' for a fresh contract.`
    );
  }
  log("PHASE", `Current phase: ${PhaseNames[phase]}`);

  // Caps come from the deployed contract (whole USDC), so the plan matches its constants.
  const capOf = async (hop: number) => Number((await crowdfund.hopConfigs(hop)).capUsdc / 1_000_000n);
  const SEED_CAP = await capOf(0);      // Known contributor cap
  const INVITED_CAP = await capOf(2);   // Invited contributor cap
  const TEAM_WALLET_INVITES = Number((await crowdfund.hopConfigs(1)).maxInvites);
  const TEAM_WALLET_BUDGET = Number(await crowdfund.LAUNCH_TEAM_HOP1_BUDGET());
  const minSale = await crowdfund.MIN_SALE();

  // Get signers — Hardhat provides 200 by default
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  // Signer allocation mirrors the UI's dropdown (crowdfund-ui/packages/committer):
  //   signers[0]   = Admin / Deployer (launch team)
  //   signers[1-3] = Seed A/B/C (hop-0, Known)        — UI accounts
  //   signers[4-6] = Hop-1 A/B/C (hop-1, team wallets) — UI accounts
  //   signers[7-9] = Hop-2 A/B/C (hop-2, Invited)      — UI accounts
  //   signers[11+] = generated participants (bulk Known seeds, extra Invited)
  const availableSigners = signers.slice(11);

  // UI accounts — these match the predefined addresses in the UI dropdown
  const uiSeeds = signers.slice(1, 4);     // Seed A/B/C
  const uiHop1  = signers.slice(4, 7);     // Hop-1 A/B/C: team inviter wallets
  const uiHop2  = signers.slice(7, 10);    // Hop-2 A/B/C: first Invited contributors

  // Plan: team wallets (if HOPS) are the UI hop-1 accounts, within the launch-team budget.
  // Invited contributors are the UI hop-2 accounts plus generated signers, spread across the team
  // wallets' invite slots. Known seeds (UI seeds + generated) cover the rest of the target.
  const teamWallets = includeHops ? uiHop1.slice(0, Math.min(uiHop1.length, TEAM_WALLET_BUDGET)) : [];
  const invitedCount = Math.min(invitedTarget, teamWallets.length * TEAM_WALLET_INVITES);
  const generatedInvited = Math.max(0, invitedCount - uiHop2.length);
  const invitedTotal = invitedCount * INVITED_CAP;
  const remainingTarget = Math.max(0, targetUsdc - uiSeeds.length * SEED_CAP - invitedTotal);
  const seedCount = Math.ceil(remainingTarget / SEED_CAP); // generated Known seeds

  const seedSigners = availableSigners.slice(0, seedCount);
  const invitedSigners = includeHops
    ? [...uiHop2.slice(0, invitedCount), ...availableSigners.slice(seedCount, seedCount + generatedInvited)]
    : [];

  // Ensure we have enough signers
  const totalParticipants = seedCount + generatedInvited;
  if (totalParticipants > availableSigners.length) {
    throw new Error(
      `Need ${totalParticipants} signers but only ${availableSigners.length} available.\n` +
      `Reduce TARGET or INVITED, or increase hardhat accounts count.`
    );
  }

  const knownCount = uiSeeds.length + seedCount;
  const expectedTotal = knownCount * SEED_CAP + invitedTotal;
  log("PLAN", `Known: ${knownCount} × $${SEED_CAP.toLocaleString()} = $${(knownCount * SEED_CAP).toLocaleString()}`);
  if (includeHops) {
    log("PLAN", `Team wallets: ${teamWallets.length} (no commits)`);
    log("PLAN", `Invited: ${invitedCount} × $${INVITED_CAP.toLocaleString()} = $${invitedTotal.toLocaleString()}`);
  }
  log("PLAN", `Expected total: $${expectedTotal.toLocaleString()}`);
  console.log("");

  // ============ FUND PARTICIPANTS WITH ETH ============
  // On Anvil with --network hub, only the first ~10 accounts have ETH.
  // Participant signers (index 11+) need gas money for invite/approve/commit.
  console.log("-".repeat(70));
  log("FUND", "Sending ETH to participant signers for gas...");
  const ethPerParticipant = ethers.parseEther("1");
  const allParticipants = [...uiSeeds, ...seedSigners, ...teamWallets, ...invitedSigners];
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

  // ============ VERIFY ARM PRE-LOAD ============
  const armLoadedAlready = await crowdfund.armLoaded();
  if (!armLoadedAlready) {
    log("ARM", "ARM not loaded — calling loadArm()...");
    const loadTx = await crowdfund.loadArm();
    await loadTx.wait();
    log("ARM", "ARM loaded and verified");
  } else {
    log("ARM", "ARM already loaded");
  }

  // ============ ADVANCE PAST WINDOW START ============
  // The contract opens at its constructor-set openTimestamp.
  // Ensure chain time is past windowStart before committing.
  const windowStart = Number(await crowdfund.windowStart());
  const curBlockPre = await ethers.provider.getBlock("latest");
  const curTsPre = curBlockPre!.timestamp;
  if (curTsPre < windowStart) {
    const jumpToStart = windowStart - curTsPre + 1;
    log("TIME", `Advancing ${jumpToStart}s to pass windowStart...`);
    await network.provider.send("evm_increaseTime", [jumpToStart]);
    await network.provider.send("evm_mine");
  }
  log("PHASE", "Crowdfund window is open (invites + commits concurrent)");

  // ============ TEAM WALLETS + INVITED (if hops enabled) ============
  if (includeHops) {
    console.log("-".repeat(70));
    log("INVITE", "Placing team inviter wallets (launch team)...");
    for (const w of teamWallets) {
      const tx = await crowdfund.launchTeamInvite(w.address, 0); // deployer == launch team
      await tx.wait();
    }
    log("INVITE", `${teamWallets.length} team wallets placed at hop 1`);

    // Team wallets invite Invited contributors round-robin (an invite link does the same on-chain).
    for (let i = 0; i < invitedSigners.length; i++) {
      const inviter = teamWallets[i % teamWallets.length];
      const tx = await crowdfund.connect(inviter).invite(invitedSigners[i].address, 1);
      await tx.wait();
    }
    log("INVITE", `${invitedSigners.length} Invited contributors invited at hop 2`);
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
        const cmtTx = await crowdfund.connect(p).commit(hop, amount);
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
    // Team wallets have a $0 cap and never commit.
    await commitBatch(invitedSigners, INVITED_CAP, 2, "Invited");
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
    const [tc, , uc, wc] = await crowdfund.getHopStats(h);
    if (Number(wc) > 0) {
      log("STATS", `  Hop ${h}: ${wc} whitelisted, ${uc} committers, ${fmtUsdc(tc)} committed`);
    }
  }

  if (totalCommitted >= minSale) {
    console.log("");
    log("READY", "Above MIN_SALE — admin can finalize via UI or CLI");
    log("READY", "  npx hardhat cf-finalize --network hub");
  } else {
    console.log("");
    log("WARN", `Below MIN_SALE (${fmtUsdc(minSale)}) — finalize will enter refund mode`);
  }

  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
