// ABOUTME: Tests for useMobileChainReconciliation — desktop no-op invariant + mobile eth_chainId recovery.
// ABOUTME: Drives navigator.userAgent + a fake connector provider to exercise both platforms deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { Connector } from 'wagmi'
import { useMobileChainReconciliation } from './useMobileChainReconciliation'

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

const originalUserAgent = navigator.userAgent

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
}

/** Fake wagmi connector whose provider answers eth_chainId with `chainHexRef.current`. */
function makeConnector(chainHexRef: { current: string }) {
  const provider = {
    request: vi.fn(async ({ method }: { method: string }) =>
      method === 'eth_chainId' ? chainHexRef.current : null,
    ),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const connector = { getProvider: vi.fn(async () => provider) }
  return { connector: connector as unknown as Connector, provider, getProvider: connector.getProvider }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  setUserAgent(originalUserAgent)
})

describe('useMobileChainReconciliation — desktop invariant', () => {
  it('returns undefined and never touches the provider on desktop', async () => {
    setUserAgent(DESKTOP_UA)
    const { connector, getProvider } = makeConnector({ current: '0x1' })
    const { result } = renderHook(() => useMobileChainReconciliation(connector))
    // Let any (non-existent) async settle.
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toBeUndefined()
    expect(getProvider).not.toHaveBeenCalled()
  })
})

describe('useMobileChainReconciliation — mobile', () => {
  it('reads eth_chainId from the connector provider and returns the parsed chain id', async () => {
    setUserAgent(MOBILE_UA)
    const { connector, provider } = makeConnector({ current: '0xaa36a7' }) // sepolia 11155111
    const { result } = renderHook(() => useMobileChainReconciliation(connector))
    await waitFor(() => expect(result.current).toBe(11155111))
    expect(provider.request).toHaveBeenCalledWith({ method: 'eth_chainId' })
  })

  it('re-reads on focus so a stale chain recovers after a switch', async () => {
    setUserAgent(MOBILE_UA)
    const chainHex = { current: '0x1' } // start on the wrong chain
    const { connector } = makeConnector(chainHex)
    const { result } = renderHook(() => useMobileChainReconciliation(connector))
    await waitFor(() => expect(result.current).toBe(1))

    // Wallet switches; the missed chainChanged is recovered when the app regains focus.
    chainHex.current = '0xaa36a7'
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(result.current).toBe(11155111))
  })

  it('falls back to undefined (wagmi value) when the provider read rejects', async () => {
    setUserAgent(MOBILE_UA)
    const provider = {
      request: vi.fn(async () => {
        throw new Error('provider unavailable')
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    }
    const connector = { getProvider: vi.fn(async () => provider) } as unknown as Connector
    const { result } = renderHook(() => useMobileChainReconciliation(connector))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toBeUndefined()
  })

  it('returns undefined when there is no connector', async () => {
    setUserAgent(MOBILE_UA)
    const { result } = renderHook(() => useMobileChainReconciliation(undefined))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toBeUndefined()
  })
})
