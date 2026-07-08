// ABOUTME: Lifecycle definitions per TxKind — stage sequence, terminal-success stage, retryable stages, ETA hints.
// ABOUTME: Single source of truth for tx flow modeling. Adding a kind means adding here, its stage union in types.ts, and (optionally) a renderer.

import type { TxKind, TxLifecycle } from './types'

/* Standard duration caps. */
const SHORT_CAP = 10 * 60_000   // 10 min — same-chain operations
const YIELD_CAP = 15 * 60_000   // 15 min — yield ops can wait for the next block batch
const XCHAIN_CAP = 60 * 60_000  // 60 min — Iris standard finality can take ~20 min on its own

const shield: TxLifecycle<'shield'> = {
  kind: 'shield',
  stages: ['build-proof', 'submit-relayer', 'hub-confirmed'],
  terminalSuccess: 'hub-confirmed',
  retryableStages: ['submit-relayer'],
  estDuration: { p50: 8_000, p90: 25_000 },
  maxDurationMs: SHORT_CAP,
}

const unshieldLocal: TxLifecycle<'unshield-local'> = {
  kind: 'unshield-local',
  stages: ['build-proof', 'submit-relayer', 'hub-confirmed'],
  terminalSuccess: 'hub-confirmed',
  retryableStages: ['submit-relayer'],
  estDuration: { p50: 8_000, p90: 25_000 },
  maxDurationMs: SHORT_CAP,
}

const unshieldXchain: TxLifecycle<'unshield-xchain'> = {
  kind: 'unshield-xchain',
  stages: [
    'build-proof',
    'submit-relayer',
    'hub-burn-confirmed',
    'iris-attestation-pending',
    'iris-attestation-ready',
    'client-mint-pending',
    'client-mint-confirmed',
  ],
  terminalSuccess: 'client-mint-confirmed',
  retryableStages: ['submit-relayer', 'iris-attestation-pending'],
  estDuration: { p50: 30_000, p90: 120_000 },
  maxDurationMs: XCHAIN_CAP,
}

const shieldXchain: TxLifecycle<'shield-xchain'> = {
  kind: 'shield-xchain',
  // Same shape as unshield-xchain but flipped direction: burn on client → mint on hub.
  stages: [
    'build-proof',
    'submit-relayer',
    'client-burn-confirmed',
    'iris-attestation-pending',
    'iris-attestation-ready',
    'hub-mint-pending',
    'hub-mint-confirmed',
  ],
  terminalSuccess: 'hub-mint-confirmed',
  retryableStages: ['submit-relayer', 'iris-attestation-pending'],
  estDuration: { p50: 30_000, p90: 120_000 },
  maxDurationMs: XCHAIN_CAP,
}

const transferShielded: TxLifecycle<'transfer-shielded'> = {
  kind: 'transfer-shielded',
  stages: ['build-proof', 'submit-relayer', 'hub-confirmed'],
  terminalSuccess: 'hub-confirmed',
  retryableStages: ['submit-relayer'],
  estDuration: { p50: 8_000, p90: 25_000 },
  maxDurationMs: SHORT_CAP,
}

/**
 * Synthetic received-transfer lifecycle. Single terminal stage — we reconstruct the record from
 * chain only once the commitment is already on the merkle tree, so there's nothing to drive or
 * resume. `maxDurationMs: 0` + empty `retryableStages` means the executor's resume probe never
 * touches it (records are born `completed`).
 */
const transferShieldedReceived: TxLifecycle<'transfer-shielded-received'> = {
  kind: 'transfer-shielded-received',
  stages: ['observed'],
  terminalSuccess: 'observed',
  retryableStages: [],
  estDuration: { p50: 0, p90: 0 },
  maxDurationMs: 0,
}

const yieldDeposit: TxLifecycle<'yield-deposit'> = {
  kind: 'yield-deposit',
  stages: ['build-proof', 'submit-relayer', 'hub-confirmed'],
  terminalSuccess: 'hub-confirmed',
  retryableStages: ['submit-relayer'],
  estDuration: { p50: 10_000, p90: 30_000 },
  maxDurationMs: YIELD_CAP,
}

const yieldWithdraw: TxLifecycle<'yield-withdraw'> = {
  kind: 'yield-withdraw',
  stages: ['build-proof', 'submit-relayer', 'hub-confirmed'],
  terminalSuccess: 'hub-confirmed',
  retryableStages: ['submit-relayer'],
  estDuration: { p50: 10_000, p90: 30_000 },
  maxDurationMs: YIELD_CAP,
}

/** Lookup table keyed by TxKind. Use `lifecycleFor(kind)` rather than indexing directly. */
const LIFECYCLES = {
  shield,
  'shield-xchain': shieldXchain,
  'unshield-local': unshieldLocal,
  'unshield-xchain': unshieldXchain,
  'transfer-shielded': transferShielded,
  'transfer-shielded-received': transferShieldedReceived,
  'yield-deposit': yieldDeposit,
  'yield-withdraw': yieldWithdraw,
} as const

export function lifecycleFor<K extends TxKind>(kind: K): TxLifecycle<K> {
  return LIFECYCLES[kind] as TxLifecycle<K>
}
