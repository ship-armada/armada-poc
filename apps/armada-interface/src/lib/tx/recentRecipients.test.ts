// ABOUTME: Tests for deriveRecentRecipients — dedupe by normalized address, newest-first, cap, completed-only, per-kind chain.

import { describe, it, expect } from 'vitest'
import { deriveRecentRecipients } from './recentRecipients'
import type { TxRecord, TxKind, TxExecutionState } from './types'

const HUB = 31337
const CLIENT = 84532

const EVM_A = '0x1111111111111111111111111111111111111111'
const EVM_B = '0x2222222222222222222222222222222222222222'
const ZK_A = '0zk' + 'a'.repeat(40)

function rec(o: {
  kind: TxKind
  createdAt: number
  executionState?: TxExecutionState
  recipient?: string
  toChainId?: number
}): TxRecord {
  return {
    id: `id-${o.createdAt}`,
    kind: o.kind,
    executionState: o.executionState ?? 'completed',
    stage: 'hub-confirmed',
    stagesCompleted: [],
    updatedSeq: 1,
    createdAt: o.createdAt,
    updatedAt: o.createdAt,
    meta: { recipient: o.recipient, toChainId: o.toChainId },
    artifacts: {},
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'w', sourceChainId: HUB },
  } as unknown as TxRecord
}

describe('deriveRecentRecipients', () => {
  it('returns [] for empty history', () => {
    expect(deriveRecentRecipients([], { hubChainId: HUB })).toEqual([])
  })

  it('dedupes by normalized address (case-insensitive for 0x), keeping the newest occurrence', () => {
    // Same address, differing only in body case (real checksummed addresses keep a lowercase 0x prefix).
    const lower = '0x' + 'ab'.repeat(20)
    const upperBody = '0x' + 'AB'.repeat(20)
    const records = [
      rec({ kind: 'unshield-local', createdAt: 100, recipient: lower }),
      rec({ kind: 'unshield-local', createdAt: 300, recipient: upperBody }),
    ]
    const out = deriveRecentRecipients(records, { hubChainId: HUB })
    expect(out).toHaveLength(1)
    expect(out[0]?.lastAt).toBe(300)
    expect(out[0]?.destChainId).toBe(HUB)
  })

  it('orders newest-first and caps at the limit', () => {
    const records = Array.from({ length: 8 }, (_, i) =>
      rec({ kind: 'unshield-local', createdAt: i * 100, recipient: `0x${String(i).repeat(40)}` }),
    )
    const out = deriveRecentRecipients(records, { hubChainId: HUB, limit: 5 })
    expect(out).toHaveLength(5)
    expect(out.map((r) => r.lastAt)).toEqual([700, 600, 500, 400, 300])
  })

  it('counts only settled (completed) sends', () => {
    const records = [
      rec({ kind: 'unshield-local', createdAt: 100, recipient: EVM_A, executionState: 'failed' }),
      rec({ kind: 'unshield-local', createdAt: 200, recipient: EVM_B, executionState: 'active' }),
    ]
    expect(deriveRecentRecipients(records, { hubChainId: HUB })).toEqual([])
  })

  it('restores the destination chain per kind (xchain→toChainId, local→hub, transfer→undefined)', () => {
    const records = [
      rec({ kind: 'unshield-xchain', createdAt: 300, recipient: EVM_A, toChainId: CLIENT }),
      rec({ kind: 'unshield-local', createdAt: 200, recipient: EVM_B }),
      rec({ kind: 'transfer-shielded', createdAt: 100, recipient: ZK_A }),
    ]
    const out = deriveRecentRecipients(records, { hubChainId: HUB })
    expect(out.map((r) => [r.kind, r.destChainId])).toEqual([
      ['unshield-xchain', CLIENT],
      ['unshield-local', HUB],
      ['transfer-shielded', undefined],
    ])
  })

  it('skips records with no recipient (e.g. shields, received transfers)', () => {
    const records = [
      rec({ kind: 'shield', createdAt: 300 }),
      rec({ kind: 'transfer-shielded', createdAt: 200 }), // received transfer — no recipient meta
      rec({ kind: 'unshield-local', createdAt: 100, recipient: EVM_A }),
    ]
    const out = deriveRecentRecipients(records, { hubChainId: HUB })
    expect(out).toHaveLength(1)
    expect(out[0]?.address).toBe(EVM_A)
  })
})
