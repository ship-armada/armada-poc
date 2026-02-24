/**
 * Deployment Utilities
 *
 * Handles nonce management for reliable deployments on public testnets.
 * Public RPCs (especially L2s like Base Sepolia) use load-balanced backends
 * that can return stale nonce values, causing "replacement transaction underpriced"
 * errors when sending sequential transactions.
 *
 * The NonceManager manually tracks nonces to avoid this issue.
 */

import { isLocal } from "../config/networks";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

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
