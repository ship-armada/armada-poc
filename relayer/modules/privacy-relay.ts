/**
 * Privacy Relay Module
 *
 * Multi-chain — validates and submits shielded transactions on behalf of users across the hub
 * and every client chain. Per-chain allow-lists scope the set of authorised targets so a leaked
 * wrapper address on one chain can't be invoked on another.
 *
 * Supported selectors fall into two families:
 *  - Proof-bearing (Phase A): `transact`, `lendAndShield`, `redeemAndShield`,
 *    `atomicCrossChainUnshield`. Fee is verified by decrypting the SNARK commitment
 *    ciphertext addressed to the relayer's `0zk` wallet (see broadcaster-fee-verifier.ts).
 *  - Permit-based (Phase B2): `gaslessShield` (hub), `gaslessCrossChainShield` (client). Fee is
 *    a plaintext uint256 inside the wrapper's calldata — verified directly without SDK
 *    decryption (see gasless-fee-verifier.ts).
 */

import { RelayError } from "../types";
import type { RelayRequest, TransactionStatus } from "../types";
import type { WalletManager } from "./wallet-manager";
import type { FeeCalculator } from "./fee-calculator";
import type { VerifierContext } from "./broadcaster-fee-verifier";
import { verifyBroadcasterFee } from "./broadcaster-fee-verifier";
import type { GaslessVerifierContext } from "./gasless-fee-verifier";
import {
  GASLESS_SHIELD_SELECTOR,
  GASLESS_CROSS_CHAIN_SHIELD_SELECTOR,
  verifyGaslessFee,
} from "./gasless-fee-verifier";
import type { Counters } from "./counters";

// ============ Constants ============

/**
 * Known function selectors for allowed operations.
 *
 * Phase A (proof-bearing):
 *   - `transact(Transaction[])` — vanilla. SDK decoder handles it directly.
 *   - `lendAndShield(Transaction, ...)` — yield deposit. A4 wrapper-decoder synthesises a
 *     vanilla `transact([txn])` from the embedded Transaction before the SDK decrypts.
 *   - `redeemAndShield(Transaction, ...)` — yield withdraw. Same wrapper path.
 *   - `atomicCrossChainUnshield(Transaction, ...)` — A5 cross-chain unshield. Same wrapper path:
 *     the embedded Transaction carries the broadcaster output, so the synthetic-transact rewrite
 *     finds the fee regardless of which surrounding CCTP args the wrapper added.
 *
 * Phase B2 (permit-based gasless):
 *   - `gaslessShield(...)` — hub `GaslessShieldWrapper`. Fee is the third uint256 in calldata;
 *     the wrapper's `transferFrom(user, relayer, fee)` step enforces payment atomically.
 *   - `gaslessCrossChainShield((permitInput),(dest))` — client `GaslessShieldWrapperClient`.
 *     Fee lives at `permitInput.fee`. Same atomic enforcement on the wrapper side.
 */
const ALLOWED_SELECTORS: Record<string, string> = {
  "0xd8ae136a": "transact",
  "0xf2987ad1": "lendAndShield",
  "0x0793b70e": "redeemAndShield",
  "0xe484d408": "atomicCrossChainUnshield",
  [GASLESS_SHIELD_SELECTOR]: "gaslessShield",
  [GASLESS_CROSS_CHAIN_SHIELD_SELECTOR]: "gaslessCrossChainShield",
};

const GASLESS_SELECTORS: ReadonlySet<string> = new Set([
  GASLESS_SHIELD_SELECTOR,
  GASLESS_CROSS_CHAIN_SHIELD_SELECTOR,
]);

/**
 * Per-selector mapping into the FeeSchedule's per-op fee. The SDK doesn't tell us at the
 * selector level whether a `transact()` is a transfer or an unshield — both are valid. We use
 * MIN as the lower bound: the relayer accepts the smaller-quoted fee for either op type. In
 * practice transfer and unshield are quoted identically today (both gas-estimated at 500k),
 * so this is a robustness hedge, not a functional gap.
 *
 * The yield wrappers map to `crossContract` — comparable gas profiles (both spend a UTXO, call
 * a vault, re-shield the result). `atomicCrossChainUnshield` maps to `crossChainUnshield`
 * (proof verifier + TokenMessenger.depositForBurnWithCaller — no Aave round-trip).
 *
 * Gasless wrapper selectors map to `shield` / `shieldXchain` — their gas profile is the wrapper
 * call + the underlying pool entry (`PrivacyPool.shield(...)` / `PrivacyPoolClient.crossChainShield(...)`).
 */
