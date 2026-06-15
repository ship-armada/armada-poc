/**
 * Wallet Manager
 *
 * Manages the relayer's hot wallet for transaction submission. One EOA, multiple chains —
 * the same deployer key signs on hub + every client. Nonce streams are independent per chain
 * (each chain tracks its own nonce on the same address), so submissions on different chains
 * never collide; submissions on the SAME chain serialize through a per-chain lock.
 *
 * Why one EOA across chains:
 *   - Matches the existing CCTP relay (`cctp-relay.ts` / `iris-relay.ts`) which submits on
 *     every chain from the same key.
 *   - One key to fund, one balance to monitor.
 *   - Per-chain key splits are tracked as future hardening (relayer/CLAUDE.md).
 */

import { ethers } from "ethers";
import { accounts, allChains } from "../config";
import { NonceCoordinator } from "../lib/nonce-coordinator";
import { RpcTimeoutError, withTimeout } from "../lib/rpc-utils";
import type { Counters } from "./counters";

/**
 * How long to wait on a broadcast tx's receipt in the background before declaring it stuck. On
 * Anvil txs mine instantly so this never fires; on a real chain a tx with no receipt after this
 * budget is wedged (dropped or underpriced) and needs operator attention.
 */
const BACKGROUND_RECEIPT_TIMEOUT_MS = 10 * 60 * 1000;

// ============ Types ============

interface SubmitResult {
  txHash: string;
}

interface ChainState {
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  /** Per-chain submission lock — serializes broadcasts on this chain (nonce safety). */
  locked: boolean;
}

// ============ Wallet Manager ============

export class WalletManager {
  private chains: Map<number, ChainState> = new Map();
  /**
   * Dedup cache shared across chains, keyed by `chainId|keccak256(to, data)` so the same
   * calldata to the same target on TWO chains is correctly treated as two distinct submissions
   * (otherwise replaying a hub `transact()` shape on a client would be silently rejected as a
   * dup, even though it's a legitimately separate tx on a separate chain).
   */
  private txCache: Map<string, { txHash: string; chainId: number; timestamp: number }> =
    new Map();

  /** Dedup cache TTL in ms (10 minutes) */
  private readonly DEDUP_TTL_MS = 10 * 60 * 1000;

  /**
   * Process-wide nonce authority. Shared with the CCTP relay modules because they submit from the
   * SAME EOA on the SAME chains — without one authority the two paths read the nonce independently
   * and one path's tx silently replaces the other's in the mempool.
   */
  private nonceCoordinator: NonceCoordinator;

  /** In-process counters surfaced on /health. Used here to record stuck broadcasts. */
  private counters: Counters;

  constructor(nonceCoordinator: NonceCoordinator, counters: Counters) {
    this.nonceCoordinator = nonceCoordinator;
    this.counters = counters;
    for (const chain of allChains) {
      const provider = new ethers.JsonRpcProvider(chain.rpc);
      const wallet = new ethers.Wallet(accounts.deployer.privateKey, provider);
      this.chains.set(chain.chainId, { provider, wallet, locked: false });
    }
  }

  /**
   * Initialize: verify connectivity + balance on EVERY supported chain. Fails fast if any
   * chain is unreachable so operators see the boot error rather than discovering it only when
   * the first `/relay` for that chain comes in.
   */
  async initialize(): Promise<void> {
    console.log(`[wallet-manager] Initializing (${this.chains.size} chain(s))`);

    await Promise.all(
      Array.from(this.chains.entries()).map(async ([chainId, state]) => {
        const blockNumber = await state.provider.getBlockNumber();
        const nonce = await state.provider.getTransactionCount(
          state.wallet.address,
          "pending",
        );
        const balance = await state.provider.getBalance(state.wallet.address);
        const ethBalance = ethers.formatEther(balance);

        console.log(`  chain=${chainId}  address=${state.wallet.address}  nonce=${nonce}  eth=${ethBalance}  head=${blockNumber}`);

        if (parseFloat(ethBalance) < 0.1) {
          console.warn(`[wallet-manager] WARNING: Low ETH balance on chain ${chainId} (${ethBalance})`);
        }
      }),
    );
  }

  /**
   * Get the relayer's Ethereum address. Same address across all chains since we use one EOA.
   */
  get address(): string {
    const first = this.chains.values().next().value;
    if (!first) {
      throw new Error("WalletManager: no chains configured");
    }
    return first.wallet.address;
  }

