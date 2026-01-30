/**
 * Shielded Wallet Atom
 *
 * Manages the shielded wallet state using Jotai atoms.
 * Supports both USDC and ayUSDC (yield-bearing) balances.
 */

import { atom } from 'jotai'

// ============ Types ============

export type ShieldedWalletStatus =
  | 'disconnected'
  | 'connected'
  | 'unlocking'
  | 'unlocked'

export interface ShieldedWalletState {
  /** Current wallet status */
  status: ShieldedWalletStatus
  /** Railgun address (0zk...) when unlocked */
  railgunAddress: string | null
  /** Shielded USDC balance in base units (raw USDC not in yield) */
  shieldedBalance: bigint
  /** Shielded ayUSDC shares in base units (yield-bearing position) */
  yieldSharesBalance: bigint
  /** USDC equivalent of ayUSDC shares (after conversion) */
  yieldAssetsBalance: bigint
  /** Whether balance is currently being scanned */
  isScanning: boolean
  /** Error message if any */
  error: string | null
}

// ============ Atoms ============

/**
 * Main shielded wallet state atom
 */
export const shieldedWalletAtom = atom<ShieldedWalletState>({
  status: 'disconnected',
  railgunAddress: null,
  shieldedBalance: 0n,
  yieldSharesBalance: 0n,
  yieldAssetsBalance: 0n,
  isScanning: false,
  error: null,
})

/**
 * Derived atom for checking if wallet is unlocked
 */
export const isShieldedWalletUnlockedAtom = atom(
  (get) => get(shieldedWalletAtom).status === 'unlocked',
)

/**
 * Derived atom for total balance (USDC + yield assets) formatted as string
 */
export const formattedShieldedBalanceAtom = atom((get) => {
  const state = get(shieldedWalletAtom)
  // Total = raw USDC + USDC equivalent of yield position
  const totalBalance = state.shieldedBalance + state.yieldAssetsBalance
  const divisor = 1_000_000n
  const whole = totalBalance / divisor
  const fraction = totalBalance % divisor
  const fractionStr = fraction.toString().padStart(6, '0')
  return `${whole}.${fractionStr.slice(0, 2)}`
})

/**
 * Derived atom for raw USDC balance formatted as string
 */
export const formattedUsdcBalanceAtom = atom((get) => {
  const balance = get(shieldedWalletAtom).shieldedBalance
  const divisor = 1_000_000n
  const whole = balance / divisor
  const fraction = balance % divisor
  const fractionStr = fraction.toString().padStart(6, '0')
  return `${whole}.${fractionStr.slice(0, 2)}`
})

/**
 * Derived atom for yield assets (USDC equivalent) formatted as string
 */
export const formattedYieldAssetsAtom = atom((get) => {
  const balance = get(shieldedWalletAtom).yieldAssetsBalance
  const divisor = 1_000_000n
  const whole = balance / divisor
  const fraction = balance % divisor
  const fractionStr = fraction.toString().padStart(6, '0')
  return `${whole}.${fractionStr.slice(0, 2)}`
})

/**
 * Derived atom for yield shares (ayUSDC) formatted as string
 */
export const formattedYieldSharesAtom = atom((get) => {
  const balance = get(shieldedWalletAtom).yieldSharesBalance
  const divisor = 1_000_000n
  const whole = balance / divisor
  const fraction = balance % divisor
  const fractionStr = fraction.toString().padStart(6, '0')
  return `${whole}.${fractionStr.slice(0, 2)}`
})

/**
 * Derived atom for whether user has any yield position
 */
export const hasYieldPositionAtom = atom((get) => {
  return get(shieldedWalletAtom).yieldSharesBalance > 0n
})

/**
 * Derived atom for yield earned (assets - shares, representing profit)
 * Note: This is approximate since shares and assets have different meanings
 */
export const yieldEarnedAtom = atom((get) => {
  const state = get(shieldedWalletAtom)
  // Yield earned = current USDC value - original share amount
  // (shares were 1:1 with USDC at deposit time)
  if (state.yieldAssetsBalance > state.yieldSharesBalance) {
    return state.yieldAssetsBalance - state.yieldSharesBalance
  }
  return 0n
})
