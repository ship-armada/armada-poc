import { useState, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { ArrowDownLeft, X, ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { ChainSelect } from '@/components/common/ChainSelect'
import { DepositAmountInput } from '@/components/deposit/DepositAmountInput'
import { walletAtom } from '@/atoms/walletAtom'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { useShieldTransaction } from '@/hooks/useShieldTransaction'
import { useShieldFeeEstimate } from '@/hooks/useShieldFeeEstimate'
import { getPublicUsdcBalance } from '@/services/shield'
import { formatUSDC } from '@/lib/sdk'

interface DepositPanelProps {
  onClose: () => void
}

export function DepositPanel({ onClose }: DepositPanelProps) {
  const [selectedChain, setSelectedChain] = useState('hub')
  const [amount, setAmount] = useState('')
  const [publicBalance, setPublicBalance] = useState<bigint>(0n)
  const [isLoadingBalance, setIsLoadingBalance] = useState(false)
  const [balanceError, setBalanceError] = useState<string | null>(null)

  // Wallet state
  const walletState = useAtomValue(walletAtom)
  const evmAddress = walletState.metaMask.account
  const isConnected = walletState.metaMask.isConnected

  // Shielded wallet state
  const { isUnlocked, railgunAddress } = useShieldedWallet()

  // Shield transaction hook
  const { submitShield, isSubmitting, stageMessage, error: txError } = useShieldTransaction()

  // Fee estimation
  const { feeInfo, isLoading: isEstimatingFee } = useShieldFeeEstimate(
    evmAddress,
    amount,
  )

  // Fetch public USDC balance for the selected chain
  useEffect(() => {
    if (!evmAddress) {
      setPublicBalance(0n)
      return
    }

    let cancelled = false

    async function fetchBalance() {
      setIsLoadingBalance(true)
      setBalanceError(null)

      try {
        // Pass the selected chain to fetch balance from that chain
        const balance = await getPublicUsdcBalance(evmAddress!, selectedChain)
        if (!cancelled) {
          setPublicBalance(balance)
        }
      } catch (err) {
        console.error(`[deposit-panel] Failed to fetch balance on ${selectedChain}:`, err)
        if (!cancelled) {
          setBalanceError('Failed to fetch balance')
        }
      } finally {
        if (!cancelled) {
          setIsLoadingBalance(false)
        }
      }
    }

    fetchBalance()

    return () => {
      cancelled = true
    }
  }, [evmAddress, selectedChain]) // Re-fetch when chain changes

  // Format balance for display
  const availableBalance = isLoadingBalance
    ? '...'
    : balanceError
      ? '--'
      : formatUSDC(publicBalance)

  // Fee display
  const estimatedFee = isEstimatingFee
    ? 'Estimating...'
    : feeInfo
      ? feeInfo.totalNative
      : '--'

  // Validation
  const amountNum = parseFloat(amount || '0')
  const amountValid = amount.trim() !== '' && amountNum > 0

  // Check if wallet is connected and unlocked
  const canDeposit = isConnected && isUnlocked && railgunAddress

  // Check if amount exceeds balance
  const amountRaw = amountValid ? BigInt(Math.floor(amountNum * 1_000_000)) : 0n
  const exceedsBalance = amountRaw > publicBalance && publicBalance > 0n

  // Overall validity
  const isValid = canDeposit && amountValid && !exceedsBalance && !isSubmitting

  // Validation error message
  const validationError = !isConnected
    ? 'Connect wallet first'
    : !isUnlocked
      ? 'Unlock shielded wallet first'
      : !amount.trim()
        ? 'Please enter an amount'
        : amountNum <= 0
          ? 'Amount must be greater than 0'
          : exceedsBalance
            ? 'Insufficient balance'
            : null

  // Calculate total (amount + fee)
  const total = amountNum > 0 ? `$${amountNum.toFixed(2)}` : '$0.00'

  // Display amount for action bar
  const displayAmount = amount.trim() !== '' ? `${amount} USDC` : '0 USDC'

  // Handle deposit
  const handleDeposit = async () => {
    if (!isValid) return

    await submitShield({
      amount,
      chainKey: selectedChain,
      onSuccess: (details) => {
        console.log('[deposit-panel] Shield successful:', details)
        // Reset form
        setAmount('')
        // Refresh balance on the selected chain
        if (evmAddress) {
          getPublicUsdcBalance(evmAddress, selectedChain).then(setPublicBalance).catch(console.error)
        }
      },
      onError: (err) => {
        console.error('[deposit-panel] Shield failed:', err)
      },
    })
  }

  // Determine button text based on state
  const getButtonContent = () => {
    if (isSubmitting) {
      return (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="ml-2">{stageMessage || 'Processing...'}</span>
        </>
      )
    }
    return (
      <>
        Continue
        <ArrowRight className="h-4 w-4 ml-2" />
      </>
    )
  }

  return (
    <div className="card bg-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ArrowDownLeft className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Deposit USDC</h2>
        </div>
        <button
          onClick={onClose}
          className="p-2 hover:bg-muted rounded-md transition-colors"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      <p className="text-sm text-muted-foreground mb-6">
        Shield USDC cross-chain into the private pool
      </p>

      <div className="space-y-4">
        {/* Chain Selector */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">
            From Chain
          </label>
          <ChainSelect
            value={selectedChain}
            onChange={setSelectedChain}
            showEstimatedTime={true}
            timeType="deposit"
          />
        </div>

        {/* Amount Input */}
        <DepositAmountInput
          amount={amount}
          onAmountChange={setAmount}
          availableBalance={availableBalance}
          hasEvmError={!!balanceError}
          validationError={exceedsBalance ? 'Insufficient balance' : null}
          feeInfo={null}
        />

        {/* Network Fee Section */}
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Network fee</span>
            {isEstimatingFee ? (
              <div className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Estimating...</span>
              </div>
            ) : (
              <span className="text-sm font-medium">{estimatedFee}</span>
            )}
          </div>
          {feeInfo?.approvalNeeded && (
            <div className="text-xs text-muted-foreground">
              Includes approval transaction
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm font-semibold">Total</span>
            <span className="text-base font-bold">{total}</span>
          </div>
        </div>

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
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground">Deposit now</span>
              </div>
              {!isValid && validationError && !isSubmitting && (
                <p className="text-xs text-warning ml-6">{validationError}</p>
              )}
            </div>
            <div className="flex items-center justify-between sm:justify-end gap-4">
              <span className="text-sm font-medium text-muted-foreground">{displayAmount}</span>
              <Button
                variant="primary"
                onClick={handleDeposit}
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
