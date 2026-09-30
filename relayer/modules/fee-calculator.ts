/**
 * Fee Calculator
 *
 * Calculates relayer fees in USDC for each operation type. One instance per chain — gas costs
 * differ materially across chains (Ethereum Sepolia ~10x Base Sepolia), so quoting from a single
 * hub-only provider would over- or under-charge users transacting on other chains.
 *
 * Fee formula:
 *   fee = gasEstimate × gasPrice × (ethUsdcPrice / 1e18) × (1 + profitMargin) × 1e6
 *
 * For the POC:
 *   - Gas estimates are hardcoded per operation type (covers each tx kind we relay)
 *   - ETH/USDC price is hardcoded (`armadaRelayerSettings.ethUsdcPrice`); production would
 *     read an oracle
 *   - Gas price is fetched per-chain from that chain's provider
 */

import { ethers } from "ethers";
import { armadaRelayerSettings } from "../config";
import type { FeeSchedule } from "../types";

// ============ Constants ============

/**
 * Gas estimates per operation type. Tuned to the actual gas measured by the B1 Foundry tests +
 * a small safety bump (~5-10%). The relayer ALSO applies a 20% gas-limit buffer at submit time
 * (`privacy-relay.ts::gasLimit = gasEstimate * 120 / 100`), so the on-chain limit lands at
 * `(estimate × 1.2)` which absorbs sub-20% real-world drift in either direction.
 *
 *  - Phase A tiers (transfer/unshield/crossContract/crossChainShield/crossChainUnshield): kept
 *    at their historical values because Phase A handlers were measured against these and shipped
 *    without complaint. Re-tune if Phase A operator economics drift.
 *  - Phase B tiers (shield/shieldXchain): tuned to B1's gas reports:
 *      - GaslessShieldWrapper.gaslessShield ~285k actual → 300k estimate (5% safety)
 *      - GaslessShieldWrapperClient.gaslessCrossChainShield ~330k + CCTP burn overhead → 400k
 *    Combined with profitMarginBps=0 (POC default), the user-visible fee tracks actual on-chain
 *    cost closely. The relayer absorbs gas-price drift within the 5-min quote TTL — acceptable
 *    for team-run testnet infra; bump margin + estimates before mainnet rollout.
 */
const GAS_ESTIMATES: Record<string, bigint> = {
  transfer: 500_000n,
  unshield: 500_000n,
  crossContract: 2_000_000n,
  crossChainShield: 500_000n,
  crossChainUnshield: 500_000n,
  shield: 300_000n,
  shieldXchain: 400_000n,
};

/** USDC has 6 decimals */
const USDC_DECIMALS = 6n;
const USDC_UNIT = 10n ** USDC_DECIMALS;

/**
 * CCTP fast transfer fee buffer in basis points.
 * Actual fees: Ethereum/Solana 1 bps, L2s (Arbitrum, Base, OP) 1.3 bps.
 * We use 2 bps as a conservative buffer to cover all chains.
 * Applied on top of gas fees for cross-chain operations when fast mode is enabled.
 */
const CCTP_FAST_FEE_BPS = 2n;

/** Operation keys exposed in the FeeSchedule's `fees` object. */
export type FeeOperation =
  | "transfer"
  | "unshield"
  | "crossContract"
  | "crossChainShield"
  | "crossChainUnshield"
  | "shield"
  | "shieldXchain";

// ============ Fee Calculator ============

export class FeeCalculator {
  private provider: ethers.JsonRpcProvider;
  private chainId: number;
  private currentSchedule: FeeSchedule | null = null;
  /**
   * The immediately-prior schedule, kept so a quote issued just before a regeneration is still
   * honoured (and verified against ITS OWN prices) for the variance-buffer window. Regeneration
   * happens at most once per TTL, so one-deep history is sufficient.
   */
  private previousSchedule: FeeSchedule | null = null;
  private scheduleCounter = 0;

  private profitMarginBps: number;
  private shieldFeeBps: number;
  private ethUsdcPrice: number;
  private feeTtlSeconds: number;
  private feeVarianceBufferBps: number;
  private broadcasterRailgunAddress: string;

  private cctpFastMode: boolean;

  /**
   * @param provider EVM provider for THIS chain — used to read gas price for the quote.
   * @param chainId The chainId quoted in every schedule this instance produces. Frontends use
   *        this to disambiguate the multi-chain `/fees?chainId=X` responses.
   * @param broadcasterRailgunAddress The relayer's `0zk` address, derived at boot from the
   *        Railgun wallet. Published verbatim on `/fees` so clients route their proof's
   *        broadcaster output here. Must be a non-empty string; the relayer refuses to boot when
   *        the wallet derivation fails (see armada-relayer.ts).
   */
  constructor(
    provider: ethers.JsonRpcProvider,
    chainId: number,
    broadcasterRailgunAddress: string,
  ) {
    this.provider = provider;
    this.chainId = chainId;
    this.profitMarginBps = armadaRelayerSettings.profitMarginBps;
    this.shieldFeeBps = armadaRelayerSettings.shieldFeeBps;
    this.ethUsdcPrice = armadaRelayerSettings.ethUsdcPrice;
    this.feeTtlSeconds = armadaRelayerSettings.feeTtlSeconds;
    this.feeVarianceBufferBps = armadaRelayerSettings.feeVarianceBufferBps;
    this.broadcasterRailgunAddress = broadcasterRailgunAddress;
    this.cctpFastMode = armadaRelayerSettings.cctpFinalityMode === "fast";
  }

