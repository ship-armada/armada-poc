// ABOUTME: Tests net private USDC from completed tx history.

import { describe, it, expect } from 'vitest'
import { computePrivateUsdcFromTxHistory } from './computePrivateUsdcFromTxHistory'
import type { TxRecord } from '@/lib/tx/types'

function deposit(amount: bigint, id = '1'): TxRecord {
  return {
    id,
    kind: 'shield',
    executionState: 'completed',
    stage: 'hub-confirmed',
    stagesCompleted: ['hub-confirmed'],
    meta: { amount, feeCacheId: 'f', fromChainId: 1 },
    artifacts: {},
    walletContext: { evmAddress: '0xabc', railgunWalletId: 'rg', sourceChainId: 1 },
    createdAt: 0,
    updatedAt: 0,
    updatedSeq: 1,
  } as TxRecord
}

describe('computePrivateUsdcFromTxHistory', () => {
  it('sums completed deposits', () => {
    const total = computePrivateUsdcFromTxHistory([
      deposit(500_000_000n, 'a'),
      deposit(300_000_000n, 'b'),
    ])
    expect(total).toBe(800_000_000n)
  })

  it('subtracts completed withdrawals', () => {
    const total = computePrivateUsdcFromTxHistory([
      deposit(1_000_000_000n),
      {
        ...deposit(200_000_000n, 'w'),
        kind: 'unshield-local',
        meta: { amount: 200_000_000n, feeCacheId: 'f', recipient: '0xabc' },
      } as TxRecord,
    ])
    expect(total).toBe(800_000_000n)
  })

  it('ignores pending deposits', () => {
    const total = computePrivateUsdcFromTxHistory([
      { ...deposit(500_000_000n), executionState: 'active' } as TxRecord,
    ])
    expect(total).toBe(0n)
  })
})
