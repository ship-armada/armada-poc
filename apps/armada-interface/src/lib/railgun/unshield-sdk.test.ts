// ABOUTME: Unit test for buildUnshieldSdk — maps inputs into a planTransfer request (unshield + fee, no
// ABOUTME: shielded outputs) and threads plan → prove → toTransactionData → buildTransactCalldata into { to, data }.

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

import { buildUnshieldSdk } from './unshield-sdk'

const POOL = '0xpool000000000000000000000000000000000000' as const
const RECIPIENT = '0xbob0000000000000000000000000000000000000' as const

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.planTransfer.mockResolvedValue({ plan: true })
  hoisted.prove.mockResolvedValue({ toTransactionData: () => ({ tx: 'data' }) })
  hoisted.buildTransactCalldata.mockReturnValue({ to: POOL, data: '0xdeadbeef', value: 0n })
})

describe('buildUnshieldSdk', () => {
  it('plans the unshield (recipient EVM addr) + broadcaster fee, no shielded outputs, then serializes to { to, data }', async () => {
    const r = await buildUnshieldSdk({
      recipient: RECIPIENT,
      amount: 5_000_000n,
      broadcasterFee: { amount: 20_000n, recipientAddress: '0zk_relayer' },
      poolAddress: POOL,
    })
    expect(hoisted.planTransfer).toHaveBeenCalledWith({
      outputs: [],
      unshield: { recipient: RECIPIENT, amount: 5_000_000n },
      fee: { schedule: { transfer: '20000' }, broadcasterRailgunAddress: '0zk_relayer', feesCacheId: '', expiresAt: 0 },
    })
    expect(hoisted.buildTransactCalldata).toHaveBeenCalledWith([{ tx: 'data' }], POOL)
    expect(r).toEqual({ to: POOL, data: '0xdeadbeef' })
  })

  it('emits a zero fee (no broadcaster output) for direct submission', async () => {
    await buildUnshieldSdk({ recipient: RECIPIENT, amount: 1n, broadcasterFee: null, poolAddress: POOL })
    expect(hoisted.planTransfer).toHaveBeenCalledWith({
      outputs: [],
      unshield: { recipient: RECIPIENT, amount: 1n },
      fee: { schedule: { transfer: '0' }, broadcasterRailgunAddress: '', feesCacheId: '', expiresAt: 0 },
    })
  })
})
