/**
 * Wallet Manager
 *
 * Manages the relayer's hot wallet for transaction submission.
 * Fetches fresh nonce from chain before each tx (shared account with CCTP relay).
 * Handles wallet locking and gas balance monitoring.
 */

import { ethers } from "ethers";
import { accounts, hubChain } from "../config";

// ============ Types ============

interface SubmitResult {
  txHash: string;
}

// ============ Wallet Manager ============

export class WalletManager {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private locked: boolean = false;
  private txCache: Map<string, { txHash: string; timestamp: number }> =
    new Map();

  /** Dedup cache TTL in ms (10 minutes) */
  private readonly DEDUP_TTL_MS = 10 * 60 * 1000;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(hubChain.rpc);
    this.wallet = new ethers.Wallet(accounts.deployer.privateKey, this.provider);
  }

  /**
   * Initialize: verify connection and check balance
   */
  async initialize(): Promise<void> {
    const blockNumber = await this.provider.getBlockNumber();
    const nonce = await this.provider.getTransactionCount(
      this.wallet.address,
      "pending"
    );
    const balance = await this.provider.getBalance(this.wallet.address);
    const ethBalance = ethers.formatEther(balance);

    console.log(`[wallet-manager] Initialized`);
    console.log(`  Address: ${this.wallet.address}`);
    console.log(`  Next nonce: ${nonce}`);
    console.log(`  ETH Balance: ${ethBalance}`);
    console.log(`  Block: ${blockNumber}`);

    if (parseFloat(ethBalance) < 0.1) {
      console.warn(`[wallet-manager] WARNING: Low ETH balance (${ethBalance})`);
    }
  }

  /**
   * Get the relayer's Ethereum address
   */
  get address(): string {
    return this.wallet.address;
  }

  /**
   * Get the hub chain provider
   */
  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  /**
   * Check if the wallet is currently locked (processing a transaction)
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Submit a transaction from the relayer wallet
   *
   * @param to - Target contract address
   * @param data - Encoded calldata
   * @param gasLimit - Optional gas limit override
   * @returns Transaction hash and receipt
   */
  async submitTransaction(
    to: string,
    data: string,
    gasLimit?: bigint
  ): Promise<SubmitResult> {
    if (this.locked) {
      throw new Error("Wallet is locked — another transaction is in progress");
    }

    // Check dedup cache
    const dataHash = ethers.keccak256(
      ethers.solidityPacked(["address", "bytes"], [to, data])
    );
    const cached = this.txCache.get(dataHash);
    if (cached && Date.now() - cached.timestamp < this.DEDUP_TTL_MS) {
      throw new Error(
        `Duplicate transaction (already submitted as ${cached.txHash})`
      );
    }

    this.locked = true;

    try {
      // Always fetch fresh nonce from chain. WalletManager shares the deployer
      // account with CCTPRelayModule; CCTP may have submitted txs (e.g. receiveMessage
      // for cross-chain deposits) that consumed nonces. Caching would cause
      // "nonce already used" when Privacy Relay submits after CCTP.
      const nonce = await this.provider.getTransactionCount(
        this.wallet.address,
        "pending"
      );

      // Estimate gas if not provided
      let estimatedGas = gasLimit;
      if (!estimatedGas) {
        try {
          const estimate = await this.provider.estimateGas({
            from: this.wallet.address,
            to,
            data,
          });
          // Add 20% buffer
          estimatedGas = (estimate * 120n) / 100n;
        } catch (e: any) {
          throw new Error(`Gas estimation failed: ${e.message}`);
        }
      }

      console.log(
        `[wallet-manager] Submitting tx (nonce=${nonce}, gas=${estimatedGas})`
      );
      console.log(`  To: ${to}`);
      console.log(`  Data: ${data.slice(0, 10)}... (${(data.length - 2) / 2} bytes)`);

      const tx = await this.wallet.sendTransaction({
        to,
        data,
        nonce,
        gasLimit: estimatedGas,
      });

      console.log(`[wallet-manager] Tx submitted: ${tx.hash}`);

      // Cache for dedup at broadcast — a future identical request hits the cache instead of
      // re-broadcasting with a fresh nonce. The mempool already has the tx; we don't need
      // confirmation to know it's "ours".
      this.txCache.set(dataHash, { txHash: tx.hash, timestamp: Date.now() });

      // Track the receipt in the background for operator-side revert logging. The HTTP response
      // doesn't wait on this — the frontend polls /status/:txHash, which observes the receipt
      // directly via provider.getTransactionReceipt. Waiting on tx.wait() inside the /relay
      // handler used to keep the HTTP connection open for the full block time, which intermediary
      // proxies (Cloudflare etc.) often cut at 60-100s — surfacing in the browser as a "Failed to
      // fetch" / no-CORS error even though the broadcast itself succeeded.
      void tx
        .wait()
        .then((receipt) => {
          if (!receipt) {
            console.warn(`[wallet-manager] Tx ${tx.hash} confirmed without receipt`);
            return;
          }
          if (receipt.status === 0) {
            console.error(`[wallet-manager] Tx reverted: ${tx.hash}`);
            return;
          }
          console.log(
            `[wallet-manager] Tx confirmed in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed})`
          );
        })
        .catch((err) => {
          console.warn(
            `[wallet-manager] Background receipt tracking failed for ${tx.hash}: ${err?.message ?? err}`
          );
        });

      return { txHash: tx.hash };
    } catch (e: any) {
      if (
        e.message?.includes("nonce") ||
        e.message?.includes("NONCE") ||
        e.code === "NONCE_EXPIRED"
      ) {
        console.warn(
          "[wallet-manager] Nonce error (another process may have used the account)"
        );
      }
      throw e;
    } finally {
      // Released as soon as broadcast returns. The nonce is committed to the mempool, so the next
      // request's `getTransactionCount(..., "pending")` will see nonce+1. Concurrent /relay
      // requests serialise through this lock during broadcast, then proceed in parallel after.
      this.locked = false;
    }
  }

  /**
   * Get a transaction receipt by hash
   */
  async getTransactionReceipt(
    txHash: string
  ): Promise<ethers.TransactionReceipt | null> {
    return this.provider.getTransactionReceipt(txHash);
  }

  /**
   * Estimate gas for a transaction
   */
  async estimateGas(to: string, data: string): Promise<bigint> {
    return this.provider.estimateGas({
      from: this.wallet.address,
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
