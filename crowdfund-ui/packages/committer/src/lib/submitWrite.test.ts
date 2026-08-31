// ABOUTME: Tests for submitWrite / assertHubChain — the mobile/desktop send split + live hub-chain assertion.
// ABOUTME: Verifies a desktop send on the wrong chain is blocked (never broadcast), and mobile routes to wagmi unasserted.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Contract, Signer } from 'ethers'

let mobile = false
vi.mock('@/lib/isMobileBrowser', () => ({ isMobileBrowser: () => mobile }))

const mockWagmiSubmit = vi.fn()
vi.mock('@/lib/mobileTxSubmit', () => ({
  submitTxViaWagmi: (...args: unknown[]) => mockWagmiSubmit(...args),
}))

// Hub chain = 1 for the tests.
vi.mock('@/config/network', () => ({
  getHubChainId: () => 1,
  getHubNetworkLabel: () => 'Ethereum',
}))

import { submitWrite, assertHubChain, isWrongChainError } from './submitWrite'

/** A signer whose live `eth_chainId` resolves to `chainIdHex` (or no `send` when null). */
function signerOnChain(chainIdHex: string | null): Signer {
  const provider = chainIdHex == null ? {} : { send: vi.fn().mockResolvedValue(chainIdHex) }
  return { provider } as unknown as Signer
}

/** A contract whose dynamic `contract[method](...)` access records (method, ...args). */
function contractWith(record: (...args: unknown[]) => unknown): Contract {
  return new Proxy(
    {},
    { get: (_t, prop: string) => (...args: unknown[]) => record(prop, ...args) },
  ) as unknown as Contract
}

beforeEach(() => {
  vi.clearAllMocks()
  mobile = false
})

describe('submitWrite (desktop)', () => {
  it('asserts the hub chain, then calls the ethers method', async () => {
    const method = vi.fn().mockResolvedValue({ hash: '0xabc' })
    const signer = signerOnChain('0x1') // live chain = hub
    const res = await submitWrite(contractWith(method), 'commit', [1, 100n], signer)

    expect(method).toHaveBeenCalledWith('commit', 1, 100n)
    expect(res).toEqual({ hash: '0xabc' })
    expect(mockWagmiSubmit).not.toHaveBeenCalled()
  })

  it('throws WRONG_CHAIN and never broadcasts when the wallet is on the wrong chain', async () => {
    const method = vi.fn()
    const signer = signerOnChain('0xaa36a7') // Sepolia, not the hub
    await expect(submitWrite(contractWith(method), 'commit', [1], signer)).rejects.toMatchObject({
      code: 'WRONG_CHAIN',
    })
    // Critically: the send never fired, so no duplicate/wrong-chain tx is broadcast.
    expect(method).not.toHaveBeenCalled()
  })

  it('proceeds (non-blocking) when the live chain cannot be queried', async () => {
    const method = vi.fn().mockResolvedValue({ hash: '0xok' })
    const signer = signerOnChain(null) // provider has no `send`
    await submitWrite(contractWith(method), 'commit', [1], signer)
    expect(method).toHaveBeenCalled()
  })
})

describe('submitWrite (mobile)', () => {
  it('routes to wagmi without a chain assertion', async () => {
    mobile = true
    mockWagmiSubmit.mockResolvedValue({ hash: '0xmobile' })
    const method = vi.fn()
    const send = vi.fn()
    const signer = { provider: { send } } as unknown as Signer

    const res = await submitWrite(contractWith(method), 'commit', [1], signer)

    expect(mockWagmiSubmit).toHaveBeenCalledWith(expect.anything(), 'commit', [1])
    expect(send).not.toHaveBeenCalled() // no eth_chainId assertion on mobile (wagmi pins it)
    expect(method).not.toHaveBeenCalled()
    expect(res).toEqual({ hash: '0xmobile' })
  })
})

describe('assertHubChain / isWrongChainError', () => {
  it('resolves on the hub chain', async () => {
    await expect(assertHubChain(signerOnChain('0x1'))).resolves.toBeUndefined()
  })

  it('throws a WRONG_CHAIN error off the hub chain', async () => {
    await expect(assertHubChain(signerOnChain('0x5'))).rejects.toMatchObject({ code: 'WRONG_CHAIN' })
  })

  it('isWrongChainError matches only the guard error', () => {
    expect(isWrongChainError(Object.assign(new Error('x'), { code: 'WRONG_CHAIN' }))).toBe(true)
    expect(isWrongChainError(new Error('x'))).toBe(false)
    expect(isWrongChainError(null)).toBe(false)
  })
})
