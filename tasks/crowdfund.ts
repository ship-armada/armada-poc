/**
 * Hardhat Tasks for Armada Crowdfund
 *
 * Individual crowdfund actions callable from the CLI.
 * Loads deployment addresses from deployments/crowdfund-{network}.json.
 *
 * Usage:
 *   npx hardhat cf-add-seeds --addresses 0x1,0x2,0x3 --network hub
 *   npx hardhat cf-start --network hub
 *   npx hardhat cf-invite --invitee 0x... --network hub
 *   npx hardhat cf-commit --amount 5000 --network hub
 *   npx hardhat cf-finalize --network hub
 *   npx hardhat cf-claim --network hub
 *   npx hardhat cf-stats --network hub
 *   npx hardhat cf-allocation --address 0x... --network hub
 */

import { task } from "hardhat/config";
import * as fs from "fs";
import * as path from "path";

const PhaseNames = ["SETUP", "ACTIVE", "FINALIZED", "CANCELED"];

function loadCrowdfundDeployment(networkName: string) {
  const filePath = path.join(__dirname, "..", "deployments", `crowdfund-${networkName}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployment file not found: ${filePath}. Run deploy_crowdfund.ts first.`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getNetworkName(chainId: number): string {
  if (chainId === 31337) return "hub";
  if (chainId === 31338) return "client";
  if (chainId === 31339) return "clientB";
  return "unknown";
}

// ============ Setup ============

task("cf-add-seeds", "Add seed addresses (hop 0)")
  .addParam("addresses", "Comma-separated seed addresses")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadCrowdfundDeployment(getNetworkName(chainId));

    const crowdfund = await ethers.getContractAt("ArmadaCrowdfund", deployment.contracts.crowdfund);
    const seeds = args.addresses.split(",").map((a: string) => a.trim());

    await crowdfund.addSeeds(seeds);
    console.log(`Added ${seeds.length} seed(s): ${seeds.join(", ")}`);
  });

task("cf-start", "Start the active window (invites + commits)")
  .setAction(async (_, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadCrowdfundDeployment(getNetworkName(chainId));

    const crowdfund = await ethers.getContractAt("ArmadaCrowdfund", deployment.contracts.crowdfund);

    // Ensure ARM is loaded before starting window
    const armLoaded = await crowdfund.armLoaded();
    if (!armLoaded) {
      console.log("ARM not loaded — calling loadArm()...");
      await crowdfund.loadArm();
      console.log("ARM loaded and verified");
    }

    await crowdfund.startWindow();

    const winStart = await crowdfund.windowStart();
    const winEnd = await crowdfund.windowEnd();
    const ltEnd = await crowdfund.launchTeamInviteEnd();
    console.log("Active window started (invites + commits concurrent)");
    console.log(`  Window start: ${new Date(Number(winStart) * 1000).toISOString()}`);
    console.log(`  Launch team invite cutoff: ${new Date(Number(ltEnd) * 1000).toISOString()}`);
    console.log(`  Window ends: ${new Date(Number(winEnd) * 1000).toISOString()}`);
  });

// ============ Active Window ============

task("cf-invite", "Invite an address to participate")
  .addParam("invitee", "Address to invite")
  .addParam("hop", "Hop level of the inviter (0 for seeds, 1 for hop-1)")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const [signer] = await ethers.getSigners();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadCrowdfundDeployment(getNetworkName(chainId));

    const inviterHop = parseInt(args.hop, 10);
    const crowdfund = await ethers.getContractAt("ArmadaCrowdfund", deployment.contracts.crowdfund);
    await crowdfund.invite(args.invitee, inviterHop);

    const remaining = await crowdfund.getInvitesRemaining(signer.address, inviterHop);
    console.log(`Invited ${args.invitee}. Invites remaining: ${remaining}`);
  });

// ============ Commitment (during active window) ============

task("cf-commit", "Commit USDC to the crowdfund")
  .addParam("amount", "Amount of USDC (in whole dollars)")
  .addParam("hop", "Hop level of the committer (0 for seeds, 1 for hop-1, 2 for hop-2)")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const [signer] = await ethers.getSigners();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadCrowdfundDeployment(getNetworkName(chainId));

    const hop = parseInt(args.hop, 10);
    const amount = ethers.parseUnits(args.amount, 6);
    const usdcToken = await ethers.getContractAt("MockUSDCV2", deployment.contracts.usdc);
    const crowdfund = await ethers.getContractAt("ArmadaCrowdfund", deployment.contracts.crowdfund);

    await usdcToken.approve(deployment.contracts.crowdfund, amount);
    await crowdfund.commit(amount, hop);

    const committed = await crowdfund.getCommitment(signer.address, hop);
    console.log(`Committed $${args.amount} USDC. Total committed: $${ethers.formatUnits(committed, 6)}`);
  });

