// ABOUTME: Human-readable copy for every (TxKind, stage) combination, optionally varying by executionState.
// ABOUTME: Single source of truth for tx-related microcopy — TxLifecycleStepper, TxRow, ProgressStep, and stage-status messages all read from here.

import type { TxKind, TxRecord, TxExecutionState } from '@/lib/tx/types'
import { getChainById } from '@/config/network'

/** Copy entry — either a static string or active/waiting variants keyed on executionState. */
type CopyEntry = string | { active: string; waiting: string }

/**
 * Per-kind stage copy map. Keys are stage strings; we deliberately use a loose `string` key
 * rather than `StageFor<K>` so the map is one cohesive table without per-kind generic plumbing.
 * The exported `stageCopy()` enforces `StageFor<K>` at the call site.
 */
const COPY: Record<TxKind, Partial<Record<string, CopyEntry>>> = {
  shield: {
    'build-proof': 'Preparing transaction',
    'submit-relayer': { waiting: 'Confirm in your wallet', active: 'Submitting transaction' },
    'hub-confirmed': 'Deposited',
  },
  'shield-xchain': {
    'build-proof': 'Preparing transaction',
    'submit-relayer': { waiting: 'Confirm in your wallet', active: 'Submitting on source chain' },
    'client-burn-confirmed': 'Confirmed on source chain',
    'iris-attestation-pending': 'Waiting for cross-chain confirmation',
    'iris-attestation-ready': 'Cross-chain confirmation ready',
    'hub-mint-pending': 'Delivering to private balance',
    'hub-mint-confirmed': 'Deposited',
  },
  'unshield-local': {
    'build-proof': 'Preparing transaction',
    'submit-relayer': 'Submitting privately',
    'hub-confirmed': 'Withdrawn',
  },
  'unshield-xchain': {
    'build-proof': 'Preparing transaction',
    'submit-relayer': 'Submitting privately',
    'hub-burn-confirmed': 'Confirmed on hub',
    'iris-attestation-pending': 'Waiting for cross-chain confirmation',
    'iris-attestation-ready': 'Cross-chain confirmation ready',
    'client-mint-pending': 'Delivering on destination chain',
    'client-mint-confirmed': 'Funds delivered',
  },
  'transfer-shielded': {
    'build-proof': 'Preparing transaction',
    'submit-relayer': 'Submitting privately',
    'hub-confirmed': 'Sent',
  },
  'transfer-shielded-received': {
    observed: 'Received',
  },
  'yield-deposit': {
    'build-proof': 'Preparing transaction',
    'submit-relayer': 'Submitting privately',
    'hub-confirmed': 'Earning',
  },
  'yield-withdraw': {
    'build-proof': 'Preparing transaction',
    'submit-relayer': 'Submitting privately',
    'hub-confirmed': 'Returned to balance',
  },
}

/**
 * Resolve human-readable copy for a stage. When the entry has active/waiting variants,
 * the `executionState` parameter picks which one to render (used by the shield wallet-prompt sub-state).
 */
export function stageCopy(
  kind: TxKind,
  stage: string,
  executionState?: TxExecutionState,
): string {
  const entry = COPY[kind]?.[stage]
  if (entry === undefined) return stage
  if (typeof entry === 'string') return entry
  return executionState === 'waiting' ? entry.waiting : entry.active
}

/** Short title used in lists (Recent Activity, In Progress) and in modal headers. */
const KIND_TITLES: Record<TxKind, string> = {
  shield: 'Deposit',
  // Cross-chain shield surfaces under the same modal/CTA as same-chain shield; the kind
  // distinction is purely for the lifecycle. From the user's perspective both are deposits.
  'shield-xchain': 'Deposit',
  // Withdraw and Send-External both produce `unshield-*` records — there's no separate kind
  // for "Payment" because the contract paths are identical. The UI distinguishes the user's
  // intent (self vs other) via the modal they started from + the recipient field default.
  'unshield-local': 'Withdraw',
  'unshield-xchain': 'Withdraw',
  'transfer-shielded': 'Private transfer',
  // Incoming private transfer reconstructed from chain — someone sent USDC to our 0zk address.
  'transfer-shielded-received': 'Received',
  'yield-deposit': 'Vault deposit',
  'yield-withdraw': 'Vault withdrawal',
}

export function kindTitle(kind: TxKind): string {
  return KIND_TITLES[kind]
}

/**
 * Rich row title for an in-flight or historical record — appends destination chain for cross-chain kinds.
 * Falls back to the bare kind title when meta lacks the expected field (defensive — should not happen with
 * a well-formed record, but tx records are persisted so older schemas may surface).
 */
export function recordTitle(record: TxRecord): string {
  const base = kindTitle(record.kind)
  if (record.kind === 'unshield-xchain') {
    // unshield-xchain meta carries toChainId. TS can't narrow the union from kind here because
    // TxRecord is parametrised; the runtime read is safe — meta is shaped per-kind.
    const meta = record.meta as { toChainId?: number }
    const chain = meta.toChainId !== undefined ? getChainById(meta.toChainId) : undefined
    if (chain) return `${base} to ${chain.name}`
  }
  if (record.kind === 'shield-xchain') {
    const meta = record.meta as { fromChainId?: number }
    const chain = meta.fromChainId !== undefined ? getChainById(meta.fromChainId) : undefined
    if (chain) return `${base} from ${chain.name}`
  }
  return base
}
