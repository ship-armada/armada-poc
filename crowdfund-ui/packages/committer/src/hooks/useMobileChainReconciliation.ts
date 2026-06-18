// ABOUTME: Mobile-only, read-only chain reconciliation — re-reads the live chain via wagmi's
// ABOUTME: getConnectorClient on app resume so a stale wagmi chainId recovers after a mobile switch.

import { useEffect, useState } from 'react'
import { getConnectorClient } from 'wagmi/actions'
import type { Connector } from 'wagmi'

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
 * Whenever the app regains focus / visibility, this re-reads the live chain via
 * wagmi's `getConnectorClient` action and an `eth_chainId` request (a round-trip
 * to the wallet, more authoritative than wagmi's cached value). We use the
 * action — which resolves the connector from the wagmi config, the same path
 * `resolveSigner` uses — rather than reaching into `useAccount().connector`,
 * whose `getProvider` is not reliably a function across the RainbowKit/wagmi
 * connector wrappers (it throws on mobile at load). The caller layers the result
 * over wagmi as `observed ?? accountChainId`.
 *
 * Strictly read-only and strictly mobile-scoped: on desktop (and SSR) the effect
 * early-returns before doing anything, registering listeners, or setting state,
 * and the hook returns `undefined` — so the caller's `observed ?? accountChainId`
 * reduces to exactly `accountChainId` and desktop behavior is byte-for-byte
 * unchanged.
 */
export function useMobileChainReconciliation(connector: Connector | undefined): number | undefined {
  const [observedChainId, setObservedChainId] = useState<number | undefined>(undefined)

  useEffect(() => {
    // Desktop (and SSR) no-op, plus a disconnected gate: nothing below runs, so
    // there are no client reads, no listeners, and no state changes.
    if (!isMobileBrowser() || !connector) return

    let cancelled = false

    const readChain = async () => {
      try {
        // Dynamic import: config/wagmi executes RainbowKit's getDefaultConfig at
        // module load (already evaluated by the app), and deferring it keeps this
        // module side-effect-free for the hook's unit tests.
        const { wagmiConfig } = await import('@/config/wagmi')
        const client = await getConnectorClient(wagmiConfig)
        const hex = (await client.request({ method: 'eth_chainId' })) as string
        const id = Number.parseInt(hex, 16)
        // Only override when the read gives a usable answer; a failed read (not
        // connected, wallet on an unconfigured chain, transport error) leaves the
        // override untouched so we fall back to wagmi's value.
        if (!cancelled && Number.isFinite(id)) setObservedChainId(id)
      } catch {
        // Provider/client unavailable — keep falling back to wagmi.
      }
    }

    void readChain() // reconcile immediately on (re)connect

    // Returning from the wallet app (the switch-network round-trip) fires focus /
    // visibilitychange — the moment a missed chainChanged would otherwise leave
    // us stale, so that's exactly when we re-read.
    const onResume = () => {
      if (document.visibilityState !== 'hidden') void readChain()
    }
    window.addEventListener('focus', onResume)
    document.addEventListener('visibilitychange', onResume)

    return () => {
      cancelled = true
      window.removeEventListener('focus', onResume)
      document.removeEventListener('visibilitychange', onResume)
    }
  }, [connector])

  // Belt-and-suspenders: only ever expose the override on mobile. On desktop the
  // state is never set anyway, but this makes the desktop-returns-undefined
  // invariant explicit at the return site.
  return isMobileBrowser() ? observedChainId : undefined
}
