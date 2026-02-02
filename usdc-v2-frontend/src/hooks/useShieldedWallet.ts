/**
 * Shielded Wallet Hook
 *
 * Manages the shielded wallet state using Jotai atoms.
 * Provides methods for unlocking, locking, and refreshing balances.
 * Supports both USDC and ayUSDC (yield-bearing) balances.
 */

import { useCallback, useEffect } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { getAddress, ethers } from 'ethers'
import {
  shieldedWalletAtom,
  isShieldedWalletUnlockedAtom,
  formattedShieldedBalanceAtom,
  formattedUsdcBalanceAtom,
  formattedYieldAssetsAtom,
  formattedYieldSharesAtom,
  hasYieldPositionAtom,
  yieldEarnedAtom,
  realTimeYieldAssetsAtom,
  type ShieldedWalletState,
} from '@/atoms/shieldedWalletAtom'
import { walletAtom } from '@/atoms/walletAtom'
import {
  constructDerivationMessage,
  signatureToMnemonic,
  signatureToEncryptionKey,
} from '@/lib/keyDerivation'
import {
  setKeys,
  clearKeys,
  isUnlocked as checkIsUnlocked,
  getWalletId,
  getEncryptionKey,
  setOnLockCallback,
  removeOnLockCallback,
} from '@/lib/keyManager'
import {
  generateRailgunAddressAsync,
  getShieldedBalance,
  refreshWalletBalances,
  onBalanceUpdate,
} from '@/lib/sdk'
import { isRailgunInitialized, initRailgun } from '@/lib/railgun'
import { loadDeployments, getHubChain, getYieldDeployment } from '@/config/deployments'

// ABI for vault's convertToAssets function
const VAULT_ABI = ['function convertToAssets(uint256 shares) view returns (uint256)']

// ============ Types ============

export interface UseShieldedWalletReturn {
  /** Current wallet status */
  status: ShieldedWalletState['status']
  /** Railgun address (0zk...) when unlocked */
  railgunAddress: string | null
  /** Total shielded balance in base units (USDC + yield assets) */
  shieldedBalance: bigint
  /** Raw USDC balance (not in yield) */
  usdcBalance: bigint
  /** ayUSDC shares balance */
  yieldSharesBalance: bigint
  /** USDC equivalent of ayUSDC shares */
  yieldAssetsBalance: bigint
  /** Yield earned (assets - shares) */
  yieldEarned: bigint
  /** Whether user has any yield position */
  hasYieldPosition: boolean
  /** Formatted total balance for display */
  formattedBalance: string
  /** Formatted raw USDC balance */
  formattedUsdcBalance: string
  /** Formatted yield assets (USDC equivalent) */
  formattedYieldAssets: string
  /** Formatted yield shares (ayUSDC) */
  formattedYieldShares: string
  /** Whether balance is currently being scanned */
  isScanning: boolean
  /** Error message if any */
  error: string | null
  /** Whether wallet is unlocked */
  isUnlocked: boolean
  /** Wallet ID when unlocked */
  walletId: string | null
  /** Encryption key when unlocked */
  encryptionKey: string | null
  /** Unlock the shielded wallet by signing a message */
  unlock: () => Promise<void>
  /** Lock the shielded wallet (clear keys) */
  lock: () => void
  /** Refresh the shielded balance */
  refreshBalance: () => Promise<void>
}

// ============ Helper Functions ============

/**
 * Convert ayUSDC shares to USDC equivalent using the vault contract
 */
async function convertSharesToAssets(
  vaultAddress: string,
  shares: bigint,
): Promise<bigint> {
  if (shares === 0n) return 0n

  try {
    const provider = new ethers.JsonRpcProvider('http://localhost:8545')
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider)
    const assets = await vault.convertToAssets(shares)
    return assets
  } catch (error) {
    console.warn('[shielded-wallet] Failed to convert shares to assets:', error)
    // Fall back to 1:1 ratio if conversion fails
    return shares
  }
}

// ============ Hook ============