function advertisedFeeForSelector(
  selector: string,
  fees: {
    transfer: string;
    unshield: string;
    crossContract: string;
    crossChainShield: string;
    crossChainUnshield: string;
    shield: string;
    shieldXchain: string;
  },
): bigint {
  switch (selector) {
    case "0xd8ae136a": {
      const t = BigInt(fees.transfer);
      const u = BigInt(fees.unshield);
      return t < u ? t : u;
    }
    case "0xf2987ad1":
    case "0x0793b70e":
      return BigInt(fees.crossContract);
    case "0xe484d408":
      return BigInt(fees.crossChainUnshield);
    case GASLESS_SHIELD_SELECTOR:
      return BigInt(fees.shield);
    case GASLESS_CROSS_CHAIN_SHIELD_SELECTOR:
      return BigInt(fees.shieldXchain);
    default:
      // Defensive — the caller already gated on ALLOWED_SELECTORS, so this branch is unreachable.
      throw new RelayError(
        "INVALID_DATA",
        `No advertised-fee mapping for selector ${selector}.`,
      );
  }
}

// ============ Privacy Relay ============

export class PrivacyRelay {
  private walletManager: WalletManager;
  /** chainId → FeeCalculator. One quote per chain — gas costs differ materially per chain. */
  private feeCalculators: Map<number, FeeCalculator>;
  /** chainId → lowercase set of allowed target addresses (PrivacyPool + adapters + wrappers). */
  private allowedTargets: Map<number, Set<string>>;
  /** Proof-bearing fee verifier context (broadcaster fee decryption). Hub-only — Phase A. */
  private verifierContext: VerifierContext;
  /** Gasless-shield fee verifier context (wrapper address pinning). Multi-chain — Phase B2. */
  private gaslessVerifierContext: GaslessVerifierContext;
  private counters: Counters;

  constructor(
    walletManager: WalletManager,
    feeCalculators: Map<number, FeeCalculator>,
    allowedTargetsByChain: Map<number, string[]>,
    verifierContext: VerifierContext,
    gaslessVerifierContext: GaslessVerifierContext,
    counters: Counters,
  ) {
    this.walletManager = walletManager;
    this.feeCalculators = feeCalculators;
    this.verifierContext = verifierContext;
    this.gaslessVerifierContext = gaslessVerifierContext;
    this.counters = counters;

    // Normalize allowed-target addresses to lowercase. Each chain's set is independent so a
    // wrapper address valid on Base Sepolia isn't silently authorised on Ethereum Sepolia even
    // if the deployed addresses happen to collide.
    this.allowedTargets = new Map();
    for (const [chainId, addrs] of allowedTargetsByChain.entries()) {
      this.allowedTargets.set(chainId, new Set(addrs.map((a) => a.toLowerCase())));
    }
  }

