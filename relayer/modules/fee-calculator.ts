/**
 * Fee Calculator
 *
 * Calculates relayer fees in USDC for each operation type.
 * Manages fee schedule caching and validation.
 *
 * Fee formula:
 *   gasEstimate × gasPrice × (ethPrice / usdcPrice) × (1 + profitMargin)
 *
 * For local POC:
 *   - Gas estimates are hardcoded per operation type
 *   - ETH/USDC price is hardcoded (2000)
 *   - Gas price is fetched from the hub provider
 */

import { ethers } from "ethers";
import { armadaRelayerSettings } from "../config";
import type { FeeSchedule } from "../types";
import type { WalletManager } from "./wallet-manager";

// ============ Constants ============

/** Gas estimates per operation type (conservative) */
const GAS_ESTIMATES: Record<string, bigint> = {
  transfer: 500_000n,
  unshield: 500_000n,
  crossContract: 2_000_000n,
  crossChainShield: 500_000n,
  crossChainUnshield: 500_000n,
};

/** USDC has 6 decimals */
const USDC_DECIMALS = 6n;
const USDC_UNIT = 10n ** USDC_DECIMALS;

// ============ Fee Calculator ============

export class FeeCalculator {
  private walletManager: WalletManager;
  private currentSchedule: FeeSchedule | null = null;
  private scheduleCounter = 0;

  private profitMarginBps: number;
  private ethUsdcPrice: number;
  private feeTtlSeconds: number;
  private feeVarianceBufferBps: number;

  constructor(walletManager: WalletManager) {
    this.walletManager = walletManager;
    this.profitMarginBps = armadaRelayerSettings.profitMarginBps;
    this.ethUsdcPrice = armadaRelayerSettings.ethUsdcPrice;
    this.feeTtlSeconds = armadaRelayerSettings.feeTtlSeconds;
    this.feeVarianceBufferBps = armadaRelayerSettings.feeVarianceBufferBps;
  }

  /**
   * Calculate fee in USDC raw units for a given gas estimate
   *
   * fee = gasEstimate × gasPrice × (ethPrice / 1e18) × (1 + margin)
   * Result in USDC raw units (6 decimals)
   */
  private async calculateFeeForGas(gasEstimate: bigint): Promise<bigint> {
    const provider = this.walletManager.getProvider();
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || 1_000_000_000n; // Default 1 gwei

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
   * Generate a new fee schedule
   */
  async generateFeeSchedule(): Promise<FeeSchedule> {
    const [transferFee, unshieldFee, crossContractFee, crossChainShieldFee, crossChainUnshieldFee] =
      await Promise.all([
        this.calculateFeeForGas(GAS_ESTIMATES.transfer),
        this.calculateFeeForGas(GAS_ESTIMATES.unshield),
        this.calculateFeeForGas(GAS_ESTIMATES.crossContract),
        this.calculateFeeForGas(GAS_ESTIMATES.crossChainShield),
        this.calculateFeeForGas(GAS_ESTIMATES.crossChainUnshield),
      ]);

    this.scheduleCounter++;
    const cacheId = `fee-${Date.now()}-${this.scheduleCounter}`;

    this.currentSchedule = {
      cacheId,
      expiresAt: Date.now() + this.feeTtlSeconds * 1000,
      chainId: 31337, // Hub chain
      fees: {
        transfer: transferFee.toString(),
        unshield: unshieldFee.toString(),
        crossContract: crossContractFee.toString(),
        crossChainShield: crossChainShieldFee.toString(),
        crossChainUnshield: crossChainUnshieldFee.toString(),
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
   * Validate that a fee cache ID is still valid
   *
   * @returns true if the cacheId matches the current schedule and hasn't expired
   */
  validateFeesCacheId(cacheId: string): boolean {
    if (!this.currentSchedule) return false;
    if (this.currentSchedule.cacheId !== cacheId) return false;

    // Allow some buffer beyond expiry for in-flight requests
    const bufferMs =
      (this.feeTtlSeconds * 1000 * this.feeVarianceBufferBps) / 10000;
    return Date.now() < this.currentSchedule.expiresAt + bufferMs;
  }

  /**
   * Get the fee for a specific operation type from the current schedule
   */
  getFeeForOperation(
    operationType: "transfer" | "unshield" | "crossContract" | "crossChainShield" | "crossChainUnshield"
  ): string | null {
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