export function useShieldedWallet(): UseShieldedWalletReturn {
  const [state, setState] = useAtom(shieldedWalletAtom)
  const walletState = useAtomValue(walletAtom)
  const isUnlocked = useAtomValue(isShieldedWalletUnlockedAtom)
  const formattedBalance = useAtomValue(formattedShieldedBalanceAtom)
  const formattedUsdcBalance = useAtomValue(formattedUsdcBalanceAtom)
  const formattedYieldAssets = useAtomValue(formattedYieldAssetsAtom)
  const formattedYieldShares = useAtomValue(formattedYieldSharesAtom)
  const hasYieldPosition = useAtomValue(hasYieldPositionAtom)
  const yieldEarned = useAtomValue(yieldEarnedAtom)
  const realTimeYieldAssets = useAtomValue(realTimeYieldAssetsAtom)

  const isConnected = walletState.metaMask.isConnected
  const address = walletState.metaMask.account

  // Update status when connection changes
  useEffect(() => {
    if (!isConnected) {
      // Clear keys when disconnected
      clearKeys()
      setState({
        status: 'disconnected',
        railgunAddress: null,
        shieldedBalance: 0n,
        yieldSharesBalance: 0n,
        yieldAssetsBalance: 0n,
        isScanning: false,
        error: null,
      })
    } else if (state.status === 'disconnected') {
      // Connected but not unlocked
      setState((prev) => ({
        ...prev,
        status: 'connected',
        error: null,
      }))
    }
  }, [isConnected, state.status, setState])

  // Handle auto-lock callback
  useEffect(() => {
    setOnLockCallback(() => {
      setState((prev) => ({
        ...prev,
        status: isConnected ? 'connected' : 'disconnected',
        railgunAddress: null,
        shieldedBalance: 0n,
        yieldSharesBalance: 0n,
        yieldAssetsBalance: 0n,
        error: null,
      }))
    })

    return () => {
      removeOnLockCallback()
    }
  }, [isConnected, setState])

  // Unlock wallet by signing message
  const unlock = useCallback(async () => {
    if (!address) {
      throw new Error('No wallet connected')
    }

    setState((prev) => ({ ...prev, status: 'unlocking', error: null }))

    try {
      // Ensure Railgun SDK is initialized first
      if (!isRailgunInitialized()) {
        console.log('[shielded-wallet] Initializing Railgun SDK...')
        await initRailgun()
      }

      // Use checksummed address for consistent message across apps
      const checksummedAddress = getAddress(address)

      // Construct and sign the derivation message
      const message = constructDerivationMessage(checksummedAddress)

      // Sign using window.ethereum
      if (!window.ethereum) {
        throw new Error('MetaMask not available')
      }

      const signature = await window.ethereum.request({
        method: 'personal_sign',
        params: [message, checksummedAddress],
      })

      if (typeof signature !== 'string') {
        throw new Error('Invalid signature')
      }

      // Debug: log signature for comparison with demo-app
      console.log('[shielded-wallet] DEBUG - Message:', message)
      console.log('[shielded-wallet] DEBUG - Signature:', signature)

      // Derive mnemonic and encryption key from signature
      const mnemonic = signatureToMnemonic(signature)
      const encryptionKey = signatureToEncryptionKey(signature)

      // Debug: log first word of mnemonic (safe to log)
      console.log('[shielded-wallet] DEBUG - Mnemonic first word:', mnemonic.split(' ')[0])

      // Generate Railgun address and wallet ID using SDK (async)
      console.log('[shielded-wallet] Creating Railgun wallet...')
      const { walletId, railgunAddress } = await generateRailgunAddressAsync(
        mnemonic,
        encryptionKey,
      )

      // Store keys in key manager
      setKeys(mnemonic, encryptionKey, walletId, railgunAddress)

      // Update state
      setState((prev) => ({
        ...prev,
        status: 'unlocked',
        railgunAddress,
        error: null,
      }))

      console.log(
        '[shielded-wallet] Shielded wallet unlocked:',
        railgunAddress.slice(0, 20) + '...',
      )
    } catch (error) {
      console.error('[shielded-wallet] Failed to unlock wallet:', error)
      setState((prev) => ({
        ...prev,
        status: 'connected',
        error:
          error instanceof Error ? error.message : 'Failed to unlock wallet',
      }))
      throw error
    }
  }, [address, setState])

  // Lock wallet (clear keys)
  const lock = useCallback(() => {
    clearKeys()
    setState((prev) => ({
      ...prev,
      status: isConnected ? 'connected' : 'disconnected',
      railgunAddress: null,
      shieldedBalance: 0n,
      yieldSharesBalance: 0n,
      yieldAssetsBalance: 0n,
      error: null,
    }))
  }, [isConnected, setState])

  // Refresh shielded balance (both USDC and ayUSDC)
  const refreshBalance = useCallback(async () => {
    if (!checkIsUnlocked()) return

    setState((prev) => ({ ...prev, isScanning: true }))

    try {
      // Ensure deployments are loaded to get token addresses
      await loadDeployments()
      const hubChain = getHubChain()
      const yieldDeployment = getYieldDeployment()
      const usdcAddress = hubChain.contracts?.mockUSDC
      const vaultAddress = yieldDeployment?.contracts?.armadaYieldVault

      if (!usdcAddress) {
        console.warn(
          '[shielded-wallet] No MockUSDC address available for hub chain',
        )
        setState((prev) => ({ ...prev, isScanning: false }))
        return
      }

      // Re-check unlock state in case wallet was locked during async operations
      if (!checkIsUnlocked()) {
        setState((prev) => ({ ...prev, isScanning: false }))
        return
      }

      const walletId = getWalletId()

      // First trigger a balance scan/refresh
      await refreshWalletBalances(walletId)

      // Get USDC balance
      const usdcBalance = await getShieldedBalance(walletId, usdcAddress)
      console.log('[shielded-wallet] USDC balance:', usdcBalance.toString())

      // Get ayUSDC balance if vault is deployed
      let yieldSharesBalance = 0n
      let yieldAssetsBalance = 0n

      if (vaultAddress) {
        yieldSharesBalance = await getShieldedBalance(walletId, vaultAddress)
        console.log('[shielded-wallet] ayUSDC shares:', yieldSharesBalance.toString())

        // Convert shares to USDC equivalent
        if (yieldSharesBalance > 0n) {
          yieldAssetsBalance = await convertSharesToAssets(vaultAddress, yieldSharesBalance)
          console.log('[shielded-wallet] ayUSDC assets (USDC):', yieldAssetsBalance.toString())
        }
      }

      setState((prev) => ({
        ...prev,
        shieldedBalance: usdcBalance,
        yieldSharesBalance,
        yieldAssetsBalance,
        isScanning: false,
      }))
    } catch (error) {
      console.error('[shielded-wallet] Failed to refresh balance:', error)
      setState((prev) => ({ ...prev, isScanning: false }))
    }
  }, [setState])

  // Subscribe to balance update events
  useEffect(() => {
    if (state.status !== 'unlocked') return

    const unsubscribe = onBalanceUpdate(async (event) => {
      console.log('[shielded-wallet] Balance update received:', event)

      // Get balances directly without triggering another scan
      try {
        await loadDeployments()
        const hubChain = getHubChain()
        const yieldDeployment = getYieldDeployment()
        const usdcAddress = hubChain.contracts?.mockUSDC
        const vaultAddress = yieldDeployment?.contracts?.armadaYieldVault

        if (usdcAddress && checkIsUnlocked()) {
          const walletId = getWalletId()

          // Get USDC balance
          const usdcBalance = await getShieldedBalance(walletId, usdcAddress)

          // Get ayUSDC balance if vault is deployed
          let yieldSharesBalance = 0n
          let yieldAssetsBalance = 0n

          if (vaultAddress) {
            yieldSharesBalance = await getShieldedBalance(walletId, vaultAddress)
            if (yieldSharesBalance > 0n) {
              yieldAssetsBalance = await convertSharesToAssets(vaultAddress, yieldSharesBalance)
            }
          }

          setState((prev) => ({
            ...prev,
            shieldedBalance: usdcBalance,
            yieldSharesBalance,
            yieldAssetsBalance,
          }))
        }
      } catch (error) {
        console.error(
          '[shielded-wallet] Failed to update balance from event:',
          error,
        )
      }
    })

    return () => unsubscribe()
  }, [state.status, setState])

  // Auto-refresh balance when unlocked
  useEffect(() => {
    if (state.status === 'unlocked' && checkIsUnlocked()) {
      refreshBalance()
    }
  }, [state.status, refreshBalance])

  // Get wallet credentials from keyManager when unlocked
  // Check both React state AND keyManager state to handle race conditions during auto-lock
  const walletId = state.status === 'unlocked' && checkIsUnlocked() ? getWalletId() : null
  const encryptionKey = state.status === 'unlocked' && checkIsUnlocked() ? getEncryptionKey() : null

  // Calculate total balance using real-time yield assets (updated by useYieldRate)
  const totalBalance = state.shieldedBalance + realTimeYieldAssets

  return {
    status: state.status,
    railgunAddress: state.railgunAddress,
    shieldedBalance: totalBalance,
    usdcBalance: state.shieldedBalance,
    yieldSharesBalance: state.yieldSharesBalance,
    yieldAssetsBalance: realTimeYieldAssets, // Use real-time value
    yieldEarned,
    hasYieldPosition,
    formattedBalance,
    formattedUsdcBalance,
    formattedYieldAssets,
    formattedYieldShares,
    isScanning: state.isScanning,
    error: state.error,
    isUnlocked,
    walletId,
    encryptionKey,
    unlock,
    lock,
    refreshBalance,
  }
}
