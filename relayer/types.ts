/**
 * Shared types for the Armada Relayer
 */

// ============ Fee Types ============

export interface FeeSchedule {
  cacheId: string;
  expiresAt: number; // Unix timestamp ms
  chainId: number;
  /**
   * The relayer's Railgun (`0zk...`) address. Clients direct the broadcaster-fee output of their
   * SNARK proof to this address so the relayer can sweep its gas reimbursement on the same tx.
   * Sourced verbatim from `BROADCASTER_RAILGUN_ADDRESS` in the relayer env — empty string until
   * configured (Phase A1 ships the publishing path; the relayer does not yet enroll or spend on
   * this wallet, that comes with A2's server-side fee verification).
   */
  broadcasterRailgunAddress: string;
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
  // The proof's broadcaster-fee output is missing, points at a different recipient/token, or
  // pays less than the advertised fee. Distinct from FEE_TOO_LOW (which historically meant
  // "the request body's declared fee is too low" — not used today since the fee comes from the
  // cached schedule); FEE_INSUFFICIENT means "the SNARK itself doesn't pay us enough."
  | "FEE_INSUFFICIENT"
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

// ============ Health Types ============

/**
 * Operational status of a single chain's scanner. Mirrors the indexer's status semantics
 * (`crowdfund-ui/packages/shared/src/lib/indexer.ts::IndexerHealthStatus`) so frontends can
 * adopt the same status-pill UX once a relayer dashboard exists.
 *
 *  - `healthy`   — scanner ticked recently AND no error from the most recent tick.
 *  - `degraded`  — recent tick failed (lastError set) OR lagBlocks above the configured ceiling.
 *                  Scanner still alive; investigate but no immediate action required.
 *  - `stale`     — no successful scan tick for >3× pollInterval. Scanner likely wedged.
 *  - `unhealthy` — never scanned successfully (init failure) OR no tick for >10× pollInterval.
 *                  Operator action required.
 */
export type ChainHealthStatus = "healthy" | "degraded" | "stale" | "unhealthy";

/** Per-chain health snapshot. Surfaced by `GET /health` so operators have a positive signal that the scanner is alive. */
export interface ChainHealth {
  /** Chain name (matches the deployments and CCTP_NETWORKS config). */
  chainName: string;
  /** CCTP domain ID of this chain. */
  domain: number;
  status: ChainHealthStatus;
  /** Highest block fully scanned (inclusive). Loaded from cursor on cold start. */
  lastProcessedBlock: number;
  /** Chain head observed during the most recent tick. May be stale — see `lastScanAt`. 0 if never scanned. */
  chainHead: number;
  /** `chainHead - lastProcessedBlock`. Negative would mean the cursor is ahead of head — shouldn't happen, surfaced if it does. */
  lagBlocks: number;
  /** Unix ms of the last successful scan tick. 0 if never scanned. */
  lastScanAt: number;
  /** Last scan error, or null when the most recent tick succeeded. */
  lastError: { message: string; at: number } | null;
  /** Number of in-flight messages awaiting Iris attestation OR destination confirmation (iris-relay only; cctp-relay reports 0). */
  pendingCount: number;
}

export interface RelayerHealth {
  /** Worst-status across all chains — overall green/yellow/red signal for monitoring. */
  status: ChainHealthStatus;
  /** Per-chain breakdown. */
  chains: ChainHealth[];
  /** Unix ms when this health snapshot was generated (server side, not cached). */
  generatedAt: number;
  /**
   * In-process counters since the relayer last started — fee-verifier rejects + submit
   * success/fail by kind. See `relayer/modules/counters.ts` for the key scheme. Operators read
   * these to triage misbehaving clients ("are we rejecting a lot of FEE_INSUFFICIENT?") and
   * relayer outages ("is submitFail.*.SUBMISSION_FAILED climbing?"). Resets on restart.
   *
   * Optional in the type because counters are an http-api overlay — the cctp/iris relay
   * modules' own `getHealth()` impls don't carry this field, http-api injects it at response
   * time so we don't have to thread the Counters instance through every module that cares
   * about chain health.
   */
  counters?: Record<string, number>;
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
