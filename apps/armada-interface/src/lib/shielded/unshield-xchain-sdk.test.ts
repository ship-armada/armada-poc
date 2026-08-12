// ABOUTME: Unit test for buildXchainUnshieldSdk — plans the unshield to the POOL with a CCTP-binding adaptParams,
// ABOUTME: proves, and encodes atomicCrossChainUnshield from transactionToTuple + the CCTP args.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  planTransfer: vi.fn(),
  prove: vi.fn(),
  preflight: vi.fn(),
  transactionToTuple: vi.fn(),
  encodeCctpBinding: vi.fn(),
  encodeFunctionData: vi.fn(),
}))
vi.mock('@armada/sdk', () => ({
  transactionToTuple: hoisted.transactionToTuple,
  encodeCctpBinding: hoisted.encodeCctpBinding,
}))
vi.mock('viem', async (importActual) => {
  const actual = await importActual<typeof import('viem')>()
  return { ...actual, encodeFunctionData: hoisted.encodeFunctionData }
})
vi.mock('./sdk-read', () => ({
  getSdkWallet: async () => ({ planTransfer: hoisted.planTransfer, prove: hoisted.prove, preflight: hoisted.preflight }),
}))

import { buildXchainUnshieldSdk } from './unshield-xchain-sdk'

const POOL = '0xpool000000000000000000000000000000000000' as const
const FINAL = '0xbob0000000000000000000000000000000000000' as const
const NONCE = `0x${'11'.repeat(32)}` as const
const BINDING = `0x${'cd'.repeat(32)}` as const

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.planTransfer.mockResolvedValue({ plan: true })
  hoisted.prove.mockResolvedValue({ toTransactionData: () => ({ tx: 'data' }) })
  hoisted.preflight.mockResolvedValue({ ok: true, findings: [] })
  hoisted.transactionToTuple.mockReturnValue(['TUPLE'])
  hoisted.encodeCctpBinding.mockReturnValue(BINDING)
  hoisted.encodeFunctionData.mockReturnValue('0xcalldata')
})

describe('buildXchainUnshieldSdk', () => {
  it('plans the unshield to the POOL with the CCTP-binding adaptParams, then encodes the wrapper call', async () => {
    const r = await buildXchainUnshieldSdk({
      amount: 5_000_000n,
      broadcasterFee: { amount: 20_000n, recipientAddress: '0zk_relayer' },
      privacyPoolAddress: POOL,
      finalRecipient: FINAL,
      destinationDomain: 6,
      maxFee: 1_000n,
      uniqueNonce: NONCE,
    })
    // The binding covers the real destination (finalRecipient + domain + maxFee).
    expect(hoisted.encodeCctpBinding).toHaveBeenCalledWith(FINAL, 6, 1_000n)
    // The unshield note's recipient is the POOL (it forwards via CCTP); adaptParams carries the binding.
    expect(hoisted.planTransfer).toHaveBeenCalledWith({
      outputs: [],
      unshield: { recipient: POOL, amount: 5_000_000n, adaptParams: BINDING },
      fee: { schedule: { transfer: '20000' }, broadcasterShieldedAddress: '0zk_relayer', feesCacheId: '', expiresAt: 0 },
    })
    // The proved tx is embedded as a POSITIONAL tuple, then the CCTP args.
    expect(hoisted.transactionToTuple).toHaveBeenCalledWith({ tx: 'data' })
    expect(hoisted.encodeFunctionData).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'atomicCrossChainUnshield',
        args: [['TUPLE'], 6, FINAL, 1_000n, NONCE],
      }),
    )
    expect(r).toEqual({ to: POOL, data: '0xcalldata' })
  })

  it('emits a zero fee (no broadcaster output) for direct submission', async () => {
    await buildXchainUnshieldSdk({
      amount: 1n,
      broadcasterFee: null,
      privacyPoolAddress: POOL,
      finalRecipient: FINAL,
      destinationDomain: 6,
      maxFee: 0n,
      uniqueNonce: NONCE,
    })
    expect(hoisted.planTransfer).toHaveBeenCalledWith({
      outputs: [],
      unshield: { recipient: POOL, amount: 1n, adaptParams: BINDING },
      fee: { schedule: { transfer: '0' }, broadcasterShieldedAddress: '', feesCacheId: '', expiresAt: 0 },
    })
  })
})
