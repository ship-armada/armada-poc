// ABOUTME: Hardhat tasks that write Safe Transaction Builder batch files: launch-team seeds and invites
// ABOUTME: from a CSV (cf-safe-batch) and the security council's emergency cancel (cf-safe-cancel).

/**
 * Usage (crowdfund address from the network's manifest, or --crowdfund):
 *   npx hardhat cf-safe-batch --file launch.csv --network mainnetHub [--allow-stack] [--check]
 *   npx hardhat cf-safe-cancel --network mainnetHub
 *
 * CSV header: address,hop,label — hop 0 = seed, 1 or 2 = launch-team invite to that hop.
 * Output goes to safe-batches/<time>-launch|cancel/ (gitignored): one Transaction Builder file
 * per Safe transaction plus summary.md for the signers. See docs/safe-launch-batches.md.
 */

import { task, types } from "hardhat/config";
import { HardhatPluginError } from "hardhat/plugins";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { createHash } from "crypto";
import { getAddress } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_MAX_INVITES_PER_BATCH,
  DEFAULT_MAX_SEEDS_PER_BATCH,
  batchFileName,
  cancelBatchFile,
  launchBatchFile,
  parseLaunchCsv,
  phaseName,
  planLaunchBatches,
  readCancelTarget,
  readLaunchState,
  renderLaunchSummary,
  validateLaunchRows,
} from "../scripts/safe-batch";

/** Batch-size ceilings that keep one Safe transaction well under the ~16.7M per-transaction gas cap. */
const MAX_SEEDS_PER_BATCH_CEILING = 180;
const MAX_INVITES_PER_BATCH_CEILING = 150;

const CROWDFUND_MANIFESTS: Record<string, string> = {
  mainnetHub: "crowdfund-hub-mainnet.json",
  sepoliaHub: "crowdfund-hub-sepolia.json",
  hub: "crowdfund-hub.json",
};

function resolveCrowdfund(networkName: string, override: string | undefined): string {
  if (override) return getAddress(override);
  const file = CROWDFUND_MANIFESTS[networkName];
  if (!file) throw new Error(`No crowdfund manifest is known for network "${networkName}"; pass --crowdfund`);
  const manifest = path.join(__dirname, "..", "deployments", file);
  if (!fs.existsSync(manifest)) throw new Error(`Crowdfund manifest not found: ${manifest}; pass --crowdfund`);
  return getAddress(JSON.parse(fs.readFileSync(manifest, "utf8")).contracts.crowdfund);
}

