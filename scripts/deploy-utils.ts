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

export interface NonceManager {
  /** Returns a transaction override object with the next nonce (testnet) or empty (local) */
  override(): { nonce: number } | Record<string, never>;
}

/**
 * Creates a nonce manager that explicitly tracks nonces for testnet deployments.
 * On local Anvil, returns empty overrides (ethers manages nonces automatically).
 */
export async function createNonceManager(signer: HardhatEthersSigner): Promise<NonceManager> {
  let nonce = await signer.getNonce();
  const local = isLocal();

  if (local) {
    return {
      override: () => ({}),
    };
  }

  console.log(`  [nonce-manager] Starting nonce: ${nonce}`);

  return {
    override(): { nonce: number } {
      const current = nonce++;
      return { nonce: current };
    },
  };
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

/**
 * Save a deployment manifest to the deployments directory.
 * Creates the deployments directory if it does not exist.
 */
export function saveDeployment(filename: string, data: any): void {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  }
  const filePath = path.join(DEPLOYMENTS_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
