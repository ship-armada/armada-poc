// ABOUTME: Local gas dry-run gate for ArmadaCrowdfund.finalize() at the MAX_FINALIZE_NODES cap.
// ABOUTME: Deploys the real build, fills to the node cap, finalizes, and asserts gasUsed < 2^24 (EIP-7825).

/**
 * Repeatable local realization of the "Sepolia dry-run" (#1): the EVM is deterministic, so
 * finalize()'s gasUsed for the real deploy build at the node cap is the same locally as on any
 * chain (same hardfork). This deploys the actual ArmadaCrowdfund (mock USDC/ARM deps), builds the
 * invite tree to MAX_FINALIZE_NODES, commits the success path, warps past the window, and measures
 * finalize() from a REAL tx receipt (includes the 21k intrinsic) against the 16,777,216 (2^24,
 * EIP-7825) per-tx cap.
 *
 * Run:  npx hardhat run scripts/crowdfund_gas_dryrun.ts
 * Fast validation at a smaller count:  GAS_DRYRUN_NODES=200 npx hardhat run scripts/crowdfund_gas_dryrun.ts
 */

import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
const TX_GAS_CAP = 16_777_216n; // EIP-7825 per-tx gas cap (2^24)
const THREE_WEEKS = 21 * 24 * 60 * 60;

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
  const N = Math.min(target ?? CAP, CAP);
  console.log(`Filling to ${N} nodes (MAX_FINALIZE_NODES = ${CAP})...`);

  // ---- hop-0 seeds (<=180)
  const seedCount = Math.min(N, 180);
  const seeds: string[] = [];
  for (let i = 0; i < seedCount; i++) seeds.push(nodeAddr(0x10, i));
  await (await cf.addSeeds(seeds)).wait();

  // ---- hop-1: seeds invite up to 3 each, then launch team up to 100
  const hop1: string[] = [];
  for (let i = 0; i < seedCount && seedCount + hop1.length < N; i++) {
    const s = await signerFor(seeds[i]);
    for (let j = 0; j < 3 && seedCount + hop1.length < N; j++) {
      const a = nodeAddr(0x20, hop1.length);
      await (await cf.connect(s).invite(a, 0)).wait();
      hop1.push(a);
    }
  }
  for (let k = 0; k < 100 && seedCount + hop1.length < N; k++) {
    const a = nodeAddr(0x20, hop1.length);
    await (await cf.launchTeamInvite(a, 0)).wait(); // deployer == launch team
    hop1.push(a);
  }

  // ---- hop-2: hop-1 invite up to 2 each
  const hop2: string[] = [];
  for (let i = 0; i < hop1.length && seedCount + hop1.length + hop2.length < N; i++) {
    const s = await signerFor(hop1[i]);
    for (let j = 0; j < 2 && seedCount + hop1.length + hop2.length < N; j++) {
      const a = nodeAddr(0x30, hop2.length);
      await (await cf.connect(s).invite(a, 1)).wait();
      hop2.push(a);
    }
  }

  const count = Number(await cf.getParticipantCount());
  console.log(`Built ${count} nodes (${seedCount} hop-0 / ${hop1.length} hop-1 / ${hop2.length} hop-2). Committing...`);

  // ---- commits: success path — 180 seeds @ $15k + first 40 hop-1 @ $4k clears MIN_SALE; rest $10
  async function commit(a: string, hop: number, amt: bigint) {
    const s = await signerFor(a);
    await (await usdc.mint(a, amt)).wait();
    await (await usdc.connect(s).approve(cf.target, amt)).wait();
    await (await cf.connect(s).commit(hop, amt)).wait();
  }
  for (let i = 0; i < seeds.length; i++) await commit(seeds[i], 0, USDC(15_000));
  for (let i = 0; i < hop1.length; i++) await commit(hop1[i], 1, i < 40 ? USDC(4_000) : USDC(10));
  for (let i = 0; i < hop2.length; i++) await commit(hop2[i], 2, USDC(10));

  // ---- finalize + measure
  await time.increase(THREE_WEEKS + 1);
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
  // At the full cap we expect the success path (the worst/most-expensive case).
  if (count === CAP && refundMode) {
    console.error("WARN: expected the success path at the node cap (refund is ~260k cheaper)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