  /**
   * Get the provider for a given chain. Throws if the chain isn't configured — caller bug.
   */
  getProvider(chainId: number): ethers.JsonRpcProvider {
    const state = this.chains.get(chainId);
    if (!state) {
      throw new Error(
        `WalletManager: chain ${chainId} is not configured. Allowed: ${Array.from(this.chains.keys()).join(", ")}`,
      );
    }
    return state.provider;
  }

  /**
   * List the chain IDs this wallet manager is configured for.
   */
  supportedChains(): number[] {
    return Array.from(this.chains.keys());
  }

  /**
   * Whether THIS chain is currently mid-broadcast. Per-chain locking — a hub tx in flight does
   * not block a client tx because their nonces are independent.
   */
  isLocked(chainId: number): boolean {
    const state = this.chains.get(chainId);
    if (!state) {
      throw new Error(`WalletManager: chain ${chainId} is not configured`);
    }
    return state.locked;
  }

  /**
   * Submit a transaction from the relayer wallet on the specified chain.
   *
   * @param chainId Target chain ID.
   * @param to Target contract address (must be allow-listed upstream in privacy-relay).
   * @param data Encoded calldata.
   * @param gasLimit Optional gas limit override; otherwise estimated with a 20% buffer.
   * @returns Transaction hash (broadcast-only — receipt tracked in the background).
   */
  async submitTransaction(
    chainId: number,
    to: string,
    data: string,
    gasLimit?: bigint,
  ): Promise<SubmitResult> {
    const state = this.chains.get(chainId);
    if (!state) {
      throw new Error(`WalletManager: chain ${chainId} is not configured`);
    }

    if (state.locked) {
      throw new Error(
        `Wallet is locked on chain ${chainId} — another transaction is in progress`,
      );
    }

    // Check dedup cache (chain-scoped — see note on `txCache`).
    const dataHash = ethers.keccak256(
      ethers.solidityPacked(["address", "bytes"], [to, data]),
    );
    const cacheKey = `${chainId}|${dataHash}`;
    const cached = this.txCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.DEDUP_TTL_MS) {
      throw new Error(
        `Duplicate transaction on chain ${chainId} (already submitted as ${cached.txHash})`,
      );
    }

    state.locked = true;

