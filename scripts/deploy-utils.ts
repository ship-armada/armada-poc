/**
 * Deployment Utilities
 *
 * Handles nonce management for reliable deployments on public testnets,
 * provides safety guards against deploying with well-known test addresses,
 * and centralizes deployment manifest I/O with address validation.
 *
 * Public RPCs (especially L2s like Base Sepolia) use load-balanced backends
 * that can return stale nonce values, causing "replacement transaction underpriced"
 * errors when sending sequential transactions.
 *
 * The NonceManager manually tracks nonces to avoid this issue.
 */

import { isLocal } from "../config/networks";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// `ethers` is lazy-loaded from hardhat inside timelockCall (its only consumer) rather than
// imported at module scope, so plain ts-node callers of this module — e.g.
// scripts/test_sepolia.ts, which only use loadDeployment — don't fail at import time.
// hardhat's `ethers` export only exists under a `hardhat run` runtime.

// Well-known Anvil/Hardhat default accounts (#0-9), derived from the standard mnemonic:
// "test test test test test test test test test test test junk"
// These private keys are public knowledge. Deploying trust-anchor roles to these
// addresses on any non-local network is a critical, unrecoverable misconfiguration.
export const ANVIL_DEFAULT_ADDRESSES: ReadonlySet<string> = new Set([
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // #0
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // #1
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // #2
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906", // #3  (note: #5 in some tooling)
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", // #4
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", // #5
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9", // #6
  "0x14dC79964da2C08dA15Fd353d30d9CBa38d7A966", // #7
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", // #8
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", // #9
].map(a => a.toLowerCase()));

/**
 * Reject addresses that match well-known Anvil/Hardhat default accounts.
 * Only enforced on non-local environments. On local, Anvil addresses are expected.
 *
 * @param addresses - Array of addresses to check
 * @param label - Human-readable label for error messages (e.g. "RevenueLock beneficiaries")
 * @throws Error if any address matches an Anvil default on a non-local environment
 */
export function rejectAnvilAddresses(addresses: string[], label: string): void {
  if (isLocal()) return;

  const violations = addresses.filter(a => ANVIL_DEFAULT_ADDRESSES.has(a.toLowerCase()));
  if (violations.length > 0) {
    throw new Error(
      `CRITICAL: ${label} contains Anvil/Hardhat default address(es) on a non-local environment!\n` +
      `  Offending: ${violations.join(", ")}\n` +
      `  These private keys are publicly known. Deploying with them would be an unrecoverable loss.\n` +
      `  Fix: Set real addresses via environment config (see config/networks.ts).`
    );
  }
}

/**
 * Re-run a read-only check that verifies recent writes. Load-balanced public RPCs can
 * route the read to a node that has not yet seen the write's block, so a correct state
 * reads as a mismatch. A real mismatch persists and the last error is rethrown.
 * Local chains have no lag, so they check once.
 */
