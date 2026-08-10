// ABOUTME: Unit test for buildTransferSdk — maps inputs into a planTransfer request (outputs + fee) and
// ABOUTME: threads plan → prove → toTransactionData → buildTransactCalldata into the { to, data } result.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  planTransfer: vi.fn(),
  prove: vi.fn(),
  buildTransactCalldata: vi.fn(),
}))
vi.mock('@armada/sdk', () => ({ buildTransactCalldata: hoisted.buildTransactCalldata }))
vi.mock('./sdk-read', () => ({
  getSdkWallet: async () => ({ planTransfer: hoisted.planTransfer, prove: hoisted.prove }),
}))

import { buildTransferSdk } from './transfer-sdk'

const POOL = '0xpool000000000000000000000000000000000000' as const

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.planTransfer.mockResolvedValue({ plan: true })
  hoisted.prove.mockResolvedValue({ toTransactionData: () => ({ tx: 'data' }) })
  hoisted.buildTransactCalldata.mockReturnValue({ to: POOL, data: '0xdeadbeef', value: 0n })
})

describe('buildTransferSdk', () => {
  it('plans with the recipient output + broadcaster fee, then serializes the proved tx to { to, data }', async () => {
    const r = await buildTransferSdk({
      recipient: '0zk_bob',
      amount: 5_000_000n,
      broadcasterFee: { amount: 20_000n, recipientAddress: '0zk_relayer' },
      poolAddress: POOL,
    })
    expect(hoisted.planTransfer).toHaveBeenCalledWith({
      outputs: [{ to0zk: '0zk_bob', amount: 5_000_000n }],
      fee: { schedule: { transfer: '20000' }, broadcasterRailgunAddress: '0zk_relayer', feesCacheId: '', expiresAt: 0 },
    })
    expect(hoisted.buildTransactCalldata).toHaveBeenCalledWith([{ tx: 'data' }], POOL)
    expect(r).toEqual({ to: POOL, data: '0xdeadbeef' })
  })

  it('emits a zero fee (no broadcaster output) for direct submission', async () => {
    await buildTransferSdk({ recipient: '0zk_bob', amount: 1n, broadcasterFee: null, poolAddress: POOL })
    expect(hoisted.planTransfer).toHaveBeenCalledWith({
      outputs: [{ to0zk: '0zk_bob', amount: 1n }],
      fee: { schedule: { transfer: '0' }, broadcasterRailgunAddress: '', feesCacheId: '', expiresAt: 0 },
    })
  })
})
