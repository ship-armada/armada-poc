/**
 * Shared types for the Armada Relayer
 */

// ============ Fee Types ============

export interface FeeSchedule {
  cacheId: string;
  expiresAt: number; // Unix timestamp ms
  chainId: number;
  fees: {
    /** Fee in USDC raw units (6 decimals) for private transfers */
    transfer: string;
    /** Fee in USDC raw units for unshields */
    unshield: string;
    /** Fee in USDC raw units for cross-contract calls (relay()) */
    crossContract: string;
    /** Fee in USDC raw units for cross-chain shield hub-side execution */
    crossChainShield: string;
    /** Fee in USDC raw units for cross-chain unshield client-side relay */
    crossChainUnshield: string;
  };
}

// ============ Relay Types ============

export interface RelayRequest {
  chainId: number;
  to: string;
  data: string;
  feesCacheId: string;
}

export interface RelayResponse {
  txHash: string;
  status: "pending" | "confirmed" | "failed";
}

export interface TransactionStatus {
  status: "pending" | "confirmed" | "failed";
  blockNumber?: number;
  error?: string;
}

// ============ Error Types ============

export type RelayErrorCode =
  | "FEE_TOO_LOW"
  | "FEE_EXPIRED"
  | "INVALID_TARGET"
  | "INVALID_CHAIN"
  | "INVALID_DATA"
  | "GAS_ESTIMATION_FAILED"
  | "DUPLICATE_TX"
  | "RELAYER_BUSY"
  | "SUBMISSION_FAILED"
  | "UNKNOWN_ERROR";

export class RelayError extends Error {
  code: RelayErrorCode;

  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "RelayError";
  }
}

// ============ Config Types ============

export interface ArmadaRelayerConfig {
  /** HTTP API port */
  port: number;
  /** Fee markup over gas cost in basis points (1000 = 10%) */
  profitMarginBps: number;
  /** Hardcoded ETH/USDC price for local dev */
  ethUsdcPrice: number;
  /** How long a fee quote is valid in seconds */
  feeTtlSeconds: number;
  /** Tolerance for gas price changes in basis points (2000 = 20%) */
  feeVarianceBufferBps: number;

  /** Contract addresses loaded from deployments */
  contracts: {
    privacyPool: string;
    armadaYieldAdapter: string;
    usdc: string;
    messageTransmitter: string;
    tokenMessenger: string;
  };
}

// ============ Deployment Types ============

export interface PrivacyPoolDeployment {
  chainId: number;
  domain: number;
  deployer: string;
  contracts: {
    privacyPool: string;
    merkleModule: string;
    verifierModule: string;
    shieldModule: string;
    transactModule: string;
  };
  cctp: {
    tokenMessenger: string;
    messageTransmitter: string;
    usdc: string;
  };
  timestamp: string;
}

export interface CCTPDeployment {
  chainId: number;
  domain: number;
  deployer: string;
  contracts: {
    usdc: string;
    messageTransmitter: string;
    tokenMessenger: string;
  };
  timestamp: string;
}
