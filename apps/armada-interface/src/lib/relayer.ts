// ABOUTME: HTTP client for the Armada relayer — typed fees / relay / status requests with structured error handling.
// ABOUTME: All three endpoints wired; handler-side adoption of submitRelay is staged in per-kind under Phase A.

import { RELAYER_ENDPOINTS, RELAYER_STATUS_CODES, relayerEndpoint, type RelayerErrorCode } from '@/config/relayer'
import type { TxKind } from '@/lib/tx/types'

export interface FeeSchedule {
  cacheId: string
  expiresAt: number
  chainId: number
  /**
   * Relayer's Railgun (`0zk...`) address. Clients direct the broadcaster-fee output of their
   * SNARK proof here so the relayer is paid in the same atomic tx. Sourced verbatim from the
   * relayer's `BROADCASTER_RAILGUN_ADDRESS` env var. Empty string is allowed in Phase A1 (no
   * handler consumes this yet); the build-proof stage will start asserting non-empty once
   * relayer-mediated submit ships in A3.
   */
  broadcasterRailgunAddress: string
  /** USDC raw values (6 decimals) as strings — JSON can't carry bigints. Callers BigInt() on use. */
  fees: {
    transfer: string
    unshield: string
    crossContract: string
    crossChainShield: string
    crossChainUnshield: string
    /**
     * Phase B2 — permit-based gasless `shield` on the hub. Semantically meaningful only on the
     * hub schedule (clients return a still-computed value for type uniformity, but no handler
     * consumes it there).
     */
    shield: string
    /**
     * Phase B2 — permit-based gasless `shield-xchain` originating on a CLIENT chain. Each
     * client quotes its own gas cost (Base Sepolia is materially cheaper than Ethereum
     * Sepolia, etc.), so callers must fetch the FeeSchedule for the source client chain via
     * `fetchFees(chainId)` rather than reading the hub schedule.
     */
    shieldXchain: string
  }
}

/**
 * Conservative buffer (basis points) for CCTP V2's fast-transfer fee. Mirrors the buffer used
 * server-side in `relayer/modules/fee-calculator.ts::CCTP_FAST_FEE_BPS`. Circle charges 1 bps on
 * Ethereum/Solana and 1.3 bps on the L2s (Arbitrum, Base, Optimism); 2 bps quoted to the user
 * is the next round step up that holds across all supported chains. Keep in sync with the
 * server-side constant — if the real numbers change, both move together.
 */
const CCTP_FAST_FEE_BPS = 2n

/**
 * Compute the USDC fee the user will actually pay for `kind` at `amount`. Two contributing
 * sources today:
 *
 *  - CCTP V2 fast-transfer fee (~2 bps) on cross-chain kinds, deducted from the destination mint.
 *  - Relayer broadcaster fee on relayer-mediated kinds (Phase A3+), advertised verbatim in the
 *    FeeSchedule's per-op entries. Encoded into the SNARK proof as a broadcaster output to the
 *    relayer's `0zk` address; the relayer's pre-submit verifier rejects the request if the
 *    proof's broadcaster output is below the advertised amount (`FEE_INSUFFICIENT`).
 *
 * Migration table — flips a kind's USDC fee on as its handler migrates to `submitRelay`:
 *   - A3: unshield-local → reads `quote.fees.unshield`
 *   - A4: transfer-shielded / yield-deposit / yield-withdraw (still `0n` here until A4 ships)
 *   - A5: unshield-xchain hub burn — separate; today's CCTP fee path is unchanged
 *
 * `quote` is optional: pre-quote-load the modal renders `0n`, which is also the right answer
 * for kinds that don't consume the quote. Modals pass the live `useFees()` quote when they have
 * one.
 */
/**
 * Per-kind options that flip a fee-shape under the kind's umbrella. Today only `shield` uses
 * `gasless` — it's free under Phase A's user-wallet direct submit but carries a `shield` tier
 * fee under Phase B's permit + wrapper path. The flag lives in the modal (which knows whether
 * a wrapper is deployed for the chosen chain AND the user hasn't toggled wallet-override) and
 * is passed in here for every recompute.
 */
export interface UserFeeOpts {
  /** Phase B `shield` gasless path: include the relayer's `shield` tier fee. Default false. */
  gasless?: boolean
}