  /**
   * Calculate fee in USDC raw units for a given gas estimate
   *
   * fee = gasEstimate × gasPrice × (ethPrice / 1e18) × (1 + margin)
   * Result in USDC raw units (6 decimals)
   *
   * `gasPrice` is passed in rather than read here: `generateFeeSchedule` prices all seven
   * operation tiers off a single gas-price reading, so the tiers are mutually consistent
   * and a schedule regeneration costs one RPC round-trip instead of one per tier.
   */
  private calculateFeeForGas(gasEstimate: bigint, gasPrice: bigint): bigint {
    // Gas cost in wei
    const gasCostWei = gasEstimate * gasPrice;

    // Convert wei to USDC:
    // gasCostUSDC = gasCostWei * ethUsdcPrice / 1e18
    // But we want USDC in 6-decimal raw units, so:
    // gasCostUSDC_raw = gasCostWei * ethUsdcPrice * 1e6 / 1e18
    //                 = gasCostWei * ethUsdcPrice / 1e12
    const ethPrice = BigInt(this.ethUsdcPrice);
    const gasCostUsdc = (gasCostWei * ethPrice * USDC_UNIT) / 10n ** 18n;

    // Apply profit margin
    const marginMultiplier = 10000n + BigInt(this.profitMarginBps);
    const feeWithMargin = (gasCostUsdc * marginMultiplier) / 10000n;

    // Enforce a minimum fee of 0.01 USDC (10000 raw) to prevent dust fees
    const minFee = 10_000n;
    return feeWithMargin > minFee ? feeWithMargin : minFee;
  }

  /**
   * Gross up a NET gas-reimbursement fee so that after the pool's shield fee is charged on the fee
   * NOTE, the relayer still nets the target. `gross = ceil(net × 10000 / (10000 − shieldFeeBps))`.
   *
   * Only the gasless shield tiers (`shield` / `shieldXchain`) are paid via a shield note, so only
   * they are grossed up — the Phase A tiers are paid as SNARK broadcaster outputs (no shield fee).
   */
  private grossUpForShieldFee(net: bigint): bigint {
    const bps = BigInt(this.shieldFeeBps);
    if (bps <= 0n) return net;
    const denom = 10000n - bps;
    // Ceil division so the relayer nets >= target after the (floored) on-chain shield fee.
    return (net * 10000n + denom - 1n) / denom;
  }

  /**
   * Calculate the CCTP fast transfer fee for a given transfer amount.
   * Returns 0 in standard mode.
   *
   * @param transferAmount Estimated transfer amount in USDC raw units
   * @returns CCTP fast fee in USDC raw units
   */
  private calculateCCTPFastFee(transferAmount: bigint): bigint {
    if (!this.cctpFastMode) return 0n;
    return (transferAmount * CCTP_FAST_FEE_BPS) / 10000n;
  }

