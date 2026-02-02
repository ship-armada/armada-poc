import { useState, useEffect } from 'react'
import { TrendingUp, X, ArrowRight, Loader2, Percent, ArrowDownUp, Wallet, Shield } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { usePublicYieldBalance } from '@/hooks/usePublicYieldBalance'
import { useYieldTransaction } from '@/hooks/useYieldTransaction'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { useShieldedYieldTransaction } from '@/hooks/useShieldedYieldTransaction'
import { previewLend, previewRedeem, getCurrentAPY } from '@/services/yield'
import { useAtomValue } from 'jotai'
import { walletAtom } from '@/atoms/walletAtom'

interface EarnPanelProps {
  onClose: () => void
}

type EarnMode = 'lend' | 'redeem'
type WalletMode = 'public' | 'shielded'

export function EarnPanel({ onClose }: EarnPanelProps) {
  const [mode, setMode] = useState<EarnMode>('lend')
  const [walletMode, setWalletMode] = useState<WalletMode>('public')
  const [amount, setAmount] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [currentAPY, setCurrentAPY] = useState<number | null>(null)

  // Check wallet connection
  const walletState = useAtomValue(walletAtom)
  const isConnected = walletState.metaMask.isConnected

  // Shielded wallet state
  const {
    isUnlocked: isShieldedUnlocked,
    usdcBalance: shieldedUsdcBalance,
    yieldSharesBalance: shieldedSharesBalance,
    formattedUsdcBalance: formattedShieldedUsdc,
    formattedYieldShares: formattedShieldedShares,
    formattedYieldAssets: formattedShieldedYieldAssets,
    hasYieldPosition: hasShieldedYieldPosition,
    isScanning: isShieldedScanning,
    refreshBalance: refreshShieldedBalance,
  } = useShieldedWallet()

  // Fetch current APY on mount
  useEffect(() => {
    getCurrentAPY()
      .then(setCurrentAPY)
      .catch((err) => console.error('[earn-panel] Failed to fetch APY:', err))
  }, [])

  // Public wallet hooks
  const {
    formattedUsdc: formattedPublicUsdc,
    formattedAyUsdcShares: formattedPublicShares,
    formattedAyUsdcAssets: formattedPublicYieldAssets,
    hasYieldPosition: hasPublicYieldPosition,
    isLoading: isPublicLoading,
    usdcBalance: publicUsdcBalance,
    ayUsdcShares: publicSharesBalance,
    refresh: refreshPublicBalances,
  } = usePublicYieldBalance()

  // Public transaction hook
  const {
    submitLend: submitPublicLend,
    submitRedeem: submitPublicRedeem,
    isSubmitting: isPublicSubmitting,
    stageMessage: publicStageMessage,
    error: publicTxError,
  } = useYieldTransaction()

  // Shielded transaction hook
  const {
    submitShieldedLend,
    submitShieldedRedeem,
    isSubmitting: isShieldedSubmitting,
    stageMessage: shieldedStageMessage,
    proofProgress,
    error: shieldedTxError,
  } = useShieldedYieldTransaction()

  // Derived state based on wallet mode
  const isShieldedMode = walletMode === 'shielded'
  const isSubmitting = isShieldedMode ? isShieldedSubmitting : isPublicSubmitting
  const stageMessage = isShieldedMode ? shieldedStageMessage : publicStageMessage
  const txError = isShieldedMode ? shieldedTxError : publicTxError

  // Balance based on mode
  const availableBalance =
    mode === 'lend'
      ? isShieldedMode
        ? formattedShieldedUsdc
        : formattedPublicUsdc
      : isShieldedMode
        ? formattedShieldedShares
        : formattedPublicShares

  const availableRaw =
    mode === 'lend'
      ? isShieldedMode
        ? shieldedUsdcBalance
        : publicUsdcBalance
      : isShieldedMode
        ? shieldedSharesBalance
        : publicSharesBalance

  const hasYieldPosition = isShieldedMode ? hasShieldedYieldPosition : hasPublicYieldPosition
  const isLoading = isShieldedMode ? isShieldedScanning : isPublicLoading
  const formattedYieldAssets = isShieldedMode ? formattedShieldedYieldAssets : formattedPublicYieldAssets
  const formattedYieldShares = isShieldedMode ? formattedShieldedShares : formattedPublicShares

  // Preview calculation with debounce
  useEffect(() => {
    if (!amount || parseFloat(amount) <= 0) {
      setPreview(null)
      return
    }

    const timer = setTimeout(async () => {
      setIsLoadingPreview(true)
      try {
        if (mode === 'lend') {
          const shares = await previewLend(amount)
          setPreview(shares)
        } else {
          const assets = await previewRedeem(amount)
          setPreview(assets)
        }
      } catch (err) {
        console.error('[earn-panel] Preview failed:', err)
        setPreview(null)
      } finally {
        setIsLoadingPreview(false)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [amount, mode])

  // Validation
  const isValidAmount = amount.trim() !== '' && parseFloat(amount) > 0
  const amountRaw = isValidAmount ? BigInt(Math.floor(parseFloat(amount) * 1_000_000)) : 0n
  const exceedsBalance = amountRaw > availableRaw && availableRaw > 0n

  // Overall validity
  const walletReady = isShieldedMode ? isShieldedUnlocked : isConnected
  const isValid = walletReady && isValidAmount && !exceedsBalance && !isSubmitting

  // Validation error message
  const validationError = isShieldedMode
    ? !isShieldedUnlocked
      ? 'Unlock shielded wallet first'
      : !amount.trim()
        ? `Enter amount to ${mode}`
        : parseFloat(amount) <= 0
          ? 'Amount must be greater than 0'
          : exceedsBalance
            ? 'Insufficient shielded balance'
            : null
    : !isConnected
      ? 'Connect wallet first'
      : !amount.trim()
        ? `Enter amount to ${mode}`
        : parseFloat(amount) <= 0
          ? 'Amount must be greater than 0'
          : exceedsBalance
            ? 'Insufficient balance'
            : null

  const handleSubmit = async () => {
    if (!isValid) return

    if (isShieldedMode) {
      // Shielded operations
      if (mode === 'lend') {
        await submitShieldedLend({
          amount,
          onSuccess: () => {
            setAmount('')
            setPreview(null)
            refreshShieldedBalance()
          },
        })
      } else {
        await submitShieldedRedeem({
          shares: amount,
          onSuccess: () => {
            setAmount('')
            setPreview(null)
            refreshShieldedBalance()
          },
        })
      }
    } else {
      // Public operations
      if (mode === 'lend') {
        await submitPublicLend({
          amount,
          onSuccess: () => {
            setAmount('')
            setPreview(null)
            refreshPublicBalances()
          },
        })
      } else {
        await submitPublicRedeem({
          shares: amount,
          onSuccess: () => {
            setAmount('')
            setPreview(null)
            refreshPublicBalances()
          },
        })
      }
    }
  }

  const handleMaxClick = () => {
    setAmount(availableBalance)
  }

  // Button content based on state
  const getButtonContent = () => {
    if (isSubmitting) {
      return (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="ml-2">
            {stageMessage ||
              (isShieldedMode && proofProgress !== null
                ? `Proving ${Math.round(proofProgress * 100)}%`
                : 'Processing...')}
          </span>
        </>
      )
    }
    return (
      <>
        {mode === 'lend' ? 'Deposit to Earn' : 'Withdraw'}
        <ArrowRight className="h-4 w-4 ml-2" />
      </>
    )
  }

  return (
    <div className="card bg-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Earn Yield</h2>
        </div>
        <button
          onClick={onClose}
          className="p-2 hover:bg-muted rounded-md transition-colors"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      <p className="text-sm text-muted-foreground mb-6">
        Deposit USDC to earn yield via the Armada Yield Vault.
        {currentAPY !== null && ` Funds earn ~${currentAPY.toLocaleString()}% APY.`}
      </p>

      <div className="space-y-4">
        {/* Wallet Mode Toggle */}
        <div className="flex gap-2 p-1 bg-muted/50 rounded-lg">
          <button
            onClick={() => {
              setWalletMode('public')
              setAmount('')
              setPreview(null)
            }}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
              walletMode === 'public'
                ? 'bg-card text-foreground border border-border'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Wallet className="h-4 w-4" />
            Public Wallet
          </button>
          <button
            onClick={() => {
              setWalletMode('shielded')
              setAmount('')
              setPreview(null)
            }}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
              walletMode === 'shielded'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            disabled={!isShieldedUnlocked}
            title={!isShieldedUnlocked ? 'Unlock shielded wallet first' : undefined}
          >
            <Shield className="h-4 w-4" />
            Shielded
          </button>
        </div>

        {/* Info Box - explain the mode */}
        <div
          className={`p-3 border rounded-lg ${
            isShieldedMode
              ? 'bg-primary/10 border-primary/20'
              : 'bg-info/10 border-info/20'
          }`}
        >
          <div className="flex items-center gap-2">
            {isShieldedMode ? (
              <Shield className="h-4 w-4 text-primary" />
            ) : (
              <Wallet className="h-4 w-4 text-info-foreground" />
            )}
            <span
              className={`text-xs ${
                isShieldedMode ? 'text-primary' : 'text-info-foreground'
              }`}
            >
              {isShieldedMode
                ? 'Deposit/withdraw from your shielded balance with full privacy'
                : 'Deposit/withdraw from your public wallet balance'}
            </span>
          </div>
        </div>

        {/* APY Info Box */}
        <div className="p-3 bg-success/10 border border-success/20 rounded-lg">
          <div className="flex items-center gap-2">
            <Percent className="h-4 w-4 text-success" />
            <span className="text-sm font-medium text-success">
              {currentAPY !== null ? `~${currentAPY.toLocaleString()}% APY` : 'Loading APY...'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Yield is generated via Aave. 10% performance fee on profits.
          </p>
        </div>

        {/* Current Position (if any) */}
        {hasYieldPosition && (
          <div className="p-3 bg-muted/50 border border-border rounded-lg">
            <p className="text-xs text-muted-foreground mb-2">
              Your {isShieldedMode ? 'Shielded' : 'Public'} Yield Position
            </p>
            <div className="flex justify-between text-sm">
              <span>Deposited (ayUSDC):</span>
              <span className="font-mono">{formattedYieldShares}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>Current Value:</span>
              <span className="font-mono text-success">${formattedYieldAssets}</span>
            </div>
          </div>
        )}

        {/* Mode Toggle (Lend/Redeem) */}
        <div className="flex gap-2 p-1 bg-muted/50 rounded-lg">
          <button
            onClick={() => {
              setMode('lend')
              setAmount('')
              setPreview(null)
            }}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
              mode === 'lend'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Deposit
          </button>
          <button
            onClick={() => {
              setMode('redeem')
              setAmount('')
              setPreview(null)
            }}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
              mode === 'redeem'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            disabled={!hasYieldPosition}
          >
            Withdraw
          </button>
        </div>

        {/* Amount Input */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-muted-foreground">
              {mode === 'lend' ? 'USDC to deposit' : 'ayUSDC to withdraw'}
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Available: {isLoading ? '...' : availableBalance}
              </span>
              <button
                onClick={handleMaxClick}
                className="text-xs text-primary hover:underline"
                disabled={isSubmitting}
              >
                MAX
              </button>
            </div>
          </div>
          <div className="relative">
            <input
              type="text"
              value={amount}
              onChange={(e) => {
                // Only allow valid number input
                const val = e.target.value
                if (val === '' || /^\d*\.?\d*$/.test(val)) {
                  setAmount(val)
                }
              }}
              placeholder="0.00"
              className="w-full px-4 py-3 bg-background border border-input rounded-lg text-foreground font-mono text-lg focus:outline-none focus:ring-2 focus:ring-ring shadow-sm pr-20"
              disabled={isSubmitting}
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">
              {mode === 'lend' ? 'USDC' : 'ayUSDC'}
            </span>
          </div>
          {exceedsBalance && (
            <p className="text-xs text-destructive mt-1">Insufficient balance</p>
          )}
        </div>

        {/* Preview */}
        {isValidAmount && (
          <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
            <div className="flex items-center gap-2">
              <ArrowDownUp className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {mode === 'lend' ? 'You will receive' : 'You will get back'}
              </span>
            </div>
            {isLoadingPreview ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <span className="text-sm font-mono font-medium">
                ~{preview || '...'} {mode === 'lend' ? 'ayUSDC' : 'USDC'}
              </span>
            )}
          </div>
        )}

        {/* Proof Progress (shielded mode only) */}
        {isShieldedMode && isSubmitting && proofProgress !== null && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Generating ZK proof...</span>
              <span>{Math.round(proofProgress * 100)}%</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${proofProgress * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Transaction Error */}
        {txError && (
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
            <p className="text-xs text-destructive">{txError}</p>
          </div>
        )}

        {/* Action Section */}
        <div className="card bg-muted/30 rounded-full px-4 py-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground">
                  {mode === 'lend' ? 'Start earning' : 'Withdraw funds'}
                </span>
              </div>
              {!isValid && validationError && !isSubmitting && (
                <p className="text-xs text-warning ml-6">{validationError}</p>
              )}
            </div>
            <div className="flex items-center justify-between sm:justify-end gap-4">
              <span className="text-sm font-medium text-muted-foreground">
                {amount || '0'} {mode === 'lend' ? 'USDC' : 'ayUSDC'}
              </span>
              <Button
                variant="primary"
                onClick={handleSubmit}
                disabled={!isValid}
                className="rounded-full"
              >
                {getButtonContent()}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