export async function retryReadOnLag<T>(
  description: string,
  check: () => Promise<T>,
  attempts = isLocal() ? 1 : 8,
  delayMs = 5000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await check();
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.log(`   ${description}: read-back failed (possible RPC lag) — retry ${attempt}/${attempts - 1} in ${delayMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export interface NonceManager {
  /** Returns a transaction override object with the next nonce (testnet) or empty (local) */
  override(): { nonce: number } | Record<string, never>;
  /** The nonce the next override() will hand out (testnet), or undefined (local). */
  nextNonce(): number | undefined;
}

/**
 * Creates a nonce manager that explicitly tracks nonces for testnet deployments.
 * On local Anvil, returns empty overrides (ethers manages nonces automatically).
 *
 * `expectedStartNonce` is the nonce the previous stage ended at, for a stage that runs right
 * after it. The start nonce is then read with awaitExpectedNonce instead of a single read.
 */
export async function createNonceManager(
  signer: HardhatEthersSigner,
  expectedStartNonce?: number,
): Promise<NonceManager> {
  const local = isLocal();

  if (local) {
    return {
      override: () => ({}),
      nextNonce: () => undefined,
    };
  }

  let nonce = expectedStartNonce === undefined
    ? await signer.getNonce()
    : await awaitExpectedNonce(() => signer.getNonce(), expectedStartNonce);

  console.log(`  [nonce-manager] Starting nonce: ${nonce}`);

  return {
    override(): { nonce: number } {
      const current = nonce++;
      return { nonce: current };
    },
    nextNonce: () => nonce,
  };
}

/**
 * The nonce the crowdfund stage must start at, or undefined when the handoff does not apply.
 * A hardened run deploys governance and then crowdfund back to back (deploy_mainnet.ts), so the
 * crowdfund starts exactly where governance ended. Non-hardened runs may deploy other stages in
 * between, and local runs let ethers pick nonces.
 */
export function crowdfundHandoffNonce(
  govDeployment: { deployerNonceAfterGovernance?: number },
  hardenTimelock: boolean,
  local: boolean,
): number | undefined {
  if (!hardenTimelock || local) return undefined;
  if (govDeployment.deployerNonceAfterGovernance === undefined) {
    throw new Error(
      "Governance manifest has no deployerNonceAfterGovernance; a hardened crowdfund stage must " +
      "follow a governance stage that recorded it."
    );
  }
  return govDeployment.deployerNonceAfterGovernance;
}

/**
 * Read the deployer's nonce at the start of a stage that runs straight after another one,
 * whose final nonce was recorded as `expected`.
 *
 * - Lower: the RPC node has not seen the previous stage's last blocks yet. Retry (RPC lag).
 * - Higher: the deployer key sent transactions outside the deploy. Abort at once.
 */
export async function awaitExpectedNonce(
  readNonce: () => Promise<number>,
  expected: number,
  attempts = 8,
  delayMs = 5000,
): Promise<number> {
  const nonce = await retryReadOnLag("Deployer nonce", async () => {
    const current = await readNonce();
    if (current < expected) {
      throw new Error(
        `Deployer nonce ${current} is behind the ${expected} the previous stage ended at ` +
        `(the RPC node is behind)`
      );
    }
    return current;
  }, attempts, delayMs);
  if (nonce > expected) {
    throw new Error(
      `Deployer nonce is ${nonce}, but the previous stage ended at ${expected}: the deployer key ` +
      `sent ${nonce - expected} transaction(s) outside this deploy. Do not send anything else; ` +
      `investigate with ${INTERRUPTED_LAUNCH_RUNBOOK}.`
    );
  }
  return nonce;
}

// ============================================================================
// Deployment Manifest I/O
// ============================================================================

const DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments");

/**
 * Validate that address-like values in a deployment manifest are well-formed.
 * Walks the object tree and checks any 0x-prefixed string that looks like an address.
 * Warns on zero addresses, throws on malformed addresses.
 */
function validateManifestAddresses(data: any, filename: string, prefix = ""): void {
  for (const [key, value] of Object.entries(data)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string" && value.startsWith("0x")) {
      // Looks like an address or bytes32 — validate if 42 chars (address length)
      if (value.length === 42) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
          throw new Error(
            `Malformed address in ${filename} at ${path}: "${value}"`
          );
        }
        if (value === "0x0000000000000000000000000000000000000000") {
          console.warn(`  [manifest] WARNING: zero address in ${filename} at ${path}`);
        }
      }
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      validateManifestAddresses(value, filename, path);
    }
  }
}

/**
 * Load a deployment manifest from the deployments directory.
 * Returns null if the file does not exist. Validates address fields on load.
 */
export function loadDeployment(filename: string): any | null {
  const filePath = path.join(DEPLOYMENTS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  validateManifestAddresses(data, filename);
  return data;
}

/** Manual recovery procedure for a crowdfund launch that stopped part-way. */
export const INTERRUPTED_LAUNCH_RUNBOOK = "docs/interrupted-launch-recovery.md";

/**
 * Throw if any of the given manifests already exist in the deployments directory (or
 * `dir`). Their presence means an earlier launch already sent transactions; re-running
 * would deploy a second stack and overwrite the record of the first.
 */
export function assertNoPriorLaunch(filenames: string[], dir: string = DEPLOYMENTS_DIR): void {
  const existing = filenames.filter((f) => fs.existsSync(path.join(dir, f)));
  if (existing.length > 0) {
    throw new Error(
      `Existing launch manifest(s) found in deployments/: ${existing.join(", ")}. ` +
      `An earlier run already sent transactions. Do not re-run; follow ${INTERRUPTED_LAUNCH_RUNBOOK}.`
    );
  }
}

/**
 * Refuse to deploy anything but the intended commit. Throws unless `expectedCommit` is a full
 * 40-character SHA equal to HEAD in `repoDir` and the working tree is clean (hardhat compiles
 * the working tree, so local edits would deploy code that is in no commit). Returns HEAD.
 */
export function assertDeployCommit(expectedCommit: string, repoDir: string = process.cwd()): string {
  if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    throw new Error(`DEPLOY_COMMIT must be a full 40-character commit SHA, got "${expectedCommit}"`);
  }
  // execFileSync (no shell): nothing user-supplied is interpreted.
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  const head = git("rev-parse", "HEAD");
  if (head.toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error(`Refusing to deploy: HEAD is ${head}, DEPLOY_COMMIT is ${expectedCommit}`);
  }
  const dirty = git("status", "--porcelain", "--untracked-files=all");
  if (dirty) {
    throw new Error(`Refusing to deploy: the working tree is not clean (hardhat compiles the working tree):\n${dirty}`);
  }
  return head;
}

/** Minimum time between the pre-flight check and the crowdfund opening: room for the
 *  remaining deploy steps, verification, manifest publish, frontend pin and indexer start.
 *  Sized for a Ledger run, where every transaction waits for a human approval. */
export const CROWDFUND_OPEN_MIN_LEAD_SECONDS = 6 * 60 * 60;
/** Lowest lead an operator may set with the CROWDFUND_OPEN_MIN_LEAD_SECONDS env override.
 *  The Sepolia rehearsal signed in about 20 minutes; an hour leaves a margin over that. */
export const CROWDFUND_OPEN_MIN_LEAD_FLOOR_SECONDS = 60 * 60;
/** Maximum lead — a further-out open time is treated as a typo (wrong year or month). */
export const CROWDFUND_OPEN_MAX_LEAD_SECONDS = 60 * 86400;

// Canonical UTC form only: an explicit "Z", whole seconds. A zone-less string would be parsed
// in the operator's local timezone, and a bare number could be seconds or milliseconds.
const ISO_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Resolve the orchestrator's minimum open-time lead from the raw CROWDFUND_OPEN_MIN_LEAD_SECONDS
 * override: unset returns CROWDFUND_OPEN_MIN_LEAD_SECONDS; set must be whole seconds and at
 * least CROWDFUND_OPEN_MIN_LEAD_FLOOR_SECONDS.
 */
export function resolveCrowdfundOpenMinLead(raw: string | undefined): number {
  if (raw === undefined) return CROWDFUND_OPEN_MIN_LEAD_SECONDS;
  // Plain digits only: parseInt would read "1h" as 1 and "5400.5" as 5400.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`CROWDFUND_OPEN_MIN_LEAD_SECONDS must be whole seconds like 3600, got "${raw}"`);
  }
  const lead = Number(raw);
  if (lead < CROWDFUND_OPEN_MIN_LEAD_FLOOR_SECONDS) {
    throw new Error(
      `CROWDFUND_OPEN_MIN_LEAD_SECONDS must be at least ${CROWDFUND_OPEN_MIN_LEAD_FLOOR_SECONDS}, got ${raw}`
    );
  }
  return lead;
}

/**
 * Resolve the crowdfund's `_openTimestamp` (unix seconds). With an absolute `openTime`
 * (ISO 8601 UTC), returns it after checking it lies between `now + minLeadSeconds` and
 * `now + CROWDFUND_OPEN_MAX_LEAD_SECONDS`. Without one, returns `now + openDelay`.
 *
 * The mainnet orchestrator calls this with resolveCrowdfundOpenMinLead's lead before sending
 * any transaction; deploy_crowdfund.ts re-checks with a zero lead against the latest block.
 */
export function resolveCrowdfundOpenTimestamp(
  openTime: string | undefined,
  openDelay: number,
  now: number,
  minLeadSeconds: number,
): number {
  if (openTime === undefined) return now + openDelay;

  const parsedMs = Date.parse(openTime);
  // The round-trip rejects calendar overflow (e.g. month 13) that Date.parse may normalize.
  if (!ISO_UTC_SECONDS.test(openTime) || Number.isNaN(parsedMs) ||
      new Date(parsedMs).toISOString() !== openTime.replace("Z", ".000Z")) {
    throw new Error(`CROWDFUND_OPEN_TIME must be ISO 8601 UTC like 2026-10-08T17:00:00Z, got "${openTime}"`);
  }
  const openTs = parsedMs / 1000;
  if (openTs < now + minLeadSeconds) {
    throw new Error(
      `CROWDFUND_OPEN_TIME ${openTime} must be at least ${minLeadSeconds}s after now ` +
      `(${new Date(now * 1000).toISOString()})`
    );
  }
  if (openTs > now + CROWDFUND_OPEN_MAX_LEAD_SECONDS) {
    throw new Error(
      `CROWDFUND_OPEN_TIME ${openTime} must be at most ${CROWDFUND_OPEN_MAX_LEAD_SECONDS / 86400} days after now ` +
      `(${new Date(now * 1000).toISOString()})`
    );
  }
  return openTs;
}

/**
 * Save a deployment manifest to the deployments directory (or `dir`).
 * Creates the directory if it does not exist.
 */
export function saveDeployment(filename: string, data: any, dir: string = DEPLOYMENTS_DIR): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Save the manifest of a launch stage that has not finished, marked `inProgress: true`.
 * deploy_governance writes one before its first transaction and deploy_crowdfund right after
 * deploying the crowdfund; both update it after each later deployment. A run that stops
 * part-way therefore leaves the addresses it created and trips the mainnet re-run guard.
 * The stage's final saveDeployment replaces it without the marker.
 */
export function saveDeploymentInProgress(filename: string, data: object, dir: string = DEPLOYMENTS_DIR): void {
  saveDeployment(filename, { ...data, inProgress: true }, dir);
}

/** Throw if `manifest` comes from a stage that did not finish (see saveDeploymentInProgress). */
export function assertDeploymentComplete(manifest: any, filename: string): void {
  if (manifest?.inProgress) {
    throw new Error(
      `${filename} is from a deploy stage that did not finish (inProgress: true). ` +
      `Do not build on it; follow ${INTERRUPTED_LAUNCH_RUNBOOK}.`
    );
  }
}

// ============================================================================
// Timelock Impersonation
// ============================================================================

/**
 * Execute a call as the timelock.
 *
 * - **Local (Anvil)**: impersonates the timelock directly via `anvil_impersonateAccount`.
 *   Bypasses the configured delay since impersonation already represents an "executed" call.
 * - **Non-local (testnet/mainnet)**: real OZ TimelockController schedule + wait + execute.
 *   Requires the deployer to hold PROPOSER_ROLE + EXECUTOR_ROLE on the timelock
 *   (`deploy_governance.ts` grants these on non-local). Idempotent: if the operation has
 *   already been executed (e.g. on a re-run after a partial deploy), returns immediately.
 *   If already scheduled but not yet executable, waits for the remaining delay and executes.
 *
 * Throws on revert. Returns `true` on success / no-op.
 */
export async function timelockCall(
  timelockAddr: string,
  targetAddr: string,
  calldata: string,
  description: string,
  nm: NonceManager,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ethers } = require("hardhat");
  if (isLocal()) {
    const rpcUrl = process.env.HUB_RPC || "http://localhost:8545";
    const jsonRpc = async (method: string, params: any[] = []) => {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
      return json.result;
    };

    // Fund the timelock so it can pay gas
    const [deployer] = await ethers.getSigners();
    const balance = await ethers.provider.getBalance(timelockAddr);
    if (balance < ethers.parseEther("0.1")) {
      const fundTx = await deployer.sendTransaction({
        to: timelockAddr,
        value: ethers.parseEther("1"),
        ...nm.override(),
      });
      await fundTx.wait();
    }

    await jsonRpc("anvil_impersonateAccount", [timelockAddr]);
    const txHash = await jsonRpc("eth_sendTransaction", [{
      from: timelockAddr,
      to: targetAddr,
      data: calldata,
    }]);
    let receipt = null;
    while (!receipt) {
      receipt = await jsonRpc("eth_getTransactionReceipt", [txHash]);
    }
    await jsonRpc("anvil_stopImpersonatingAccount", [timelockAddr]);
    if (receipt.status === "0x0") {
      throw new Error(`Timelock call reverted: ${description} (tx: ${txHash})`);
    }
    console.log(`   ${description} done`);
    return true;
  }

  // Non-local: real schedule + wait + execute.
  const timelock = await ethers.getContractAt("TimelockController", timelockAddr);
  const ZERO_BYTES32 = "0x" + "00".repeat(32);
  // Deterministic salt derived from (description, target, calldata) so re-running the script
  // produces the same operation id (idempotency via isOperationDone / isOperationPending).
  // Including target + calldata in the salt — not just the description — prevents the silent
  // "already scheduled" false-match if two different operations were ever given the same
  // description string (e.g. a copy-paste error in a future caller). The structural triple
  // uniquely identifies the operation, so the salt collides only when the operations are
  // actually the same.
  const salt = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address", "bytes"],
      [description, targetAddr, calldata],
    ),
  );
  const value = 0n;
  const opId: string = await timelock.hashOperation(targetAddr, value, calldata, ZERO_BYTES32, salt);

  if (await timelock.isOperationDone(opId)) {
    console.log(`   ${description}: already executed (idempotent skip)`);
    return true;
  }

  let readyTimestamp: bigint;
  if (await timelock.isOperationPending(opId)) {
    readyTimestamp = await timelock.getTimestamp(opId);
    console.log(`   ${description}: already scheduled (ready at ${readyTimestamp})`);
  } else {
    const minDelay: bigint = await timelock.getMinDelay();
    console.log(`   ${description}: scheduling (delay = ${minDelay}s)...`);
    const scheduleTx = await timelock.schedule(
      targetAddr, value, calldata, ZERO_BYTES32, salt, minDelay, nm.override()
    );
    const scheduleReceipt = await scheduleTx.wait();
    if (!scheduleReceipt) throw new Error(`schedule returned no receipt for ${description}`);
    readyTimestamp = await timelock.getTimestamp(opId);
  }

  // Wait until the operation is executable. Poll the chain's block timestamp rather than
  // sleeping wall-clock seconds — different chains advance their clocks differently.
  while (true) {
    const block = await ethers.provider.getBlock("latest");
    const nowChain = BigInt(block?.timestamp ?? 0);
    if (nowChain >= readyTimestamp) break;
    const remaining = readyTimestamp - nowChain;
    console.log(`   ${description}: waiting ${remaining}s for timelock delay to elapse...`);
    // Sleep up to 30s at a time so we surface progress on longer delays.
    const sleepSec = Number(remaining) > 30 ? 30 : Number(remaining);
    await new Promise(resolve => setTimeout(resolve, sleepSec * 1000));
  }

  // The execute's gas estimation can transiently revert "TimelockController: operation is not
  // ready" when a load-balanced RPC serves the estimate from a node whose head still lags the
  // delay we already waited out on the canonical chain. That failure is pre-send (at
  // eth_estimateGas), so no tx is broadcast and the allocated nonce stays unused — retry with
  // the SAME override (nonce) until a synced-enough backend accepts it.
  const executeOverride = nm.override();
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      console.log(`   ${description}: executing...`);
      const executeTx = await timelock.execute(
        targetAddr, value, calldata, ZERO_BYTES32, salt, executeOverride
      );
      const executeReceipt = await executeTx.wait();
      if (!executeReceipt || executeReceipt.status === 0) {
        throw new Error(`Timelock execute reverted: ${description}`);
      }
      console.log(`   ${description}: done`);
      return true;
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (!/not ready/i.test(msg) || attempt >= 8) throw err;
      console.log(`   ${description}: not ready on this RPC node (lag) — retry ${attempt}/8 in 15s...`);
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }
  throw new Error(`Timelock execute did not complete after retries: ${description}`);
}
