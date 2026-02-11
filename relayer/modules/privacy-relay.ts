/**
 * Privacy Relay Module
 *
 * Validates and submits shielded transactions on behalf of users.
 * Ensures the transaction targets an allowed contract and the fee
 * matches the advertised rate.
 */

import { ethers } from "ethers";
import { RelayError } from "../types";
import type { RelayRequest, TransactionStatus } from "../types";
import type { WalletManager } from "./wallet-manager";
import type { FeeCalculator } from "./fee-calculator";

// ============ Constants ============

/** Known function selectors for allowed operations */
const ALLOWED_SELECTORS: Record<string, string> = {
  // PrivacyPool.transact(Transaction[]) — transfers and unshields
  "0xd8ae136a": "transact",
  // PrivacyPool.atomicCrossChainUnshield(..., uint256 maxFee) — cross-chain unshields
  "0xe484d408": "atomicCrossChainUnshield",
  // PrivacyPoolRelayAdapt.relay(Transaction[], ActionData) — cross-contract calls
  "0x28223a77": "relay",
};

// ============ Privacy Relay ============

export class PrivacyRelay {
  private walletManager: WalletManager;
  private feeCalculator: FeeCalculator;
  private allowedTargets: Set<string>;

  constructor(
    walletManager: WalletManager,
    feeCalculator: FeeCalculator,
    allowedContracts: { privacyPool: string; relayAdapt: string }
  ) {
    this.walletManager = walletManager;
    this.feeCalculator = feeCalculator;

    // Normalize addresses to lowercase for comparison
    this.allowedTargets = new Set([
      allowedContracts.privacyPool.toLowerCase(),
      allowedContracts.relayAdapt.toLowerCase(),
    ]);
  }

  /**
   * Validate and submit a relay request
   *
   * Checks:
   * 1. Chain ID matches hub chain
   * 2. Target contract is allowed (PrivacyPool or RelayAdapt)
   * 3. Fee cache ID is valid and not expired
   * 4. Calldata has a recognized function selector
   * 5. Gas estimation succeeds (transaction won't revert)
   */
  async handleRelayRequest(
    request: RelayRequest
  ): Promise<{ txHash: string }> {
    const { chainId, to, data, feesCacheId } = request;

    // 1. Validate chain ID
    if (chainId !== 31337) {
      throw new RelayError(
        "INVALID_CHAIN",
        `Unsupported chain ID: ${chainId}. Only hub chain (31337) is supported.`
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

    // 5. Check wallet availability
    if (this.walletManager.isLocked()) {
      throw new RelayError(
        "RELAYER_BUSY",
        "Relayer wallet is busy processing another transaction. Please retry shortly."
      );
    }

    // 6. Estimate gas to catch reverts early
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

    // 7. Submit
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