  /**
   * Validate and submit a relay request.
   *
   * Checks:
   * 1. Chain ID is a configured chain
   * 2. Target contract is allow-listed for THAT chain
   * 3. Fee cache ID matches the chain's schedule and hasn't expired
   * 4. Selector is in ALLOWED_SELECTORS
   * 5. Fee verification passes — proof-decryption for Phase A selectors, calldata-decode for
   *    Phase B gasless selectors
   * 6. Gas estimation succeeds (catches reverts pre-submit)
   * 7. Submit
   */
  async handleRelayRequest(
    request: RelayRequest,
  ): Promise<{ txHash: string }> {
    const { chainId, to, data, feesCacheId } = request;

    // 1. Validate chain ID — must be one of the configured chains
    const feeCalculator = this.feeCalculators.get(chainId);
    const allowedForChain = this.allowedTargets.get(chainId);
    if (!feeCalculator || !allowedForChain) {
      throw new RelayError(
        "INVALID_CHAIN",
        `Unsupported chain ID: ${chainId}. Configured: ${Array.from(this.feeCalculators.keys()).join(", ")}`,
      );
    }

    // 2. Validate target contract (per-chain allow-list)
    if (!to || !allowedForChain.has(to.toLowerCase())) {
      throw new RelayError(
        "INVALID_TARGET",
        `Target contract ${to} is not allowed on chain ${chainId}. ` +
          `Allowed: ${Array.from(allowedForChain).join(", ")}`,
      );
    }

    // 3. Resolve the EXACT schedule this quote's cacheId was issued from (current, or the one-deep
    // previous if still within the variance buffer). We verify the paid fee against THIS schedule's
    // prices below — never a freshly-regenerated one — so honest proofs built against a quote that
    // expired mid-flight aren't spuriously rejected by an upward gas-price re-quote.
    const quotedSchedule = feeCalculator.getScheduleByCacheId(feesCacheId);
    if (!quotedSchedule) {
      throw new RelayError(
        "FEE_EXPIRED",
        `Fee quote has expired or is invalid for chain ${chainId}. Please re-fetch fees.`,
      );
    }

    // 4. Validate calldata + selector
    if (!data || data.length < 10) {
      throw new RelayError("INVALID_DATA", "Transaction data is empty or too short.");
    }
    const selector = data.slice(0, 10);
    const selectorName = ALLOWED_SELECTORS[selector];
    if (!selectorName) {
      throw new RelayError(
        "INVALID_DATA",
        `Unknown function selector: ${selector}. ` +
          `Allowed: ${Object.entries(ALLOWED_SELECTORS)
            .map(([s, n]) => `${n}(${s})`)
            .join(", ")}`,
      );
    }

    // 5. Verify fee. Two paths:
    //    - Gasless wrapper selectors: fee is a plaintext uint256 argument; verifier reads it
    //      directly and asserts the wrapper target matches the configured per-chain wrapper.
    //    - Proof-bearing selectors: fee is encrypted inside a SNARK commitment ciphertext;
    //      verifier decrypts under the relayer's viewing key. Hub-only today — Phase A doesn't
    //      run any non-hub proof-bearing flow.
    const advertisedFee = advertisedFeeForSelector(selector, quotedSchedule.fees);
    try {
      if (GASLESS_SELECTORS.has(selector)) {
        verifyGaslessFee(
          this.gaslessVerifierContext,
          { chainId, to, data },
          advertisedFee,
        );
      } else {
        await verifyBroadcasterFee(this.verifierContext, { to, data }, advertisedFee);
      }
    } catch (e) {
      if (e instanceof RelayError) {
        this.counters.inc(`feeVerifierRejects.${e.code}`);
      }
      throw e;
    }

    // 6. Per-chain wallet availability
    if (this.walletManager.isLocked(chainId)) {
      throw new RelayError(
        "RELAYER_BUSY",
        `Relayer wallet on chain ${chainId} is busy processing another transaction. Please retry shortly.`,
      );
    }

    // 7. Estimate gas to catch reverts early
    let gasEstimate: bigint;
    try {
      gasEstimate = await this.walletManager.estimateGas(chainId, to, data);
    } catch (e: any) {
      throw new RelayError(
        "GAS_ESTIMATION_FAILED",
        `Transaction would revert: ${e.message}`,
      );
    }

    // Add 20% gas buffer
    const gasLimit = (gasEstimate * 120n) / 100n;

    console.log(
      `[privacy-relay] Relaying ${selectorName}() chain=${chainId} to=${to.slice(0, 10)}... ` +
        `(gas estimate: ${gasEstimate}, limit: ${gasLimit})`,
    );

    // 8. Submit
    try {
      const result = await this.walletManager.submitTransaction(
        chainId,
        to,
        data,
        gasLimit,
      );
      this.counters.inc(`submitSuccess.${selectorName}`);
      return { txHash: result.txHash };
    } catch (e: any) {
      const code = e.message?.includes("Duplicate") ? "DUPLICATE_TX" : "SUBMISSION_FAILED";
      this.counters.inc(`submitFail.${selectorName}.${code}`);
      if (code === "DUPLICATE_TX") {
        throw new RelayError("DUPLICATE_TX", e.message);
      }
      throw new RelayError(
        "SUBMISSION_FAILED",
        `Transaction submission failed: ${e.message}`,
      );
    }
  }

  /**
   * Get the status of a previously submitted transaction.
   *
   * `chainId` is optional for backward compatibility — existing frontend callers
   * (`pollRelayStatusOnce(txHash)`) don't pass it. When omitted, query every configured chain
   * in parallel and return the first non-null receipt. The N=3 fan-out is cheap for status
   * polling cadences (one tick per ~5s per tx); a future tightening can require the chainId
   * once handler-side meta carries it through the lifecycle.
   */
  async getTransactionStatus(
    txHash: string,
    chainId?: number,
  ): Promise<TransactionStatus> {
    let receipt: Awaited<ReturnType<WalletManager["getTransactionReceipt"]>> | null = null;

    if (chainId !== undefined) {
      receipt = await this.walletManager.getTransactionReceipt(chainId, txHash);
    } else {
      const supported = this.walletManager.supportedChains();
      const receipts = await Promise.all(
        supported.map((id) =>
          this.walletManager
            .getTransactionReceipt(id, txHash)
            .catch(() => null),
        ),
      );
      receipt = receipts.find((r) => r !== null) ?? null;
    }

    if (!receipt) {
      return { status: "pending" };
    }

    if (receipt.status === 1) {
      return {
        status: "confirmed",
        blockNumber: receipt.blockNumber,
      };
    }

    return {
      status: "failed",
      blockNumber: receipt.blockNumber,
      error: "Transaction reverted on-chain",
    };
  }
}