// ============ Finalization ============

task("cf-finalize", "Finalize the crowdfund (compute allocations or cancel)")
  .setAction(async (_, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadCrowdfundDeployment(getNetworkName(chainId));

    const crowdfund = await ethers.getContractAt("ArmadaCrowdfund", deployment.contracts.crowdfund);
    await crowdfund.finalize();

    const phase = Number(await crowdfund.phase());
    console.log(`Crowdfund finalized: ${PhaseNames[phase]}`);
    if (phase === 2) {
      // Finalized
      const saleSize = await crowdfund.saleSize();
      const totalAlloc = await crowdfund.totalAllocated();
      console.log(`  Sale size: $${ethers.formatUnits(saleSize, 6)}`);
      console.log(`  Total ARM allocated: ${ethers.formatUnits(totalAlloc, 18)}`);
    }
  });

// ============ Claims ============

task("cf-claim", "Claim ARM allocation and USDC refund")
  .setAction(async (_, hre) => {
    const { ethers } = hre;
    const [signer] = await ethers.getSigners();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadCrowdfundDeployment(getNetworkName(chainId));

    const crowdfund = await ethers.getContractAt("ArmadaCrowdfund", deployment.contracts.crowdfund);
    const phase = Number(await crowdfund.phase());

    if (phase === 3) {
      // Canceled — use refund()
      await crowdfund.refund();
      console.log("Full USDC refund claimed (sale was canceled)");
    } else {
      await crowdfund.claim();
      const [alloc, refund] = await crowdfund.getAllocation(signer.address);
      console.log(`Claimed: ${ethers.formatUnits(alloc, 18)} ARM + $${ethers.formatUnits(refund, 6)} USDC refund`);
    }
  });

// ============ View ============

task("cf-stats", "Show crowdfund statistics")
  .setAction(async (_, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadCrowdfundDeployment(getNetworkName(chainId));

    const crowdfund = await ethers.getContractAt("ArmadaCrowdfund", deployment.contracts.crowdfund);

    const [totalComm, phase, winStart, winEnd] = await crowdfund.getSaleStats();
    console.log("Crowdfund Status:");
    console.log(`  Phase: ${PhaseNames[Number(phase)]}`);
    console.log(`  Total committed: $${ethers.formatUnits(totalComm, 6)}`);
    if (Number(winStart) > 0) {
      console.log(`  Window start: ${new Date(Number(winStart) * 1000).toISOString()}`);
      console.log(`  Window ends: ${new Date(Number(winEnd) * 1000).toISOString()}`);
    }
    console.log(`  Participants: ${await crowdfund.getParticipantCount()}`);

    console.log("\nPer-Hop Stats:");
    for (let h = 0; h < 3; h++) {
      const [tc, uc, wc] = await crowdfund.getHopStats(h);
      console.log(`  Hop ${h}: ${wc} whitelisted, ${uc} committed, $${ethers.formatUnits(tc, 6)} total`);
    }

    if (Number(phase) === 2) {
      console.log(`\n  Sale size: $${ethers.formatUnits(await crowdfund.saleSize(), 6)}`);
      console.log(`  Total ARM allocated: ${ethers.formatUnits(await crowdfund.totalAllocated(), 18)}`);
    }
  });

task("cf-allocation", "Check allocation for an address")
  .addParam("address", "Address to check")
  .addParam("hop", "Hop level of the address (0 for seeds, 1 for hop-1, 2 for hop-2)")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadCrowdfundDeployment(getNetworkName(chainId));

    const hop = parseInt(args.hop, 10);
    const crowdfund = await ethers.getContractAt("ArmadaCrowdfund", deployment.contracts.crowdfund);

    const wl = await crowdfund.isWhitelisted(args.address, hop);
    const committed = await crowdfund.getCommitment(args.address, hop);

    console.log(`Address: ${args.address}`);
    console.log(`  Whitelisted: ${wl}`);
    console.log(`  Hop: ${hop}`);
    console.log(`  Committed: $${ethers.formatUnits(committed, 6)}`);

    const phase = Number(await crowdfund.phase());
    if (phase === 2) {
      const [alloc, refund, claimed] = await crowdfund.getAllocation(args.address);
      console.log(`  Allocation: ${ethers.formatUnits(alloc, 18)} ARM`);
      console.log(`  Refund: $${ethers.formatUnits(refund, 6)}`);
      console.log(`  Claimed: ${claimed}`);
    }
  });
