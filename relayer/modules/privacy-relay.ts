/**
 * Privacy Relay Module
 *
 * Validates and submits shielded transactions on behalf of users.
 * Ensures the transaction targets an allowed contract and the fee
 * matches the advertised rate.
 */

import { RelayError } from "../types";
import type { RelayRequest, TransactionStatus } from "../types";
import type { WalletManager } from "./wallet-manager";
import type { FeeCalculator } from "./fee-calculator";
import type { VerifierContext } from "./broadcaster-fee-verifier";
import { verifyBroadcasterFee } from "./broadcaster-fee-verifier";
import { hubChain } from "../config";

// ============ Constants ============

/**
 * Known function selectors for allowed operations.
 *
 * Phase A2 scope (Option I — see `.claude/RELAYER_MEDIATION_PLAN.md`): vanilla `transact(...)`
 * only. The broadcaster-fee verifier consumes the SDK's decoder which is hard-coded to the
 * canonical `transact` / `relay` function names. Wrapper functions (atomicCrossChainUnshield,
 * lendAndShield, redeemAndShield) carry an embedded Transaction struct but the SDK won't
 * decode their outer signature — extending the verifier with extraction logic for each wrapper
 * ships alongside the handler PR that needs it (A4 for yield, A5 for atomicCrossChainUnshield).
 *
 * Until then, the wrapper selectors are off the allowlist so the relayer cannot accept a
 * request it cannot verify. This intentionally drops the legacy `usdc-v2-frontend` paths that
 * used those selectors; the active app (armada-interface) hasn't migrated any handler to
 * `submitRelay` yet (A3 starts that), so there's no live consumer to break.
 */
const ALLOWED_SELECTORS: Record<string, string> = {
  // PrivacyPool.transact(Transaction[]) — transfers and unshield-local
  "0xd8ae136a": "transact",
};

/**
 * Per-selector mapping into the FeeSchedule's per-op fee. The SDK doesn't tell us at the
 * selector level whether a `transact()` is a transfer or an unshield — both are valid. We use
 * MIN as the lower bound: the relayer accepts the smaller-quoted fee for either op type. In
 * practice transfer and unshield are quoted identically today (both gas-estimated at 500k),
 * so this is a robustness hedge, not a functional gap.
 */
function advertisedFeeForSelector(
  selector: string,
  fees: { transfer: string; unshield: string; crossContract: string; crossChainShield: string; crossChainUnshield: string },
): bigint {
  switch (selector) {
    case "0xd8ae136a": {
      const t = BigInt(fees.transfer);
      const u = BigInt(fees.unshield);
      return t < u ? t : u;
    }
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
  private feeCalculator: FeeCalculator;
  private allowedTargets: Set<string>;
  private verifierContext: VerifierContext;

  constructor(
    walletManager: WalletManager,
    feeCalculator: FeeCalculator,
    allowedContracts: { privacyPool: string; armadaYieldAdapter: string },
    verifierContext: VerifierContext,
  ) {
    this.walletManager = walletManager;
    this.feeCalculator = feeCalculator;
    this.verifierContext = verifierContext;

    // Normalize addresses to lowercase for comparison. ArmadaYieldAdapter stays in the set so
    // legacy routing (if reactivated) can find it; A2's effective allowlist is enforced via
    // ALLOWED_SELECTORS, which currently only accepts `transact(...)` on the PrivacyPool.
    this.allowedTargets = new Set([
      allowedContracts.privacyPool.toLowerCase(),
      allowedContracts.armadaYieldAdapter.toLowerCase(),
    ]);
  }

  /**
   * Validate and submit a relay request
   *
   * Checks:
   * 1. Chain ID matches hub chain
   * 2. Target contract is allowed (PrivacyPool or ArmadaYieldAdapter)
   * 3. Fee cache ID is valid and not expired
   * 4. Calldata has a recognized function selector
   * 5. Gas estimation succeeds (transaction won't revert)
   */
  async handleRelayRequest(
    request: RelayRequest
  ): Promise<{ txHash: string }> {
    const { chainId, to, data, feesCacheId } = request;

    // 1. Validate chain ID
    if (chainId !== hubChain.chainId) {
      throw new RelayError(
        "INVALID_CHAIN",
        `Unsupported chain ID: ${chainId}. Only hub chain (${hubChain.chainId}) is supported.`
      );
    }

    // 2. Validate target contract
    if (!to || !this.allowedTargets.has(to.toLowerCase())) {
      throw new RelayError(
        "INVALID_TARGET",
        `Target contract ${to} is not an allowed relay target. ` +
          `Allowed: ${Array.from(this.allowedTargets).join(", ")}`
      );
    }

    // 3. Validate fee cache ID
    if (!this.feeCalculator.validateFeesCacheId(feesCacheId)) {
      throw new RelayError(
        "FEE_EXPIRED",
        "Fee quote has expired or is invalid. Please re-fetch fees."
      );
    }

    // 4. Validate calldata
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
            .join(", ")}`
      );
    }

    // 5. Verify broadcaster fee — decrypt the proof's output to our wallet, confirm it pays at
    // least the advertised rate for this selector. This is the security-critical gate that
    // prevents a malicious client from submitting a $0-fee proof and burning the relayer's gas.
    // Runs BEFORE gas estimation so we don't pay an RPC call to learn the request will be
    // rejected anyway.
    const fees = await this.feeCalculator.getCurrentFees();
    const advertisedFee = advertisedFeeForSelector(selector, fees.fees);
    await verifyBroadcasterFee(this.verifierContext, { to, data }, advertisedFee);

    // 6. Check wallet availability
    if (this.walletManager.isLocked()) {
      throw new RelayError(
        "RELAYER_BUSY",
        "Relayer wallet is busy processing another transaction. Please retry shortly."
      );
    }

    // 7. Estimate gas to catch reverts early
    let gasEstimate: bigint;
    try {
      gasEstimate = await this.walletManager.estimateGas(to, data);
    } catch (e: any) {
      throw new RelayError(
        "GAS_ESTIMATION_FAILED",
        `Transaction would revert: ${e.message}`
      );
    }

    // Add 20% gas buffer
    const gasLimit = (gasEstimate * 120n) / 100n;

    console.log(
      `[privacy-relay] Relaying ${selectorName}() to ${to.slice(0, 10)}... ` +
        `(gas estimate: ${gasEstimate}, limit: ${gasLimit})`
    );

    // 8. Submit
    try {
      const result = await this.walletManager.submitTransaction(
        to,
        data,
        gasLimit
      );
      return { txHash: result.txHash };
    } catch (e: any) {
      if (e.message?.includes("Duplicate")) {
        throw new RelayError("DUPLICATE_TX", e.message);
      }
      throw new RelayError(
        "SUBMISSION_FAILED",
        `Transaction submission failed: ${e.message}`
      );
    }
  }

  /**
   * Get the status of a previously submitted transaction
   */
  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    const receipt = await this.walletManager.getTransactionReceipt(txHash);

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
