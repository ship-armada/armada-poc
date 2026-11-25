// ABOUTME: Local gas dry-run gate for ArmadaCrowdfund.finalize() at the largest reachable participant tree.
// ABOUTME: Deploys the real build, fills every node budget, finalizes, and asserts gasUsed < 2^24 (EIP-7825).

/**
 * Repeatable local realization of the "Sepolia dry-run" (#1): the EVM is deterministic, so
 * finalize()'s gasUsed for the real deploy build at the node cap is the same locally as on any
 * chain (same hardfork). This deploys the actual ArmadaCrowdfund (mock USDC/ARM deps), builds the
 * invite tree to its structural maximum (the node budgets cap it at 1,101: 500 seeds + 1 team
 * wallet + 100 team-wallet invites + 500 launch-team hop-2 placements, below MAX_FINALIZE_NODES),
 * commits the success path, warps past the window, and measures finalize() from a REAL tx receipt
 * (includes the 21k intrinsic) against the 16,777,216 (2^24, EIP-7825) per-tx cap.
 *
 * Run:  npx hardhat run scripts/crowdfund_gas_dryrun.ts
 * Fast validation at a smaller count:  GAS_DRYRUN_NODES=200 npx hardhat run scripts/crowdfund_gas_dryrun.ts
 */

import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";

const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
const TX_GAS_CAP = 16_777_216n; // EIP-7825 per-tx gas cap (2^24)

function nodeAddr(prefix: number, i: number): string {
  return ethers.getAddress("0x" + (BigInt(prefix) * 0x1000000n + BigInt(i)).toString(16).padStart(40, "0"));
}

const signerCache = new Map<string, Signer>();
async function signerFor(a: string): Promise<Signer> {
  let s = signerCache.get(a);
  if (!s) {
    await network.provider.send("hardhat_setBalance", [a, "0x3635C9ADC5DEA00000"]); // 1000 ETH
    s = await ethers.getImpersonatedSigner(a);
    signerCache.set(a, s);
  }
  return s;
}

