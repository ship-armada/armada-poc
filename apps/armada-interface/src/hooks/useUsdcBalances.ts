// ABOUTME: Polls connected wallet's public USDC balance on every configured chain via React Query — per-chain queries dedup, jitter naturally, and pause when the tab is hidden.
// ABOUTME: Mount once at App root. Mirrors results into usdcBalancesAtom for atom-based consumers (ShieldModal MAX, etc).

import { useQueries, useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { erc20Abi } from 'viem'
import { readContract } from 'wagmi/actions'
import { wagmiConfig } from '@/config/wagmi'
import { useWallet } from '@/hooks/useWallet'
import { loadDeployments } from '@/config/deployments'
import { tabVisibleAtom } from '@/state/visibility'
import { usdcBalancesAtom } from '@/state/wallet'
import { trackError } from '@/lib/telemetry'

const POLL_INTERVAL_MS = 15_000

/**
 * Fold fulfilled per-chain query results into the prior balances map. Returns the SAME `prev`
 * reference when nothing actually changed, so a poll tick that re-reads identical balances does
 * not create a new object and therefore does not notify `usdcBalancesAtom` subscribers (no
 * downstream re-render). Unfulfilled entries (no `data`) are skipped so one slow chain doesn't
 * blank the others.
 */
export function mergeUsdcBalances(
  prev: Record<number, bigint>,
  results: ReadonlyArray<{ data?: { chainId: number; balance: bigint } }>,
): Record<number, bigint> {
  let changed = false
  const next = { ...prev }
  for (const r of results) {
    if (r.data && next[r.data.chainId] !== r.data.balance) {
      next[r.data.chainId] = r.data.balance
      changed = true
    }
  }
  return changed ? next : prev
}

/**
 * Reads the connected wallet's public USDC balance on every configured chain (hub + clients)
 * every 15s and mirrors them into `usdcBalancesAtom`. The ShieldModal reads this atom to
 * populate its MAX based on the currently-selected `fromChainId`.
 *
 * Per-chain reads go through one React Query per chain. Query dedup means multiple mounts share
 * a single in-flight request per chain. The natural per-query scheduling (each query schedules
 * its own interval starting at its own first-success time) jitters network traffic so all chains
 * don't fire on the same millisecond.
 */
export function useUsdcBalances(): void {
  const { address } = useWallet()
  const setBalances = useSetAtom(usdcBalancesAtom)
  const tabVisible = useAtomValue(tabVisibleAtom)

  // Deployments load once and rarely change at runtime — cache them via a static query rather
  // than re-fetching per balance tick (the prior implementation did the latter unnecessarily).
  const deployments = useQuery({
    queryKey: ['deployments'],
    queryFn: () => loadDeployments(),
    staleTime: Infinity,
    gcTime: Infinity,
    // A flaky first manifest load otherwise leaves `pairs` empty (no balances, blank MAX) until a
    // window refocus happens to retrigger. Retry with capped exponential backoff so it self-heals.
    // `staleTime: Infinity` still means it never re-fetches once it has succeeded. (P2/WS3.4)
    retry: true,
    retryDelay: attempt => Math.min(1_000 * 2 ** attempt, 30_000),
  })

  const pairs = deployments.data
    ? [
        {
          chainId: deployments.data.hub.chainId,
          usdcAddress: deployments.data.hub.cctp.usdc as `0x${string}`,
        },
        ...deployments.data.clients.map(c => ({
          chainId: c.chainId,
          usdcAddress: c.cctp.usdc as `0x${string}`,
        })),
      ]
    : []

  // Initialization order: deployments query runs first → on success `pairs` populates → only then
  // does `useQueries` spin up per-chain balance queries. `pairs` is `[]` until deployments resolve,
  // so no balance queries run prematurely. Once pairs exist, each per-chain query also gates on
  // `enabled: !!address` (skip when wallet disconnected) and `refetchInterval: tabVisible ? ... : false`
  // (pause polling when tab hidden, but still run the initial fetch on mount).
  const results = useQueries({
    queries: pairs.map(pair => ({
      queryKey: ['usdc-balance', pair.chainId, pair.usdcAddress, address] as const,
      queryFn: async (): Promise<{ chainId: number; balance: bigint; address: string }> => {
        const balance = await readContract(wagmiConfig, {
          address: pair.usdcAddress,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address as `0x${string}`],
          chainId: pair.chainId,
        })
        // Tag with the address this balance was read for, so the mirror effect can reject a prior
        // account's results that useQueries still returns for one render after a switch. (W-2)
        return { chainId: pair.chainId, balance, address: address as string }
      },
      enabled: !!address,
      refetchInterval: tabVisible ? POLL_INTERVAL_MS : false,
      refetchIntervalInBackground: false,
      // No cross-key placeholderData: `(prev) => prev` would carry the PREVIOUS account's balance
      // into the new (address-keyed) query while it loads, so account B briefly showed account A's
      // USDC. Same-address poll refetches keep their data via the stable query key — they don't
      // need a placeholder. (W-2)
      staleTime: 0,
    })),
  })

  // Clear the atom on EVERY address change — disconnect OR account switch — so a prior account's
  // balances never linger. On an A→B switch both addresses are truthy, so a disconnect-only guard
  // would leave A's USDC showing in the pill / ShieldModal MAX (spendable!) until B's reads land.
  // Re-population follows from the mirror effect below once B's queries resolve. (W-2)
  useEffect(() => {
    setBalances({})
  }, [address, setBalances])

  // Mirror fulfilled results into the atom. Re-runs on every render whose `results` array changes
  // (React Query hands back a fresh array each poll tick even when the values are identical), so
  // `mergeUsdcBalances` returns the SAME map reference when nothing changed — no atom write, no
  // re-render of MAX-button consumers on a steady-state poll.
  useEffect(() => {
    if (!address) return
    // Only fold in results read for the CURRENT address. useQueries hands back the prior account's
    // resolved results for one render after an address change (observers re-subscribe async);
    // without this filter the mirror would re-write account A's balances right after the clear
    // effect wiped them, defeating W-2.
    const current = results.filter(r => r.data?.address === address)
    setBalances(prev => mergeUsdcBalances(prev, current))
  }, [results, address, setBalances])

  // Surface persistent failures via telemetry (once per error transition per chain).
  useEffect(() => {
    const failed = results.filter(r => r.error)
    if (failed.length > 0) {
      trackError('useUsdcBalances.query', failed[0]!.error, {
        scope: 'usdc.balance',
        message: `${failed.length}/${results.length} chain reads failed`,
      })
    }
  }, [results])
}