export function userFeeForKind(
  kind: TxKind,
  amount: bigint,
  quote?: FeeSchedule | null,
  opts?: UserFeeOpts,
): bigint {
  switch (kind) {
    case 'shield-xchain':
      return (amount * CCTP_FAST_FEE_BPS) / 10_000n
    case 'unshield-xchain':
      // A5 — relayer-mediated hub burn. The visible "fee" is the relayer's broadcaster fee from
      // the `crossChainUnshield` tier (covers proof verification + the CCTP burn). The CCTP
      // fast-fee (~2 bps proportional to amount) still applies but is paid out of the
      // destination-side mint, not the user's shielded balance — surface it via
      // `cctpFastFeeForAmount` and let the modal show both fees as separate line items.
      return quote ? BigInt(quote.fees.crossChainUnshield) : 0n
    case 'unshield-local':
      return quote ? BigInt(quote.fees.unshield) : 0n
    case 'transfer-shielded':
      // A4 — relayer-mediated. The relayer's transfer-tier fee covers a single transact() call
      // (no cross-contract leg), so it's the cheapest tier in the schedule.
      return quote ? BigInt(quote.fees.transfer) : 0n
    case 'yield-deposit':
    case 'yield-withdraw':
      // A4 — relayer-mediated via ArmadaYieldAdapter's lendAndShield/redeemAndShield wrappers,
      // which carry a Transaction struct that does the cross-contract spend + re-shield. The
      // `crossContract` tier reflects the higher gas profile of that pattern (~2M gas vs ~500k).
      return quote ? BigInt(quote.fees.crossContract) : 0n
    case 'shield':
      // Phase B3 — when the modal decided to route through the GaslessShieldWrapper (wrapper
      // deployed for the chain, relayer healthy, user hasn't overridden to wallet-submit), the
      // relayer charges the `shield` tier in USDC. When direct-submit instead, the user pays
      // ETH gas themselves and the wrapper doesn't enter the picture — fee is 0.
      if (opts?.gasless) return quote ? BigInt(quote.fees.shield) : 0n
      return 0n
  }
}

/**
 * Per-kind fee semantics — which side of the recipient line the fee sits on. Decoupled from
 * `userFeeForKind` (which computes the fee amount) so a single-site refactor when a kind's fee
 * model flips (e.g., A4 moves yield kinds to relayer-mediated → `fee-on-top`) doesn't ripple
 * through every modal.
 *
 *  - `no-fee`            — recipient receives the entered amount; nothing extra is deducted.
 *  - `fee-from-recipient` — fee is taken out of the destination mint (CCTP V2's path). The user
 *                            spends the entered amount; the recipient receives `amount - fee`.
 *  - `fee-on-top`        — fee is an extra output in the SNARK proof (relayer-mediated path).
 *                            Recipient receives the full entered amount; user is deducted
 *                            `amount + fee`. Input MAX must reserve room for the fee.
 *  - `fee-on-top-and-from-recipient` — both apply (A5 cross-chain unshield). Primary `fee` is the
 *                            broadcaster fee (on top); the optional `secondaryFee` is the CCTP
 *                            fast-fee (from recipient). User pays `amount + fee`; recipient
 *                            receives `amount - secondaryFee`.
 */
export type FeeModel = 'no-fee' | 'fee-from-recipient' | 'fee-on-top' | 'fee-on-top-and-from-recipient'

export function feeModelForKind(kind: TxKind, opts?: UserFeeOpts): FeeModel {
  switch (kind) {
    case 'shield-xchain':
      return 'fee-from-recipient'
    case 'unshield-xchain':
      // A5 — relayer-mediated AND cross-chain. Two fees apply:
      //   - broadcaster fee (`crossChainUnshield` tier) is on top of `amount`, debited from
      //     the user's shielded balance via an extra unshield output in the proof.
      //   - CCTP fast-fee (~2 bps) is from-recipient — deducted from the destination mint.
      // Modeled together so `computeFeeBreakdown` stays the single source of truth.
      return 'fee-on-top-and-from-recipient'
    case 'unshield-local':
    case 'transfer-shielded':
    case 'yield-deposit':
    case 'yield-withdraw':
      // A4 — all relayer-mediated. Recipient receives the entered amount; the broadcaster fee
      // is an extra output in the proof, deducted on top of the entered amount.
      return 'fee-on-top'
    case 'shield':
      // Phase B3 — gasless path: the wrapper pulls `amount + fee` from the user's USDC, shields
      // `amount`, transfers `fee` to the relayer. Same on-top semantics as the unshield flows.
      // Direct submit path stays `no-fee` (user pays ETH gas themselves; no USDC line item).
      if (opts?.gasless) return 'fee-on-top'
      return 'no-fee'
  }
}