async function main() {
  const target = Number(process.env.GAS_DRYRUN_NODES ?? 0) || null;
  const [deployer, treasury] = await ethers.getSigners();

  // ---- deploy real ArmadaCrowdfund + mock deps
  const usdc = await (await ethers.getContractFactory("MockUSDCV2")).deploy("Mock USDC", "USDC");
  const arm = await (await ethers.getContractFactory("ArmadaToken")).deploy(deployer.address, deployer.address);
  await (await arm.initWhitelist([deployer.address])).wait();
  const open = (await time.latest()) + 100;
  const cf = await (await ethers.getContractFactory("ArmadaCrowdfund")).deploy(
    usdc.target, arm.target, treasury.address, deployer.address, deployer.address, open,
  );
  await (await arm.transfer(cf.target, ARM(1_800_000))).wait();
  await (await cf.loadArm()).wait();
  await time.increaseTo(open);

  const CAP = Number(await cf.MAX_FINALIZE_NODES());
  const MAX_SEEDS = Number(await cf.MAX_SEEDS());
  const TEAM_WALLETS = Number(await cf.LAUNCH_TEAM_HOP1_BUDGET());
  const LT_HOP2 = Number(await cf.LAUNCH_TEAM_HOP2_BUDGET());
  const hop1Cfg = await cf.hopConfigs(1);
  const INVITES_PER_WALLET = Number(hop1Cfg.maxInvites);
  const STRUCTURAL_MAX = MAX_SEEDS + TEAM_WALLETS + TEAM_WALLETS * INVITES_PER_WALLET + LT_HOP2;
  const N = Math.min(target ?? STRUCTURAL_MAX, STRUCTURAL_MAX);
  console.log(`Filling to ${N} nodes (structural max ${STRUCTURAL_MAX}, MAX_FINALIZE_NODES = ${CAP})...`);
  const room = (built: number) => built < N;

  // ---- hop-0 seeds (<= MAX_SEEDS)
  const seedCount = Math.min(N, MAX_SEEDS);
  const seeds: string[] = [];
  for (let i = 0; i < seedCount; i++) seeds.push(nodeAddr(0x10, i));
  // Batched like the Safe launch tooling (MAX_SEEDS_PER_BATCH_CEILING = 180): all 500 seeds in one
  // addSeeds call exceed the 2^24 per-tx gas cap.
  for (let i = 0; i < seeds.length; i += 180) await (await cf.addSeeds(seeds.slice(i, i + 180))).wait();

  // ---- hop-1: launch-team team inviter wallets (seeds cannot invite)
  const hop1: string[] = [];
  for (let k = 0; k < TEAM_WALLETS && room(seedCount + hop1.length); k++) {
    const a = nodeAddr(0x20, hop1.length);
    await (await cf.launchTeamInvite(a, 0)).wait(); // deployer == launch team
    hop1.push(a);
  }

  // ---- hop-2: each team wallet invites up to its budget, then launch-team hop-2 placements
  const hop2: string[] = [];
  const built = () => seedCount + hop1.length + hop2.length;
  for (let i = 0; i < hop1.length && room(built()); i++) {
    const s = await signerFor(hop1[i]);
    for (let j = 0; j < INVITES_PER_WALLET && room(built()); j++) {
      const a = nodeAddr(0x30, hop2.length);
      await (await cf.connect(s).invite(a, 1)).wait();
      hop2.push(a);
    }
  }
  for (let k = 0; k < LT_HOP2 && room(built()); k++) {
    const a = nodeAddr(0x30, hop2.length);
    await (await cf.launchTeamInvite(a, 1)).wait();
    hop2.push(a);
  }

  const count = Number(await cf.getParticipantCount());
  console.log(`Built ${count} nodes (${seedCount} hop-0 / ${hop1.length} hop-1 / ${hop2.length} hop-2). Committing...`);

  // ---- commits: success path — seeds at the $100k cap (500 × $100k oversubscribes the $1.8M sale,
  //      so the pro-rata branch runs); team wallets and hop-2 at MIN_COMMIT (team wallets have a $0
  //      cap, so theirs is refunded in full) so the iteration body runs for every node.
  async function commit(a: string, hop: number, amt: bigint) {
    const s = await signerFor(a);
    await (await usdc.mint(a, amt)).wait();
    await (await usdc.connect(s).approve(cf.target, amt)).wait();
    await (await cf.connect(s).commit(hop, amt)).wait();
  }
  const hop0Cap: bigint = await cf.HOP0_CAP_USDC();
  for (let i = 0; i < seeds.length; i++) await commit(seeds[i], 0, hop0Cap);
  const minCommit: bigint = await cf.MIN_COMMIT();
  for (let i = 0; i < hop1.length; i++) await commit(hop1[i], 1, minCommit);
  for (let i = 0; i < hop2.length; i++) await commit(hop2[i], 2, minCommit);

  // ---- finalize + measure
  await time.increaseTo((await cf.windowEnd()) + 1n);
  const receipt = await (await cf.finalize()).wait();
  const gasUsed = receipt!.gasUsed;
  const pct = Number((gasUsed * 10000n) / TX_GAS_CAP) / 100;
  const refundMode = await cf.refundMode();

  console.log("\n──────────────────────────────────────────────");
  console.log(`finalize() @ ${count} nodes: ${gasUsed.toLocaleString()} gas`);
  console.log(`  ${pct}% of the 2^24 per-tx cap (${TX_GAS_CAP.toLocaleString()})`);
  console.log(`  refundMode: ${refundMode} ${refundMode ? "(refund path)" : "(success path)"}`);
  console.log("──────────────────────────────────────────────");

  if (gasUsed >= TX_GAS_CAP) {
    console.error(`FAIL: finalize() gas ${gasUsed} >= 2^24 cap — unsubmittable`);
    process.exit(1);
  }
  console.log(`PASS: under the cap with ${(100 - pct).toFixed(1)}% margin`);
  // At the structural max we expect the success path (the worst/most-expensive case).
  if (count === STRUCTURAL_MAX && refundMode) {
    console.error("WARN: expected the success path at the structural max (refund is ~260k cheaper)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
