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
export function userFeeForKind(kind: TxKind, amount: bigint, quote?: FeeSchedule | null): bigint {
  switch (kind) {
    case 'shield-xchain':
    case 'unshield-xchain':
      return (amount * CCTP_FAST_FEE_BPS) / 10_000n
    case 'unshield-local':
      return quote ? BigInt(quote.fees.unshield) : 0n
    case 'shield':
    case 'transfer-shielded':
    case 'yield-deposit':
    case 'yield-withdraw':
      return 0n
  }
}

/**
 * 2× multiple over `userFeeForKind` to use as CCTP V2's `maxFee` bound. The displayed fee is a
 * realistic estimate (matches the server's conservative bps buffer); the on-chain bound bumps it
 * to give Iris's `feeExecuted` headroom against per-chain variance and any future fee changes.
 * The contract enforces `feeExecuted ≤ maxFee`, so undersized bounds silently revert.
 */
export function cctpMaxFeeForKind(kind: TxKind, amount: bigint): bigint {
  return userFeeForKind(kind, amount) * 2n
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
 */
export async function fetchFees(signal?: AbortSignal): Promise<FeeSchedule> {
  const res = await fetch(relayerEndpoint(RELAYER_ENDPOINTS.fees), {
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