/**
 * The three numbers every kind-aware modal needs from `(kind, amount, fee, max)`:
 *
 *  - `recipientReceives` — what the on-chain recipient gets. For history, success copy, etc.
 *  - `totalDeducted`     — what's debited from the user's shielded balance. Shown as the
 *                          "Total deducted" line on the fee-on-top path; equals
 *                          `recipientReceives` on the other two.
 *  - `inputMax`          — the cap the AmountInput should accept so `totalDeducted ≤ max` always
 *                          holds. Differs from `max` only on `fee-on-top` (must reserve fee).
 *
 * Single source of truth. UnshieldModal + SendModal call this; the per-step components just
 * receive the three numbers as props.
 */
export interface FeeBreakdown {
  recipientReceives: bigint
  totalDeducted: bigint
  inputMax: bigint
}

export function computeFeeBreakdown(
  kind: TxKind,
  amount: bigint,
  fee: bigint,
  max: bigint,
  opts?: { secondaryFee?: bigint },
): FeeBreakdown {
  switch (feeModelForKind(kind)) {
    case 'no-fee':
      return { recipientReceives: amount, totalDeducted: amount, inputMax: max }
    case 'fee-from-recipient':
      return {
        recipientReceives: amount > fee ? amount - fee : 0n,
        totalDeducted: amount,
        inputMax: max,
      }
    case 'fee-on-top':
      return {
        recipientReceives: amount,
        totalDeducted: amount + fee,
        inputMax: max > fee ? max - fee : 0n,
      }
    case 'fee-on-top-and-from-recipient': {
      const secondary = opts?.secondaryFee ?? 0n
      return {
        recipientReceives: amount > secondary ? amount - secondary : 0n,
        totalDeducted: amount + fee,
        inputMax: max > fee ? max - fee : 0n,
      }
    }
  }
}

/**
 * CCTP V2 fast-transfer fee for an unshield-xchain amount. ~2 bps, deducted from the destination
 * mint. Separate from `userFeeForKind` post-A5 since the relayer's broadcaster fee now occupies
 * the "user-visible relayer fee" slot, and the CCTP fee is its own line item in the modal
 * (different semantics — paid by the recipient, not the user). Use as `secondaryFee` when
 * calling `computeFeeBreakdown` for `unshield-xchain` / `shield-xchain`.
 */
export function cctpFastFeeForAmount(amount: bigint): bigint {
  return (amount * CCTP_FAST_FEE_BPS) / 10_000n
}

/**
 * 2× multiple over the CCTP fast-fee to use as CCTP V2's on-chain `maxFee` bound. The displayed
 * fee is a realistic estimate (matches the server's conservative bps buffer); the on-chain
 * bound bumps it to give Iris's `feeExecuted` headroom against per-chain variance and any future
 * fee changes. The contract enforces `feeExecuted ≤ maxFee`, so undersized bounds silently revert.
 */
export function cctpMaxFeeForKind(kind: TxKind, amount: bigint): bigint {
  switch (kind) {
    case 'shield-xchain':
    case 'unshield-xchain':
      return cctpFastFeeForAmount(amount) * 2n
    default:
      return 0n
  }
}

export interface RelayRequest {
  chainId: number
  to: string
  data: string
  feesCacheId: string
}

export interface RelayResponse {
  txHash: string
  status: 'pending'
}

export interface StatusResponse {
  status: 'pending' | 'confirmed' | 'failed'
  blockNumber?: number
  error?: string
}

