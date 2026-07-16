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
  it('renders Approve + Submit rows before a record exists', () => {
    // WHY: build-proof now runs silently (ephemeral shieldPrivateKey, no wallet prompt) — the
    // pre-record snapshot starts with Approve pending, not an "Authorize" placeholder.
    const steps = shieldWalletSteps(null, 5_000_000n)
    expect(steps.map(s => s.label)).toEqual([
      'Approve 5.00 USDC',
      'Submit 5.00 USDC deposit',
    ])
  })

  it('omits approve row when allowance was sufficient', () => {
    const record: TxRecord<'shield'> = {
      ...base,
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      artifacts: { approveSkipped: true },
    }
    const steps = shieldWalletSteps(record, 5_000_000n)
    expect(steps.map(s => s.label)).toEqual(['Submit 5.00 USDC deposit'])
    expect(steps[0].status).toBe('loading')
  })

  it('gasless: collapses to a single "Authorize deposit" row, done once build-proof completes (S-M4)', () => {
    const building: TxRecord<'shield'> = {
      ...base,
      meta: { ...base.meta, useGasless: true },
      stage: 'build-proof',
      stagesCompleted: [],
    }
    const buildingSteps = shieldWalletSteps(building, 5_000_000n)
    expect(buildingSteps.map(s => s.label)).toEqual(['Authorize 5.00 USDC deposit'])
    expect(buildingSteps[0].status).toBe('loading')

    const authorized: TxRecord<'shield'> = {
      ...building,
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
    }
    expect(shieldWalletSteps(authorized, 5_000_000n)[0].status).toBe('done')
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
