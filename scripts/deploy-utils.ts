/**
 * Deployment Utilities
 *
 * Handles nonce management for reliable deployments on public testnets,
 * and provides safety guards against deploying with well-known test addresses.
 *
 * Public RPCs (especially L2s like Base Sepolia) use load-balanced backends
 * that can return stale nonce values, causing "replacement transaction underpriced"
 * errors when sending sequential transactions.
 *
 * The NonceManager manually tracks nonces to avoid this issue.
 */

import { isLocal } from "../config/networks";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

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
