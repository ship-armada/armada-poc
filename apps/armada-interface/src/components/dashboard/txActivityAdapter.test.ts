// ABOUTME: Unit tests for the TxRecord → dashboard activity-item adapter (direction, sign, label, pending, ordering).

import { describe, it, expect } from 'vitest'
import type { TxRecord, TxKind, TxExecutionState, TxErrorCode } from '@/lib/tx/types'
import type { RequestLinkRecord } from '@/lib/shielded/requestLinks'
import {
  buildActivityItems,
  requestLinkToActivityItem,
  txRecordToActivityItem,
  txListToActivityItems,
} from './txActivityAdapter'

function makeLink(opts: Partial<RequestLinkRecord> = {}): RequestLinkRecord {
  return {
    requestId: opts.requestId ?? 'req_abc',
    paymentLink: opts.paymentLink ?? 'https://app/pay-via-link?to=0zk&amount=25',
    amount: opts.amount ?? '25',
    note: opts.note,
    expiresAt: opts.expiresAt ?? 2_000,
    createdAt: opts.createdAt ?? 1_500,
    shieldedWalletId: opts.shieldedWalletId ?? 'w1',
  }
}

function makeRecord(
  kind: TxKind,
  opts: {
    id?: string
    amount?: bigint
    executionState?: TxExecutionState
    createdAt?: number
    updatedAt?: number
    sourceTxHash?: `0x${string}`
    recipient?: string
    errorCode?: TxErrorCode
  } = {},
): TxRecord {
  return {
    id: opts.id ?? 'id-1',
    kind,
    executionState: opts.executionState ?? 'completed',
    createdAt: opts.createdAt ?? 1000,
    updatedAt: opts.updatedAt ?? 1000,
    meta: { amount: opts.amount ?? 1_000_000n, ...(opts.recipient ? { recipient: opts.recipient } : {}) },
    artifacts: {
      ...(opts.sourceTxHash ? { sourceTxHash: opts.sourceTxHash } : {}),
      ...(opts.errorCode ? { error: { code: opts.errorCode, message: opts.errorCode } } : {}),
    },
  } as unknown as TxRecord
}

describe('txRecordToActivityItem', () => {
  it('maps deposits (shield) to a positive inflow', () => {
    const item = txRecordToActivityItem(makeRecord('shield', { amount: 1_500_000n }))
    expect(item.kind).toBe('deposit')
    expect(item.amount).toBe(1.5)
    expect(item.label).toBe('Shield')
    expect(item.pending).toBe(false)
  })

  it('classifies an unshield as withdraw when the recipient is the connected wallet, else send', () => {
    const own = '0xME00000000000000000000000000000000000000'
    const other = '0xABCD000000000000000000000000000000000000'

    const withdraw = txRecordToActivityItem(
      makeRecord('unshield-local', { amount: 2_000_000n, recipient: own }),
      own,
    )
    expect(withdraw.kind).toBe('withdraw')
    expect(withdraw.amount).toBe(-2)

    const send = txRecordToActivityItem(
      makeRecord('unshield-local', { amount: 2_000_000n, recipient: other }),
      own,
    )
    expect(send.kind).toBe('send')
    expect(send.amount).toBe(-2)

    // No connected wallet → can't tell → defaults to send.
    const unknown = txRecordToActivityItem(makeRecord('unshield-local', { recipient: other }))
    expect(unknown.kind).toBe('send')
  })

  it('maps outgoing transfers to send (negative) and incoming to receive (positive)', () => {
    expect(txRecordToActivityItem(makeRecord('transfer-shielded', { amount: 1_000_000n })).kind).toBe('send')
    expect(txRecordToActivityItem(makeRecord('transfer-shielded', { amount: 1_000_000n })).amount).toBe(-1)
    const received = txRecordToActivityItem(makeRecord('transfer-shielded-received', { amount: 3_000_000n }))
    expect(received.kind).toBe('receive')
    expect(received.amount).toBe(3)
  })

  it('maps both vault directions to earn with opposite signs', () => {
    expect(txRecordToActivityItem(makeRecord('yield-deposit', { amount: 5_000_000n })).amount).toBe(-5)
    expect(txRecordToActivityItem(makeRecord('yield-withdraw', { amount: 5_000_000n })).amount).toBe(5)
    expect(txRecordToActivityItem(makeRecord('yield-deposit')).kind).toBe('earn')
  })

  it('flags non-terminal records as pending', () => {
    expect(txRecordToActivityItem(makeRecord('shield', { executionState: 'active' })).pending).toBe(true)
    expect(txRecordToActivityItem(makeRecord('shield', { executionState: 'waiting' })).pending).toBe(true)
    expect(txRecordToActivityItem(makeRecord('shield', { executionState: 'completed' })).pending).toBe(false)
    expect(txRecordToActivityItem(makeRecord('shield', { executionState: 'failed' })).pending).toBe(false)
  })

  it('carries through the source tx hash when present', () => {
    expect(txRecordToActivityItem(makeRecord('shield', { sourceTxHash: '0xabc' })).txHash).toBe('0xabc')
    expect(txRecordToActivityItem(makeRecord('shield')).txHash).toBeUndefined()
  })
})

