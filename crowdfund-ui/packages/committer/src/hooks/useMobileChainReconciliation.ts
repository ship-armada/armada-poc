// ABOUTME: Mobile-only, read-only chain reconciliation — re-reads the live chain from
// ABOUTME: the active connector's provider on app resume so a stale wagmi chainId recovers.

import { useEffect, useState } from 'react'
import type { Connector } from 'wagmi'

/** Minimal EIP-1193 surface we use from the connector's provider. */
type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}

/** Heuristic mobile-browser check. Deliberately conservative — only true for
 *  actual mobile user agents so desktop never enters the reconciliation path. */
export function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

/**
 * Mobile-only chain reconciliation. On mobile, wagmi's `useAccount().chainId`
 * can go stale after a network switch when MetaMask Mobile fails to deliver the
 * `chainChanged` event (wagmi #4551 / #4600, MetaMask Mobile #6706): the dapp is
 * redirected back before the update lands, so wagmi keeps reporting the old
 * chain and the UI sticks on "wrong network".
 *
 * This re-reads the live chain directly from the active connector's provider
 * (`eth_chainId` — a round-trip to the wallet, more authoritative than any
 * cached value) whenever the app regains focus / visibility, and on the
 * provider's own `chainChanged`. The caller layers the result over wagmi as
 * `observed ?? accountChainId`.
 *
 * Strictly read-only and strictly mobile-scoped: on desktop (and SSR) the effect
 * early-returns before touching the provider, registering listeners, or setting
 * state, and the hook returns `undefined` — so the caller's `observed ??
 * accountChainId` reduces to exactly `accountChainId` and desktop behavior is
 * byte-for-byte unchanged.
 */
export function useMobileChainReconciliation(connector: Connector | undefined): number | undefined {
  const [observedChainId, setObservedChainId] = useState<number | undefined>(undefined)

  useEffect(() => {
    // Desktop (and SSR) no-op: nothing below runs, so there are no provider
    // calls, no event listeners, and no state changes — observedChainId stays
    // undefined for the lifetime of the hook.
    if (!isMobileBrowser() || !connector) return

    let cancelled = false
    let provider: Eip1193Provider | null = null

    const readChain = async (p: Eip1193Provider) => {
      try {
        const hex = (await p.request({ method: 'eth_chainId' })) as string
        const id = Number.parseInt(hex, 16)
        // Only override when the provider gives a usable answer; a failed or
        // malformed read leaves the override untouched so we fall back to wagmi.
        if (!cancelled && Number.isFinite(id)) setObservedChainId(id)
      } catch {
        // Provider unavailable / read rejected — keep falling back to wagmi.
      }
    }

    const onResume = () => {
      if (provider && document.visibilityState !== 'hidden') void readChain(provider)
    }
    const onChainChanged = () => {
      if (provider) void readChain(provider)
    }

    void connector
      .getProvider()
      .then((p) => {
        if (cancelled || !p) return
        provider = p as Eip1193Provider
        void readChain(provider) // reconcile immediately on (re)connect
        provider.on?.('chainChanged', onChainChanged)
      })
      .catch(() => {
        // No provider available — stay on wagmi's value.
      })

    // Returning from the wallet app (the switch-network round-trip) fires focus /
    // visibilitychange — the moment a missed chainChanged would otherwise leave
    // us stale, so that's exactly when we re-read.
    window.addEventListener('focus', onResume)
    document.addEventListener('visibilitychange', onResume)

    return () => {
      cancelled = true
      window.removeEventListener('focus', onResume)
      document.removeEventListener('visibilitychange', onResume)
      provider?.removeListener?.('chainChanged', onChainChanged)
    }
  }, [connector])

  // Belt-and-suspenders: only ever expose the override on mobile. On desktop the
  // state is never set anyway, but this makes the desktop-returns-undefined
  // invariant explicit at the return site.
  return isMobileBrowser() ? observedChainId : undefined
}
