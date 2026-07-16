// ABOUTME: Tests for useMobileChainReconciliation — desktop no-op invariant + mobile eth_chainId recovery.
// ABOUTME: Drives navigator.userAgent + a mocked getConnectorClient to exercise both platforms deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { Connector } from 'wagmi'

const mockGetConnectorClient = vi.fn()

vi.mock('wagmi/actions', () => ({
  getConnectorClient: (...args: unknown[]) => mockGetConnectorClient(...args),
}))

// The real config module executes RainbowKit's getDefaultConfig at load time.
vi.mock('@/config/wagmi', () => ({ wagmiConfig: { __testConfig: true } }))

import { useMobileChainReconciliation } from './useMobileChainReconciliation'

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

const originalUserAgent = navigator.userAgent
const aConnector = {} as unknown as Connector

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
}

/** Fake viem connector-client whose eth_chainId reads `chainHexRef.current`. */
function clientReturning(chainHexRef: { current: string }) {
  return {
    request: vi.fn(async ({ method }: { method: string }) =>
      method === 'eth_chainId' ? chainHexRef.current : null,
    ),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  setUserAgent(originalUserAgent)
})

describe('useMobileChainReconciliation — desktop invariant', () => {
  it('returns undefined and never reads a connector client on desktop', async () => {
    setUserAgent(DESKTOP_UA)
    mockGetConnectorClient.mockResolvedValue(clientReturning({ current: '0x1' }))
    const { result } = renderHook(() => useMobileChainReconciliation(aConnector))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toBeUndefined()
    expect(mockGetConnectorClient).not.toHaveBeenCalled()
  })
})

describe('useMobileChainReconciliation — mobile', () => {
  it('reads eth_chainId via getConnectorClient and returns the parsed chain id', async () => {
    setUserAgent(MOBILE_UA)
    const client = clientReturning({ current: '0xaa36a7' }) // sepolia 11155111
    mockGetConnectorClient.mockResolvedValue(client)
    const { result } = renderHook(() => useMobileChainReconciliation(aConnector))
    await waitFor(() => expect(result.current).toBe(11155111))
    expect(mockGetConnectorClient).toHaveBeenCalled()
    expect(client.request).toHaveBeenCalledWith({ method: 'eth_chainId' })
  })

  it('re-reads on focus so a stale chain recovers after a switch', async () => {
    setUserAgent(MOBILE_UA)
    const chainHex = { current: '0x1' } // start on the wrong chain
    mockGetConnectorClient.mockResolvedValue(clientReturning(chainHex))
    const { result } = renderHook(() => useMobileChainReconciliation(aConnector))
    await waitFor(() => expect(result.current).toBe(1))

    // Wallet switches; the missed chainChanged is recovered when the app regains focus.
    chainHex.current = '0xaa36a7'
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(result.current).toBe(11155111))
  })

  it('falls back to undefined (wagmi value) when the client read rejects', async () => {
    setUserAgent(MOBILE_UA)
    mockGetConnectorClient.mockRejectedValue(new Error('ConnectorNotConnectedError'))
    const { result } = renderHook(() => useMobileChainReconciliation(aConnector))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toBeUndefined()
  })

  it('returns undefined and does not read when there is no connector', async () => {
    setUserAgent(MOBILE_UA)
    mockGetConnectorClient.mockResolvedValue(clientReturning({ current: '0x1' }))
    const { result } = renderHook(() => useMobileChainReconciliation(undefined))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toBeUndefined()
    expect(mockGetConnectorClient).not.toHaveBeenCalled()
  })
})