    try {
      // Estimate gas if not provided. Done OUTSIDE the nonce-coordinator critical section — gas
      // estimation needs no nonce, so holding the per-chain nonce mutex across it would serialise
      // estimation between the privacy relay and the CCTP relay for no benefit.
      let estimatedGas = gasLimit;
      if (!estimatedGas) {
        try {
          const estimate = await state.provider.estimateGas({
            from: state.wallet.address,
            to,
            data,
          });
          // Add 20% buffer
          estimatedGas = (estimate * 120n) / 100n;
        } catch (e: any) {
          throw new Error(`Gas estimation failed: ${e.message}`);
        }
      }

      console.log(`  To: ${to}`);
      console.log(`  Data: ${data.slice(0, 10)}... (${(data.length - 2) / 2} bytes)`);

      // Allocate the nonce + broadcast through the shared coordinator. It seeds from
      // `getTransactionCount('pending')` once and tracks locally thereafter, serialising the
      // allocate→broadcast window against the CCTP relay paths that share this EOA. The previous
      // fetch-fresh-every-time approach was both the source of the Sepolia load-balancer drift and
      // unable to see nonces the CCTP relay had already reserved this tick.
      let submittedNonce: number | undefined;
      const tx = await this.nonceCoordinator.withNonce(
        chainId,
        state.provider,
        state.wallet.address,
        (nonce) => {
          submittedNonce = nonce;
          console.log(
            `[wallet-manager] Submitting tx (chain=${chainId}, nonce=${nonce}, gas=${estimatedGas})`,
          );
          return state.wallet.sendTransaction({
            to,
            data,
            nonce,
            gasLimit: estimatedGas,
          });
        },
      );

      console.log(`[wallet-manager] Tx submitted (chain=${chainId}): ${tx.hash}`);

      // Cache for dedup at broadcast — a future identical request hits the cache instead of
      // re-broadcasting with a fresh nonce. The mempool already has the tx; we don't need
      // confirmation to know it's "ours".
      this.txCache.set(cacheKey, { txHash: tx.hash, chainId, timestamp: Date.now() });

      // Track the receipt in the background for operator-side revert logging. The HTTP response
      // doesn't wait on this — the frontend polls /status/:txHash, which observes the receipt
      // directly via provider.getTransactionReceipt. Waiting on tx.wait() inside the /relay
      // handler used to keep the HTTP connection open for the full block time, which intermediary
      // proxies (Cloudflare etc.) often cut at 60-100s — surfacing in the browser as a "Failed to
      // fetch" / no-CORS error even though the broadcast itself succeeded.
      //
      // The wait is bounded: a privacy-relay tx that never confirms (dropped/underpriced) would
      // otherwise leave a promise pending forever with zero operator signal, while later txs queue
      // behind its nonce. On timeout we surface it loudly and count it.
      // TODO(relayer-hardening 1.4): automatic same-nonce fee-bump replacement for stuck
      // privacy-relay txs is intentionally out of scope here — operator action for now.
      void withTimeout(
        tx.wait(),
        BACKGROUND_RECEIPT_TIMEOUT_MS,
        `tx.wait chain=${chainId} ${tx.hash.slice(0, 12)}`,
      )
        .then((receipt) => {
          if (!receipt) {
            console.warn(`[wallet-manager] Tx ${tx.hash} confirmed without receipt`);
            return;
          }
          if (receipt.status === 0) {
            console.error(`[wallet-manager] Tx reverted (chain=${chainId}): ${tx.hash}`);
            return;
          }
          console.log(
            `[wallet-manager] Tx confirmed (chain=${chainId}) in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed})`,
          );
        })
        .catch((err) => {
          if (err instanceof RpcTimeoutError) {
            console.error(
              `[wallet-manager] STUCK TX (chain=${chainId}, nonce=${submittedNonce}): ${tx.hash} ` +
                `has no receipt after ${Math.round(BACKGROUND_RECEIPT_TIMEOUT_MS / 60000)}min. ` +
                `Likely dropped or underpriced — a same-nonce fee-bump replacement (operator action) ` +
                `is required; later txs on this chain will queue behind its nonce until resolved.`,
            );
            this.counters.inc(`stuckTx.${chainId}`);
            return;
          }
          console.warn(
            `[wallet-manager] Background receipt tracking failed for ${tx.hash}: ${err?.message ?? err}`,
          );
        });

      return { txHash: tx.hash };
    } catch (e: any) {
      if (
        e.message?.includes("nonce") ||
        e.message?.includes("NONCE") ||
        e.code === "NONCE_EXPIRED" ||
        e.code === "REPLACEMENT_UNDERPRICED"
      ) {
        console.warn(
          `[wallet-manager] Nonce error on chain ${chainId} (another process may have used the account) — resetting coordinator`,
        );
        // Drop the coordinator's cached counter so the next submit re-seeds from the provider.
        this.nonceCoordinator.reset(chainId);
      }
      throw e;
    } finally {
      // Released as soon as broadcast returns. The nonce is committed to the mempool, so the
      // next request's `getTransactionCount(..., "pending")` will see nonce+1. Concurrent
      // /relay requests on the SAME chain serialize through this lock during broadcast, then
      // proceed in parallel after. Other chains' locks are independent.
      state.locked = false;
    }
  }

  /**
   * Get a transaction receipt by hash from a specific chain's provider.
   */
  async getTransactionReceipt(
    chainId: number,
    txHash: string,
  ): Promise<ethers.TransactionReceipt | null> {
    const state = this.chains.get(chainId);
    if (!state) {
      throw new Error(`WalletManager: chain ${chainId} is not configured`);
    }
    return state.provider.getTransactionReceipt(txHash);
  }

  /**
   * Estimate gas for a transaction on the specified chain.
   */
  async estimateGas(chainId: number, to: string, data: string): Promise<bigint> {
    const state = this.chains.get(chainId);
    if (!state) {
      throw new Error(`WalletManager: chain ${chainId} is not configured`);
    }
    return state.provider.estimateGas({
      from: state.wallet.address,
      to,
      data,
    });
  }

  /**
   * Clean expired entries from the dedup cache
   */
  cleanDedupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.txCache.entries()) {
      if (now - value.timestamp > this.DEDUP_TTL_MS) {
        this.txCache.delete(key);
      }
    }
  }
}
