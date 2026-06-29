// ABOUTME: Tests for submitTxViaWagmi — wagmi submit + the ethers-shaped wait shim (status/logs/timeout).
// ABOUTME: Mocks wagmi actions + config so the mobile submit path is exercised deterministically.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Contract } from 'ethers'

const mockSendTransaction = vi.fn()
const mockWaitForReceipt = vi.fn()

vi.mock('wagmi/actions', () => ({
  sendTransaction: (...args: unknown[]) => mockSendTransaction(...args),
  waitForTransactionReceipt: (...args: unknown[]) => mockWaitForReceipt(...args),
}))

vi.mock('@/config/wagmi', () => ({ wagmiConfig: { __testConfig: true } }))
vi.mock('@/config/network', () => ({ getHubChainId: () => 11155111, getTxConfirmations: () => 1 }))

import { submitTxViaWagmi } from './mobileTxSubmit'

function fakeContract() {
  return {
    target: '0x00000000000000000000000000000000000000c0',
    interface: {
      encodeFunctionData: vi.fn(() => '0xdeadbeef'),
    },
  } as unknown as Contract
}

/** Loosely-typed view of the shim's wait result for assertions. */
type ShimReceipt = { status: number; logs: Array<Record<string, unknown>> }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('submitTxViaWagmi', () => {
  it('encodes the call and submits via wagmi sendTransaction on the hub chain', async () => {
    const contract = fakeContract()
    mockSendTransaction.mockResolvedValue('0xhash')
    const resp = await submitTxViaWagmi(contract, 'claim', ['0xdelegate'])

    expect(contract.interface.encodeFunctionData).toHaveBeenCalledWith('claim', ['0xdelegate'])
    expect(mockSendTransaction).toHaveBeenCalledWith(
      { __testConfig: true },
      { to: contract.target, data: '0xdeadbeef', chainId: 11155111 },
    )
    expect(resp.hash).toBe('0xhash')
  })

  it('maps a confirmed viem receipt to the ethers status (1) + ReceiptLogLike logs', async () => {
    mockSendTransaction.mockResolvedValue('0xhash')
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      logs: [{ topics: ['0xa'], data: '0xb', blockNumber: 10n, transactionHash: '0xhash', logIndex: 2 }],
    })
    const resp = await submitTxViaWagmi(fakeContract(), 'claim', [])
    const receipt = (await resp.wait()) as unknown as ShimReceipt

    expect(mockWaitForReceipt).toHaveBeenCalledWith(
      { __testConfig: true },
      expect.objectContaining({ hash: '0xhash', confirmations: 1 }),
    )
    expect(receipt.status).toBe(1)
    expect(receipt.logs[0]).toEqual({
      topics: ['0xa'],
      data: '0xb',
      blockNumber: 10,
      transactionHash: '0xhash',
      logIndex: 2,
    })
  })

  it('maps a reverted viem receipt to status 0', async () => {
    mockSendTransaction.mockResolvedValue('0xhash')
    mockWaitForReceipt.mockResolvedValue({ status: 'reverted', logs: [] })
    const resp = await submitTxViaWagmi(fakeContract(), 'claim', [])
    const receipt = (await resp.wait()) as unknown as ShimReceipt
    expect(receipt.status).toBe(0)
  })

  it('normalizes a viem receipt timeout to the ethers TIMEOUT shape', async () => {
    mockSendTransaction.mockResolvedValue('0xhash')
    mockWaitForReceipt.mockRejectedValue(
      Object.assign(new Error('timed out'), { name: 'WaitForTransactionReceiptTimeoutError' }),
    )
    const resp = await submitTxViaWagmi(fakeContract(), 'claim', [])
    await expect(resp.wait()).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
