// ABOUTME: Jotai atoms for wallet state — EVM connection (mirrored from wagmi) + plural Railgun shielded wallets + Railgun engine warmup.
// ABOUTME: EVM state sourced from wagmi hooks. Plural-wallet schema is future-proofing per reviewer #5; v1 only ever populates one entry.

import { atom } from 'jotai'
import type { ShieldedWalletState } from '@/lib/railgun/wallet'

/** Truncated/raw EVM address of the connected wallet. null = not connected. */
export const evmAddressAtom = atom<string | null>(null)

/** Plural shielded wallets, keyed by railgunWalletId. Schema is plural even in v1 (one entry). */
export const shieldedWalletsAtom = atom<Record<string, ShieldedWalletState>>({})

/** Which entry in `shieldedWalletsAtom` is currently active. Null when no wallet exists or none selected. */
export const activeRailgunWalletIdAtom = atom<string | null>(null)

/** Derived: the active wallet's state, or null. UI mostly reads this; write paths use the two source atoms above. */
export const activeShieldedWalletAtom = atom<ShieldedWalletState | null>((get) => {
  const id = get(activeRailgunWalletIdAtom)
  if (!id) return null
  return get(shieldedWalletsAtom)[id] ?? null
})

/**
 * Legacy alias retained until Bundle 2 consumers fully migrate to `activeShieldedWalletAtom`.
 * For now, returns a thin compat shape ({ status: 'missing' } when no wallet, else the active one).
 */
export const shieldedWalletAtom = atom<{ status: 'locked' | 'unlocked' | 'missing'; railgunAddress?: string }>((get) => {
  const active = get(activeShieldedWalletAtom)
  if (!active) return { status: 'missing' }
  return { status: active.status, railgunAddress: active.railgunAddress }
})

/** Railgun proving engine state. Used by the UI to indicate "warming up…" before first-tx readiness. */
export type RailgunEngineState = 'cold' | 'warming' | 'ready' | 'failed'

export const railgunEngineAtom = atom<{ state: RailgunEngineState; error?: string }>({ state: 'cold' })

/**
 * Unshielded USDC balance per chain id (raw 6-decimal units). Empty map until balances hook fetches.
 */
export const usdcBalancesAtom = atom<Record<number, bigint>>({})

/** Shielded USDC balance (raw 6-decimal units). null until the Railgun sync completes. */
export const shieldedUsdcAtom = atom<bigint | null>(null)

/** Shielded yield shares (raw 18-decimal units). null until sync. */
export const yieldSharesAtom = atom<bigint | null>(null)

/**
 * Absolute timestamp (ms since epoch) at which the shielded wallet will auto-lock if no further
 * user activity occurs. Null when no lock timer is armed (wallet missing or already locked).
 * Written by `useAutoLock` on each arming/reset; read by Settings for the live countdown.
 */
export const autoLockDeadlineAtom = atom<number | null>(null)

/**
 * Shielded balance sync state. Reflects the Railgun engine's UTXO merkletree scan progress.
 *
 *   idle      — no scan has been triggered yet (engine not running, or no wallet unlocked)
 *   syncing   — a scan is in progress; `progress` runs 0..1
 *   complete  — most recent scan finished successfully
 *   failed    — the scan reported MerkletreeScanStatus.Incomplete (RPC failures, etc.)
 *
 * Written by the SDK's setOnUTXOMerkletreeScanCallback handler in lib/railgun/init.ts and
 * consumed by the SyncBanner UI + per-modal "block submit while sync is incomplete" gates.
 */
export interface SyncState {
  readonly status: 'idle' | 'syncing' | 'complete' | 'failed'
  readonly progress: number
}

export const syncStateAtom = atom<SyncState>({ status: 'idle', progress: 0 })

/**
 * Bumped to re-trigger the initial shielded-balance scan after a failure (the "Try Again" action).
 * `useShieldedBalanceSync` includes this in its effect deps, so incrementing it tears down the
 * current subscription and re-runs `refreshShieldedBalances`. Driven by `useSyncRetry`.
 */
export const syncRetryEpochAtom = atom<number>(0)
