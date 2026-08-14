// ABOUTME: Unit tests for the TxRecord → dashboard activity-item adapter (direction, sign, label, pending, ordering).

import { describe, it, expect } from 'vitest'
import type { TxRecord, TxKind, TxExecutionState } from '@/lib/tx/types'
import { txRecordToActivityItem, txListToActivityItems } from './txActivityAdapter'

function makeRecord(
  kind: TxKind,
  opts: {
    id?: string
    amount?: bigint
    executionState?: TxExecutionState
    createdAt?: number
    updatedAt?: number
    sourceTxHash?: `0x${string}`
  } = {},
): TxRecord {
  return {
    id: opts.id ?? 'id-1',
    kind,
    executionState: opts.executionState ?? 'completed',
    createdAt: opts.createdAt ?? 1000,
    updatedAt: opts.updatedAt ?? 1000,
    meta: { amount: opts.amount ?? 1_000_000n },
    artifacts: opts.sourceTxHash ? { sourceTxHash: opts.sourceTxHash } : {},
  } as unknown as TxRecord
}

describe('txRecordToActivityItem', () => {
  it('maps deposits (shield) to a positive inflow', () => {
    const item = txRecordToActivityItem(makeRecord('shield', { amount: 1_500_000n }))
    expect(item.kind).toBe('deposit')
    expect(item.amount).toBe(1.5)
    expect(item.label).toBe('Deposit')
    expect(item.pending).toBe(false)
  })

  it('maps withdrawals (unshield) to a negative outflow', () => {
    const item = txRecordToActivityItem(makeRecord('unshield-local', { amount: 2_000_000n }))
    expect(item.kind).toBe('withdraw')
    expect(item.amount).toBe(-2)
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
    const items = txListToActivityItems(list, 2)
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