/** A fresh output directory per run, so files from different runs never mix. */
function createRunDir(out: string, kind: string): string {
  const dir = path.resolve(out, `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}`);
  if (fs.existsSync(dir)) throw new Error(`Output directory already exists: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function requireBatchSize(name: string, value: number, ceiling: number): void {
  if (!Number.isInteger(value) || value < 1 || value > ceiling) {
    throw new Error(`--${name} must be a whole number from 1 to ${ceiling}, got ${value}`);
  }
}

/**
 * Refusals (bad CSV, failed checks) are expected outcomes: report them as plugin errors so
 * Hardhat prints the message plainly instead of "An unexpected error occurred" with a stack.
 */
function reported<A>(taskName: string, action: (args: A, hre: HardhatRuntimeEnvironment) => Promise<unknown>) {
  return async (args: A, hre: HardhatRuntimeEnvironment) => {
    try {
      return await action(args, hre);
    } catch (error) {
      throw new HardhatPluginError(taskName, (error as Error).message, error as Error);
    }
  };
}

task("cf-safe-batch", "Write Safe Transaction Builder batches for launch-team seeds and invites from a CSV")
  .addParam("file", "CSV with header address,hop,label (hop 0 = seed, 1 or 2 = launch-team invite)")
  .addOptionalParam("crowdfund", "Crowdfund address (default: the network's crowdfund manifest)")
  .addOptionalParam("out", "Directory for the run's output folder", "safe-batches")
  .addOptionalParam("maxSeeds", "Seeds per batch", DEFAULT_MAX_SEEDS_PER_BATCH, types.int)
  .addOptionalParam("maxInvites", "Launch-team invites per batch", DEFAULT_MAX_INVITES_PER_BATCH, types.int)
  .addFlag("allowStack", "Allow invites to addresses already invited at that hop (raises their cap)")
  .addFlag("check", "Validate against the chain only; write no files")
  .setAction(reported("cf-safe-batch", async (args: any, hre) => {
    requireBatchSize("max-seeds", args.maxSeeds, MAX_SEEDS_PER_BATCH_CEILING);
    requireBatchSize("max-invites", args.maxInvites, MAX_INVITES_PER_BATCH_CEILING);
    const csvText = fs.readFileSync(args.file, "utf8");
    const rows = parseLaunchCsv(csvText);
    const provider = hre.ethers.provider;
    const crowdfund = resolveCrowdfund(hre.network.name, args.crowdfund);
    if (await provider.getCode(crowdfund) === "0x") throw new Error(`No contract at the crowdfund address ${crowdfund}`);

    const state = await readLaunchState(provider, crowdfund, rows);
    const validation = validateLaunchRows(rows, state, { allowStack: args.allowStack });
    if (await provider.getCode(state.launchTeam) === "0x") {
      validation.errors.push(`The launch team ${state.launchTeam} is not a contract; these batches are for a Safe`);
    }
    for (const warning of validation.warnings) console.log(`WARNING: ${warning}`);
    if (validation.errors.length) {
      throw new Error(`Refusing to write batches:\n  ${validation.errors.join("\n  ")}`);
    }

    const batches = planLaunchBatches(rows, { maxSeeds: args.maxSeeds, maxInvites: args.maxInvites });
    const seeds = rows.filter((r) => r.hop === 0).length;
    if (args.check) {
      console.log(`Check passed: ${seeds} seed(s), ${rows.length - seeds} invite(s) in ${batches.length} batch(es). No files written.`);
      return undefined;
    }

    const dir = createRunDir(args.out, "launch");
    const createdAt = Date.now();
    batches.forEach((batch, i) => {
      const file = launchBatchFile(batch, i + 1, batches.length, state, createdAt);
      fs.writeFileSync(path.join(dir, batchFileName(batch, i + 1, batches.length)), JSON.stringify(file, null, 2) + "\n");
    });
    const csvSha256 = createHash("sha256").update(csvText).digest("hex");
    fs.writeFileSync(path.join(dir, "summary.md"),
      renderLaunchSummary({ state, csvName: path.basename(args.file), csvSha256, batches, validation }));

    console.log(`Wrote ${batches.length} batch file(s) for the launch-team Safe ${state.launchTeam}:`);
    batches.forEach((b, i) => console.log(`  ${batchFileName(b, i + 1, batches.length)} (${b.rows.length} ${b.kind})`));
    console.log(`Signers check every call against ${path.join(dir, "summary.md")}`);
    return dir;
  }));

task("cf-safe-cancel", "Write the security council's emergency cancel() as a Safe Transaction Builder file")
  .addOptionalParam("crowdfund", "Crowdfund address (default: the network's crowdfund manifest)")
  .addOptionalParam("out", "Directory for the run's output folder", "safe-batches")
  .setAction(reported("cf-safe-cancel", async (args: any, hre) => {
    const provider = hre.ethers.provider;
    const crowdfund = resolveCrowdfund(hre.network.name, args.crowdfund);
    if (await provider.getCode(crowdfund) === "0x") throw new Error(`No contract at the crowdfund address ${crowdfund}`);
    const target = await readCancelTarget(provider, crowdfund);
    if (target.phase !== 0) throw new Error(`The crowdfund is not active (phase ${phaseName(target.phase)}); cancel() would revert`);
    if (await provider.getCode(target.securityCouncil) === "0x") {
      throw new Error(`The security council ${target.securityCouncil} is not a contract; this file is for a Safe`);
    }

    const dir = createRunDir(args.out, "cancel");
    const file = cancelBatchFile(target.chainId, crowdfund, target.securityCouncil, Date.now());
    fs.writeFileSync(path.join(dir, "cancel.json"), JSON.stringify(file, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "summary.md"), [
      "# Security council: cancel the crowdfund",
      "",
      `- Chain: ${target.chainId}`,
      `- Crowdfund: ${crowdfund}`,
      `- Security-council Safe: ${target.securityCouncil}`,
      "",
      "One call: cancel() on the crowdfund. Immediate and irreversible: the sale ends and every",
      "participant can claim a full refund. Only for a recorded emergency decision (specs/OPERATIONS.md §7).",
      "",
      "In the Safe app: Apps → Transaction Builder → drag in cancel.json → check the call → Create batch →",
      "Simulate → sign. A second owner confirms in Transactions → Queue and executes.",
      "",
    ].join("\n"));
    console.log(`Wrote ${path.join(dir, "cancel.json")} for the security-council Safe ${target.securityCouncil}`);
    return dir;
  }));
