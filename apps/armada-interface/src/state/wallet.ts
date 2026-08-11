// ABOUTME: Jotai atoms for wallet state — EVM connection (mirrored from wagmi) + plural shielded wallets + shielded balance sync.
// ABOUTME: EVM state sourced from wagmi hooks. Plural-wallet schema is future-proofing per reviewer #5; v1 only ever populates one entry.

import { atom } from 'jotai'
import type { ShieldedWalletState } from '@/lib/railgun/wallet'

/** Truncated/raw EVM address of the connected wallet. null = not connected. */
export const evmAddressAtom = atom<string | null>(null)

/** Plural shielded wallets, keyed by shieldedWalletId. Schema is plural even in v1 (one entry). */
export const shieldedWalletsAtom = atom<Record<string, ShieldedWalletState>>({})

/** Which entry in `shieldedWalletsAtom` is currently active. Null when no wallet exists or none selected. */
export const activeShieldedWalletIdAtom = atom<string | null>(null)

/** Derived: the active wallet's state, or null. UI mostly reads this; write paths use the two source atoms above. */
export const activeShieldedWalletAtom = atom<ShieldedWalletState | null>((get) => {
  const id = get(activeShieldedWalletIdAtom)
  if (!id) return null
  return get(shieldedWalletsAtom)[id] ?? null
})

/**
 * Legacy alias retained until Bundle 2 consumers fully migrate to `activeShieldedWalletAtom`.
 * For now, returns a thin compat shape ({ status: 'missing' } when no wallet, else the active one).
 */
export const shieldedWalletAtom = atom<{ status: 'locked' | 'unlocked' | 'missing'; shieldedAddress?: string }>((get) => {
  const active = get(activeShieldedWalletAtom)
  if (!active) return { status: 'missing' }
  return { status: active.status, shieldedAddress: active.shieldedAddress }
})

/**
 * Unshielded USDC balance per chain id (raw 6-decimal units). Empty map until balances hook fetches.
 */
export const usdcBalancesAtom = atom<Record<number, bigint>>({})

/** Shielded USDC balance (raw 6-decimal units). null until the shielded sync completes. */
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
 * Shielded balance sync state. Reflects the @armada/sdk wallet's commitment-scan progress.
 *
 *   idle      — no scan has been triggered yet (no wallet unlocked)
 *   syncing   — a scan is in progress; `progress` runs 0..1
 *   complete  — most recent scan finished successfully
 *   failed    — the scan reported an error (RPC failures, etc.) or couldn't start
 *
 * Driven by the SDK wallet's scan events (scan:started/progress/complete/error), forwarded through
 * the scan-status bus (lib/railgun/balance-bus.ts) and written by `useShieldedBalanceSync`. Consumed
 * by the SyncBanner UI + per-modal "block submit while sync is incomplete" gates.
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

/**
 * Result of the on-chain nullifier cross-check (WI-5). Merkleroot validation guarantees the
 * rebuilt commitment tree matches the chain, but nullifiers live outside that tree — a watcher
 * that omits a `Nullified` event passes root validation yet shows an already-spent note as
 * unspent (inflated displayed balance). After each scan completes, `useNullifierCrossCheck`
 * queries the hub PrivacyPool's `nullifiers(...)` for the wallet's own locally-unspent notes:
 *
 *   'unknown'           — not yet checked (no scan completed, or wallet locked)
 *   'ok'                — every own unspent note is also unspent on-chain
 *   'omission-detected' — the chain marks an own "unspent" note as spent → the watcher omitted
 *                          its nullifier → the displayed balance is stale → block spending
 *
 * `useSpendableSyncGate` blocks spend flows on 'omission-detected'.
 */
export type NullifierCrossCheckStatus = 'unknown' | 'ok' | 'omission-detected'
export const nullifierCrossCheckAtom = atom<NullifierCrossCheckStatus>('unknown')