describe('txListToActivityItems', () => {
  it('sorts newest-first and caps to max', () => {
    const list = [
      makeRecord('shield', { id: 'old', createdAt: 100 }),
      makeRecord('shield', { id: 'new', createdAt: 300 }),
      makeRecord('shield', { id: 'mid', createdAt: 200 }),
    ]
    const items = txListToActivityItems(list, null, 2)
    expect(items.map((i) => i.id)).toEqual(['new', 'mid'])
  })

  it('includes pending (non-terminal) records alongside history', () => {
    const list = [
      makeRecord('shield', { id: 'done', createdAt: 100, executionState: 'completed' }),
      makeRecord('unshield-local', { id: 'pending', updatedAt: 500, executionState: 'active' }),
    ]
    const items = txListToActivityItems(list)
    const pending = items.find((i) => i.id === 'pending')
    expect(pending?.pending).toBe(true)
    expect(items).toHaveLength(2)
  })
})

describe('requestLinkToActivityItem', () => {
  it('maps a created link to a neutral "Payment link created" row', () => {
    const item = requestLinkToActivityItem(makeLink({ amount: '25', createdAt: 1_500, expiresAt: 2_000 }))
    expect(item.kind).toBe('requestLink')
    expect(item.label).toBe('Payment link created')
    expect(item.amount).toBe(25) // positive/neutral — no sign applied here
    expect(item.pending).toBe(false)
    expect(item.requestId).toBe('req_abc')
    expect(item.expiresAt).toBe(2_000)
    expect(item.occurredAt).toBe(1_500)
  })
})

describe('buildActivityItems', () => {
  it('merges tx + request-link rows newest-first', () => {
    const tx = makeRecord('shield', { id: 'tx-old', amount: 1_000_000n, createdAt: 1_000, updatedAt: 1_000 })
    const link = makeLink({ requestId: 'req_new', createdAt: 3_000 })
    const items = buildActivityItems([tx], [link])
    expect(items.map((i) => i.id)).toEqual(['req_new', 'tx-old']) // link is newer → first
    expect(items[0]?.kind).toBe('requestLink')
  })

  it('caps the merged list at max', () => {
    const links = Array.from({ length: 5 }, (_, i) =>
      makeLink({ requestId: `req_${i}`, createdAt: 1_000 + i }),
    )
    expect(buildActivityItems([], links, null, 3)).toHaveLength(3)
  })

  it('returns every row when max is uncapped (Infinity) — the "all activity" panel path', () => {
    const links = Array.from({ length: 12 }, (_, i) =>
      makeLink({ requestId: `req_${i}`, createdAt: 1_000 + i }),
    )
    expect(buildActivityItems([], links, null, Infinity)).toHaveLength(12)
  })
})

describe('activity status derivation', () => {
  it('completed → settled; non-terminal → pending', () => {
    expect(txRecordToActivityItem(makeRecord('shield', { executionState: 'completed' })).status).toBe('settled')
    expect(txRecordToActivityItem(makeRecord('shield', { executionState: 'active' })).status).toBe('pending')
    expect(txRecordToActivityItem(makeRecord('shield', { executionState: 'waiting' })).status).toBe('pending')
  })

  it('definitive failures → failed', () => {
    const codes = ['TX_REVERTED', 'PRE_FLIGHT_REVERT', 'INTERRUPTED', 'FEE_EXPIRED', 'RPC_ERROR'] as const
    for (const code of codes) {
      const item = txRecordToActivityItem(makeRecord('unshield-local', { executionState: 'failed', errorCode: code }))
      expect(item.status).toBe('failed')
    }
  })

  it('user aborts → cancelled (app Cancel button + declined wallet prompt), code is authoritative', () => {
    // App Cancel button before broadcast.
    expect(
      txRecordToActivityItem(makeRecord('shield', { executionState: 'cancelled', errorCode: 'CANCELLED' })).status,
    ).toBe('cancelled')
    // Declined wallet signature — lands on a `failed` state but is a user cancellation, not a failure.
    expect(
      txRecordToActivityItem(makeRecord('shield', { executionState: 'failed', errorCode: 'USER_REJECTED' })).status,
    ).toBe('cancelled')
    // A CANCELLED code that lands on a `failed` state (e.g. thrown → markFailed) is still cancelled.
    expect(
      txRecordToActivityItem(makeRecord('shield', { executionState: 'failed', errorCode: 'CANCELLED' })).status,
    ).toBe('cancelled')
  })

  it('indeterminate outcomes → unknown (may still have settled on chain)', () => {
    // expired = past the time budget; we never watched it to completion.
    expect(txRecordToActivityItem(makeRecord('shield', { executionState: 'expired' })).status).toBe('unknown')
    // DISMISSED sits on a `cancelled` executionState but is indeterminate — must NOT read as cancelled.
    expect(
      txRecordToActivityItem(makeRecord('shield', { executionState: 'cancelled', errorCode: 'DISMISSED' })).status,
    ).toBe('unknown')
    for (const code of ['POLL_TIMEOUT', 'DUPLICATE_TX'] as const) {
      expect(
        txRecordToActivityItem(makeRecord('shield', { executionState: 'failed', errorCode: code })).status,
      ).toBe('unknown')
    }
  })
})
