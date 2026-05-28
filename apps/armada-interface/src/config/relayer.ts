// ABOUTME: Relayer endpoint constants and typed error codes for the Armada relayer's HTTP API.
// ABOUTME: HTTP client implementation lives in `lib/relayer.ts`; this module is config + types only.

import { getNetworkConfig } from './network'

export const RELAYER_ENDPOINTS = {
  fees: '/fees',
  relay: '/relay',
  status: '/status', // suffix: `/${txHash}`
} as const

/** Error codes returned by the relayer (see `relayer/armada-relayer.ts`). */
export type RelayerErrorCode =
  | 'FEE_TOO_LOW'
  | 'FEE_EXPIRED'
  // The proof's broadcaster-fee output is missing, points at a wrong recipient/token, or pays
  // less than the advertised rate. Surfaces only when the user's local fee-quote drifted from
  // the relayer's after the proof was already built; UX should prompt a re-quote + rebuild.
  | 'FEE_INSUFFICIENT'
  | 'INVALID_TARGET'
  | 'INVALID_CHAIN'
  | 'INVALID_DATA'
  | 'DUPLICATE_TX'
  | 'GAS_ESTIMATION_FAILED'
  | 'SUBMISSION_FAILED'
  | 'RELAYER_BUSY'
  | 'UNKNOWN_ERROR'

/** HTTP status code → error code mapping for known relayer responses. */
export const RELAYER_STATUS_CODES: Readonly<Record<RelayerErrorCode, number>> = {
  FEE_TOO_LOW: 402,
  FEE_EXPIRED: 402,
  FEE_INSUFFICIENT: 402,
  INVALID_TARGET: 400,
  INVALID_CHAIN: 400,
  INVALID_DATA: 400,
  DUPLICATE_TX: 409,
  GAS_ESTIMATION_FAILED: 422,
  SUBMISSION_FAILED: 502,
  RELAYER_BUSY: 503,
  UNKNOWN_ERROR: 500,
}

export function getRelayerUrl(): string {
  return getNetworkConfig().relayerUrl
}

export function relayerEndpoint(path: string): string {
  const base = getRelayerUrl().replace(/\/$/, '')
  return `${base}${path}`
}