export class RelayerError extends Error {
  readonly code: RelayerErrorCode
  readonly httpStatus: number
  constructor(code: RelayerErrorCode, httpStatus: number, message: string) {
    super(message)
    this.name = 'RelayerError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

function statusToErrorCode(httpStatus: number): RelayerErrorCode {
  for (const [code, expected] of Object.entries(RELAYER_STATUS_CODES) as [RelayerErrorCode, number][]) {
    if (expected === httpStatus) return code
  }
  return 'UNKNOWN_ERROR'
}

async function parseError(res: Response): Promise<RelayerError> {
  let message = `Relayer request failed (${res.status})`
  let code: RelayerErrorCode = statusToErrorCode(res.status)
  try {
    const body = (await res.json()) as { error?: string; code?: RelayerErrorCode }
    if (body.error) message = body.error
    if (body.code) code = body.code
  } catch {
    /* body wasn't JSON — keep defaults */
  }
  return new RelayerError(code, res.status, message)
}

/**
 * Fetch the current fee schedule from the relayer. The relayer caches its own schedule with a
 * 5-min TTL and returns the cached value when valid; the client caches at the atom layer via
 * `useFees`. Both can re-fetch independently — relayer is the source of truth.
 *
 * Phase B2 made fees per-chain — the source-chain gas price drives the gasless `shield-xchain`
 * quote (Base Sepolia ≠ Ethereum Sepolia). Pass `chainId` to fetch the schedule for a specific
 * chain; omit to default to the hub (backward-compatible for Phase A callers).
 */
export async function fetchFees(
  signal?: AbortSignal,
  chainId?: number,
): Promise<FeeSchedule> {
  const url =
    chainId === undefined
      ? relayerEndpoint(RELAYER_ENDPOINTS.fees)
      : `${relayerEndpoint(RELAYER_ENDPOINTS.fees)}?chainId=${chainId}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as FeeSchedule
}

/**
 * POST a populated transaction (relayer's `Transaction` struct, ABI-encoded into `data`) to the
 * relayer for execution. The relayer pays gas on-chain and returns the tx hash so the caller can
 * poll `/status` for confirmation. The fee quote attached as `feesCacheId` MUST be current — the
 * relayer rejects stale quotes with `FEE_EXPIRED`.
 *
 * Status semantics: success here means the relayer accepted the request and broadcast the tx —
 * NOT that the tx is on-chain. Use `pollStatus(txHash)` / `pollRelayStatusOnce` to track inclusion.
 *
 * Dormant in A1: no handler calls this yet. Handlers migrate in A3 (`unshield-local` first), then
 * A4 (transfer + yield), then A5 (`unshield-xchain` hub burn). See `.claude/RELAYER_MEDIATION_PLAN.md`.
 */
export async function submitRelay(req: RelayRequest, signal?: AbortSignal): Promise<RelayResponse> {
  const res = await fetch(relayerEndpoint(RELAYER_ENDPOINTS.relay), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as RelayResponse
}

/**
 * Relayer-side health status, mirrored on the frontend. The relayer reports the worst-status
 * across all its chains plus optional in-process counters since the last restart.
 */
export type RelayerHealthStatus = 'healthy' | 'degraded' | 'stale' | 'unhealthy'

export interface RelayerHealthResponse {
  status: RelayerHealthStatus
  /** Per-chain health rows. Shape mirrors `relayer/types.ts::ChainHealth`. */
  chains: Array<{
    chainName: string
    domain: number
    status: RelayerHealthStatus
    lastProcessedBlock: number
    chainHead: number
    lagBlocks: number
    lastScanAt: number
    lastError: { message: string; at: number } | null
    pendingCount: number
  }>
  generatedAt: number
  /** In-process counters (A6). May be empty / undefined when no events have occurred. */
  counters?: Record<string, number>
}

/**
 * Fetch the relayer's /health snapshot. The relayer returns 200 for healthy/degraded and 503
 * for stale/unhealthy; we treat the body the same in both cases — caller decides how to render
 * the status. AbortSignal forwards to fetch so a hook can cancel on unmount.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<RelayerHealthResponse> {
  const res = await fetch(relayerEndpoint(RELAYER_ENDPOINTS.health), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  // 503 still carries a JSON body — both status codes parse the same shape.
  if (!res.ok && res.status !== 503) throw await parseError(res)
  return (await res.json()) as RelayerHealthResponse
}

/** Poll a previously-submitted relay tx's status. */
export async function pollStatus(txHash: string, signal?: AbortSignal): Promise<StatusResponse> {
  const res = await fetch(`${relayerEndpoint(RELAYER_ENDPOINTS.status)}/${txHash}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as StatusResponse
}
