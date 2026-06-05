import { describe, it, expect } from 'vitest'
import { shieldWalletInteractionsComplete, shieldWalletSteps } from './shieldWalletSteps'
import type { TxRecord } from './types'

const base: TxRecord<'shield'> = {
  id: '01JX',
  kind: 'shield',
  executionState: 'active',
  stage: 'build-proof',
  stagesCompleted: [],
  updatedSeq: 1,
  createdAt: 0,
  updatedAt: 0,
  meta: { amount: 5_000_000n, feeCacheId: 'fc-1', fromChainId: 31337 },
  artifacts: {},
  walletContext: {
    evmAddress: '0xabc',
    railgunWalletId: 'rg-1',
    sourceChainId: 31337,
  },
}

describe('shieldWalletSteps', () => {
  it('shows authorize loading before a record exists', () => {
    const steps = shieldWalletSteps(null, 5_000_000n)
    expect(steps[0]).toMatchObject({ label: 'Authorize deposit', status: 'loading' })
    expect(steps.some(s => s.label.includes('Approve'))).toBe(true)
  })

  it('omits approve row when allowance was sufficient', () => {
    const record: TxRecord<'shield'> = {
      ...base,
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      artifacts: { approveSkipped: true },
    }
    const steps = shieldWalletSteps(record, 5_000_000n)
    expect(steps.map(s => s.label)).toEqual([
      'Authorize deposit',
      'Submit 5.00 USDC deposit',
    ])
    expect(steps[0].status).toBe('done')
    expect(steps[1].status).toBe('loading')
  })

  it('wallet interactions incomplete until authorize, approve, and deposit submit', () => {
    const mid: TxRecord<'shield'> = {
      ...base,
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      artifacts: { sourceTxHash: '0xabc' as `0x${string}` },
    }
    expect(shieldWalletInteractionsComplete(mid)).toBe(false)

    const done: TxRecord<'shield'> = {
      ...mid,
      artifacts: {
        sourceTxHash: '0xabc' as `0x${string}`,
        approveTxHash: '0xdef' as `0x${string}`,
      },
    }
    expect(shieldWalletInteractionsComplete(done)).toBe(true)
  })
})