  /**
   * Generate a new fee schedule for THIS chain.
   *
   * All operation keys are populated regardless of which chain this is. The semantics are
   * per-chain — on the hub schedule, `shield` is the meaningful Phase B key (no `shieldXchain`
   * use); on a client schedule, `shieldXchain` is the meaningful key. Uniformity keeps the wire
   * type simple and lets callers read whichever key applies to their kind without conditional
   * shape narrowing.
   */
  async generateFeeSchedule(): Promise<FeeSchedule> {
    // Single gas-price read per schedule — see calculateFeeForGas doc. getFeeData is the only
    // RPC call in schedule generation, and all seven tiers are priced off this one reading.
    const feeData = await this.provider.getFeeData();
    // Some EIP-1559-only RPCs return a null `gasPrice` (they only populate maxFeePerGas /
    // maxPriorityFeePerGas). Fall back to maxFeePerGas before the 1-gwei floor so we don't silently
    // under-quote on those chains; warn loudly if BOTH are missing (the 1-gwei default would
    // materially under-price a real chain).
    let gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? null;
    if (gasPrice === null) {
      console.warn(
        `[fee-calculator chain=${this.chainId}] getFeeData() returned neither gasPrice nor maxFeePerGas — ` +
          `falling back to 1 gwei. Quotes on this chain may be under-priced; investigate the RPC.`,
      );
      gasPrice = 1_000_000_000n;
    }

    const transferFee = this.calculateFeeForGas(GAS_ESTIMATES.transfer, gasPrice);
    const unshieldFee = this.calculateFeeForGas(GAS_ESTIMATES.unshield, gasPrice);
    const crossContractFee = this.calculateFeeForGas(GAS_ESTIMATES.crossContract, gasPrice);
    const crossChainShieldFee = this.calculateFeeForGas(GAS_ESTIMATES.crossChainShield, gasPrice);
    const crossChainUnshieldFee = this.calculateFeeForGas(GAS_ESTIMATES.crossChainUnshield, gasPrice);
    // Gasless shield tiers are paid via a shielded fee note that the pool charges its shield fee on,
    // so gross up the gas-reimbursement target to keep the relayer whole (see grossUpForShieldFee).
    const shieldFee = this.grossUpForShieldFee(this.calculateFeeForGas(GAS_ESTIMATES.shield, gasPrice));
    const shieldXchainFee = this.grossUpForShieldFee(
      this.calculateFeeForGas(GAS_ESTIMATES.shieldXchain, gasPrice),
    );

    // In fast mode, add CCTP fast transfer fee estimate to cross-chain operations.
    // The fee is proportional to transfer amount, but since we don't know the
    // amount yet, we use the gas-based fee as a conservative estimate.
    // The actual CCTP fee (1-1.3 bps of the transfer amount) is handled on-chain.
    // This is informational for the user's fee display.
    const cctpFastFeeNote = this.cctpFastMode
      ? " (+ ~1-2 bps CCTP fast transfer fee on transfer amount)"
      : "";
    if (cctpFastFeeNote) {
      console.log(`[fee-calculator chain=${this.chainId}] CCTP fast mode enabled${cctpFastFeeNote}`);
    }

    this.scheduleCounter++;
    // CacheId includes chainId so a stale quote from one chain cannot be replayed as a
    // valid quote on another (the PrivacyRelay validates the cacheId against the schedule for
    // the request's chainId, so this is defense-in-depth — humans grep-debugging cacheIds also
    // see which chain they belong to).
    const cacheId = `fee-${this.chainId}-${Date.now()}-${this.scheduleCounter}`;

    // Demote the outgoing schedule to `previousSchedule` so an in-flight quote built against it is
    // still resolvable (and verified against its own prices) within the variance buffer.
    this.previousSchedule = this.currentSchedule;

    this.currentSchedule = {
      cacheId,
      expiresAt: Date.now() + this.feeTtlSeconds * 1000,
      chainId: this.chainId,
      broadcasterRailgunAddress: this.broadcasterRailgunAddress,
      fees: {
        transfer: transferFee.toString(),
        unshield: unshieldFee.toString(),
        crossContract: crossContractFee.toString(),
        crossChainShield: crossChainShieldFee.toString(),
        crossChainUnshield: crossChainUnshieldFee.toString(),
        shield: shieldFee.toString(),
        shieldXchain: shieldXchainFee.toString(),
      },
    };

    return this.currentSchedule;
  }

  /**
   * Get the current fee schedule, generating a new one if expired or missing
   */
  async getCurrentFees(): Promise<FeeSchedule> {
    if (!this.currentSchedule || Date.now() >= this.currentSchedule.expiresAt) {
      return this.generateFeeSchedule();
    }
    return this.currentSchedule;
  }

  /**
   * Resolve the schedule a quote's cacheId was issued from — current OR the one-deep previous —
   * provided it is still within its own expiry + variance buffer. Returns null when the cacheId
   * matches neither or has aged out.
   *
   * This is what makes the variance buffer actually work: a quote issued just before a
   * regeneration resolves to the PREVIOUS schedule and is verified against THAT schedule's prices,
   * instead of being silently re-priced against freshly-regenerated (possibly higher) gas. The
   * caller (PrivacyRelay) MUST use the returned schedule's fees, not a fresh getCurrentFees().
   */
  getScheduleByCacheId(cacheId: string): FeeSchedule | null {
    const bufferMs = (this.feeTtlSeconds * 1000 * this.feeVarianceBufferBps) / 10000;
    const now = Date.now();
    for (const schedule of [this.currentSchedule, this.previousSchedule]) {
      if (schedule && schedule.cacheId === cacheId && now < schedule.expiresAt + bufferMs) {
        return schedule;
      }
    }
    return null;
  }

  /**
   * Validate that a fee cache ID is still valid (matches current or previous schedule, within the
   * variance buffer). Thin wrapper over getScheduleByCacheId.
   *
   * @returns true if the cacheId resolves to a still-valid schedule.
   */
  validateFeesCacheId(cacheId: string): boolean {
    return this.getScheduleByCacheId(cacheId) !== null;
  }

  /**
   * Get the fee for a specific operation type from the current schedule
   */
  getFeeForOperation(operationType: FeeOperation): string | null {
    if (!this.currentSchedule) return null;
    return this.currentSchedule.fees[operationType];
  }

  /**
   * Format a raw USDC fee for display
   */
  static formatUsdcFee(rawFee: string): string {
    const value = BigInt(rawFee);
    const whole = value / USDC_UNIT;
    const fraction = value % USDC_UNIT;
    return `${whole}.${fraction.toString().padStart(6, "0")} USDC`;
  }
}
