// ABOUTME: Human-readable copy for every (TxKind, stage) combination, optionally varying by executionState.
// ABOUTME: Single source of truth for tx-related microcopy — TxLifecycleStepper, TxRow, ProgressStep, and stage-status messages all read from here.

import type { TxKind, TxRecord, TxExecutionState } from '@/lib/tx/types'
import { getChainById } from '@/config/network'
import { truncateAddress } from '@/lib/format'

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
    'hub-confirmed': 'Shielded',
  },
  'shield-xchain': {
    'build-proof': 'Preparing transaction',
    'submit-relayer': { waiting: 'Confirm in your wallet', active: 'Submitting on source chain' },
    'client-burn-confirmed': 'Confirmed on source chain',
    'iris-attestation-pending': 'Waiting for cross-chain confirmation',
    'iris-attestation-ready': 'Cross-chain confirmation ready',
    'hub-mint-pending': 'Delivering to private balance',
    'hub-mint-confirmed': 'Shielded',
  },
  'unshield-local': {
    'build-proof': 'Preparing transaction',
    'submit-relayer': 'Submitting privately',
    'hub-confirmed': 'Unshielded',
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
  shield: 'Shield',
  // Cross-chain shield surfaces under the same modal/CTA as same-chain shield; the kind
  // distinction is purely for the lifecycle. From the user's perspective both are shields.
  'shield-xchain': 'Shield',
  // Unshield and Send-External both produce `unshield-*` records — there's no separate kind
  // for "Payment" because the contract paths are identical. The UI distinguishes the user's
  // intent (self vs other) via the modal they started from + the recipient field default.
  'unshield-local': 'Unshield',
  'unshield-xchain': 'Unshield',
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
 * Rich row title for an in-flight or historical record — matches the dashboard mockup's activity
 * copy: deposits name their source chain, public sends name the 0x recipient, private sends read
 * "Sent to private address", vault ops read "Added to / Withdrawn from earn vault". Reads per-kind
 * meta fields; TS can't narrow the union from `record.kind` (TxRecord is parametrised), so the
 * runtime casts are safe — meta is shaped per-kind. Falls back to the bare kind title if a field
 * is missing (defensive — persisted records may carry older schemas).
 */
export function recordTitle(record: TxRecord): string {
  switch (record.kind) {
    case 'shield':
    case 'shield-xchain': {
      // Shields carry the source chain they deposited/bridged from.
      const meta = record.meta as { fromChainId?: number }
      const chain = meta.fromChainId !== undefined ? getChainById(meta.fromChainId) : undefined
      return chain ? `Shield from ${chain.name}` : 'Shield'
    }
    case 'unshield-local':
    case 'unshield-xchain': {
      // Public unshields — external send + withdraw-to-own-wallet share this kind — carry the 0x recipient.
      const meta = record.meta as { recipient?: string }
      return meta.recipient ? `Sent to ${truncateAddress(meta.recipient)}` : 'Sent'
    }
    case 'transfer-shielded':
      // Private (0zk → 0zk) send. The recipient stays private, so we don't surface the address.
      return 'Sent to private address'
    case 'transfer-shielded-received':
      // Incoming private transfer — sender is private by design, so no address.
      return 'Received payment'
    case 'yield-deposit':
      return 'Added to earn vault'
    case 'yield-withdraw':
      return 'Withdrawn from earn vault'
  }
  // Defensive fallback for any future kind not covered above.
  return kindTitle(record.kind)
}
