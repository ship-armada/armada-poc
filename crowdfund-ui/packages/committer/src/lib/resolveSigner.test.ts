// ABOUTME: Tests for resolveSigner — imperative connector-client resolution with switch-retry on chain mismatch.
// ABOUTME: Mocks wagmi actions + config so connector behavior is driven per test.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetConnectorClient = vi.fn()
const mockSwitchChain = vi.fn()

vi.mock('wagmi/actions', () => ({
  getConnectorClient: (...args: unknown[]) => mockGetConnectorClient(...args),
  switchChain: (...args: unknown[]) => mockSwitchChain(...args),
}))

// The real config module executes RainbowKit's getDefaultConfig at load time.
vi.mock('@/config/wagmi', () => ({ wagmiConfig: { __testConfig: true } }))

const fakeSigner = { __signer: true }
vi.mock('@/lib/wagmiAdapter', () => ({
  walletClientToSigner: vi.fn(() => fakeSigner),
}))

import { resolveSigner, describeSignerError } from './resolveSigner'

// VITE_NETWORK is forced to 'local' in vitest.config.ts, so the hub chain id is Anvil's.
const HUB_CHAIN_ID = 31337

class NamedError extends Error {
  constructor(name: string, message = name) {
    super(message)
    this.name = name
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveSigner', () => {
  it('resolves a signer from the connector client for the hub chain', async () => {
    mockGetConnectorClient.mockResolvedValue({ account: {}, chain: { id: HUB_CHAIN_ID } })
    await expect(resolveSigner()).resolves.toBe(fakeSigner)
    expect(mockGetConnectorClient).toHaveBeenCalledWith(
      expect.objectContaining({ __testConfig: true }),
      { chainId: HUB_CHAIN_ID },
    )
    expect(mockSwitchChain).not.toHaveBeenCalled()
  })

  it('switches chain and retries once on a connector chain mismatch', async () => {
    mockGetConnectorClient
      .mockRejectedValueOnce(new NamedError('ConnectorChainMismatchError'))
      .mockResolvedValueOnce({ account: {}, chain: { id: HUB_CHAIN_ID } })
    mockSwitchChain.mockResolvedValue({ id: HUB_CHAIN_ID })
    await expect(resolveSigner()).resolves.toBe(fakeSigner)
    expect(mockSwitchChain).toHaveBeenCalledWith(expect.anything(), { chainId: HUB_CHAIN_ID })
    expect(mockGetConnectorClient).toHaveBeenCalledTimes(2)
  })

  it('propagates the retry failure after a mismatch-triggered switch', async () => {
    mockGetConnectorClient
      .mockRejectedValueOnce(new NamedError('ConnectorChainMismatchError'))
      .mockRejectedValueOnce(new NamedError('ConnectorChainMismatchError', 'still mismatched'))
    mockSwitchChain.mockResolvedValue({ id: HUB_CHAIN_ID })
    await expect(resolveSigner()).rejects.toThrow('still mismatched')
    expect(mockSwitchChain).toHaveBeenCalledTimes(1)
  })

  it('rethrows non-mismatch errors without attempting a switch', async () => {
    mockGetConnectorClient.mockRejectedValue(new NamedError('ConnectorNotConnectedError'))
    await expect(resolveSigner()).rejects.toThrow()
    expect(mockSwitchChain).not.toHaveBeenCalled()
  })
})

describe('describeSignerError', () => {
  it('describes a declined network switch', () => {
    expect(describeSignerError({ code: 4001, message: 'User rejected the request' })).toMatch(
      /switch/i,
    )
  })

  it('describes a disconnected wallet', () => {
    expect(describeSignerError(new NamedError('ConnectorNotConnectedError'))).toMatch(/reconnect/i)
  })

  it('falls back to the underlying message for unknown errors', () => {
    expect(describeSignerError(new Error('boom'))).toContain('boom')
  })
})
