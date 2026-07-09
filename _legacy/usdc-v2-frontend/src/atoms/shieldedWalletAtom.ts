/**
 * Shielded Wallet Atom
 *
 * Manages the shielded wallet state using Jotai atoms.
 * Supports both USDC and ayUSDC (yield-bearing) balances.
 *
 * Yield display uses a separate exchange rate atom that's updated
 * by useYieldRate hook for real-time yield tracking.
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
  /** USDC equivalent of ayUSDC shares (after conversion) - updated by SDK events */
  yieldAssetsBalance: bigint
  /** Whether balance is currently being scanned */
  isScanning: boolean
  /** Error message if any */
  error: string | null
}

export interface YieldRateState {
  /** Exchange rate: assets per share, scaled by 1e6 (1_000_000 = 1:1) */
  exchangeRate: bigint
  /** Last time the rate was updated */
  lastUpdated: Date | null
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
 * Yield exchange rate atom - updated by useYieldRate hook
 * This enables real-time yield display without waiting for SDK events
 */
export const yieldRateAtom = atom<YieldRateState>({
  exchangeRate: 1_000_000n, // 1:1 default
  lastUpdated: null,
})

/**
 * Derived atom for checking if wallet is unlocked
 */
export const isShieldedWalletUnlockedAtom = atom(
  (get) => get(shieldedWalletAtom).status === 'unlocked',
)

/**
 * Helper function to compute yield assets from shares and rate
 */
function computeYieldAssets(shares: bigint, exchangeRate: bigint): bigint {
  if (shares === 0n) return 0n
  // assets = (shares * rate) / 1e6
  return (shares * exchangeRate) / 1_000_000n
}

/**
 * Derived atom for real-time yield assets (uses exchange rate atom)
 */
export const realTimeYieldAssetsAtom = atom((get) => {
  const state = get(shieldedWalletAtom)
  const rateState = get(yieldRateAtom)
  return computeYieldAssets(state.yieldSharesBalance, rateState.exchangeRate)
})

/**
 * Derived atom for total balance (USDC + yield assets) formatted as string
 * Uses real-time exchange rate for accurate yield display
 */
export const formattedShieldedBalanceAtom = atom((get) => {
  const state = get(shieldedWalletAtom)
  const yieldAssets = get(realTimeYieldAssetsAtom)
  // Total = raw USDC + USDC equivalent of yield position (real-time)
  const totalBalance = state.shieldedBalance + yieldAssets
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
 * Uses real-time exchange rate for accurate yield display
 */
export const formattedYieldAssetsAtom = atom((get) => {
  const balance = get(realTimeYieldAssetsAtom)
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
 * Uses real-time exchange rate for accurate profit display
 */
export const yieldEarnedAtom = atom((get) => {
  const state = get(shieldedWalletAtom)
  const yieldAssets = get(realTimeYieldAssetsAtom)
  // Yield earned = current USDC value - original share amount
  // (shares were 1:1 with USDC at deposit time)
  if (yieldAssets > state.yieldSharesBalance) {
    return yieldAssets - state.yieldSharesBalance
  }
  return 0n
})
