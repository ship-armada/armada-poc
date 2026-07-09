import { useState, useEffect } from 'react'
import { Send, X, Shield, ArrowUpRight, ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { ChainSelect } from '@/components/common/ChainSelect'
import { SendPaymentAmountInput } from '@/components/payment/SendPaymentAmountInput'
import { RecipientAddressInput } from '@/components/recipient/RecipientAddressInput'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { useSendTransaction } from '@/hooks/useSendTransaction'
import { formatUSDC, parseUSDC } from '@/lib/sdk'
import { estimateSendFee, type SendFeeEstimate } from '@/services/send'

interface SendPanelProps {
  onClose: () => void
}

export function SendPanel({ onClose }: SendPanelProps) {
  const [recipient, setRecipient] = useState('')
  const [_recipientName, setRecipientName] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [selectedChain, setSelectedChain] = useState('hub')
  const [feeEstimate, setFeeEstimate] = useState<SendFeeEstimate | null>(null)
  const [isEstimatingFee, setIsEstimatingFee] = useState(false)

  // Hooks
  const { shieldedBalance, isScanning, isUnlocked } = useShieldedWallet()
  const {
    submitSend,
    isSubmitting,
    stage,
    stageMessage,
    proofProgress,
    error: txError,
  } = useSendTransaction()

  // Determine recipient type based on address prefix
  const recipientType = recipient.startsWith('0zk')
    ? 'railgun'
    : recipient.startsWith('0x') && recipient.length === 42
      ? 'ethereum'
      : null

  // Available balance from shielded wallet
  const availableBalance = isScanning ? '...' : formatUSDC(shieldedBalance)
  const isShieldedBalanceLoading = isScanning
  const hasBalanceError = false

  // Fee estimation
  useEffect(() => {
    if (!recipientType) {
      setFeeEstimate(null)
      return
    }

    setIsEstimatingFee(true)
    estimateSendFee(recipientType, selectedChain)
      .then(setFeeEstimate)
      .finally(() => setIsEstimatingFee(false))
  }, [recipientType, selectedChain])

  const estimatedFee = isEstimatingFee
    ? 'Estimating...'
    : feeEstimate
      ? feeEstimate.networkFee
      : '--'

  // Validation
  const isValidRecipient = recipient.trim() !== '' && recipientType !== null
  const isValidAmount = amount.trim() !== '' && parseFloat(amount) > 0

  // Check if amount exceeds balance
  const amountRaw = isValidAmount ? parseUSDC(amount) : 0n
  const exceedsBalance = amountRaw > shieldedBalance && shieldedBalance > 0n

  // Overall validity
  const isValid =
    isUnlocked && isValidRecipient && isValidAmount && !exceedsBalance && !isSubmitting

  // Validation error message
  const validationError = !isUnlocked
    ? 'Unlock shielded wallet first'
    : !recipient.trim()
      ? 'Please enter a recipient address'
      : !recipientType
        ? 'Invalid address format'
        : !amount.trim()
          ? 'Please enter an amount'
          : parseFloat(amount) <= 0
            ? 'Amount must be greater than 0'
            : exceedsBalance
              ? 'Insufficient balance'
              : null

  // Calculate total (amount + fee)
  const amountNum = parseFloat(amount || '0')
  const total = amountNum > 0 ? `$${amountNum.toFixed(2)}` : '$0.00'

  // Display amount for action bar
  const displayAmount = amount.trim() !== '' ? `${amount} USDC` : '0 USDC'

  const handleSend = async () => {
    if (!isValid || !recipientType) return

    await submitSend({
      amount,
      recipientAddress: recipient,
      recipientType,
      destinationChainKey: recipientType === 'ethereum' ? selectedChain : undefined,
      onSuccess: () => {
        console.log('[send-panel] Send successful')
        // Reset form
        setAmount('')
        setRecipient('')
      },
      onError: (err) => {
        console.error('[send-panel] Send failed:', err)
      },
    })
  }

  // Button content based on state
  const getButtonContent = () => {
    if (isSubmitting) {
      // Show proof progress during proof generation
      if (stage === 'generating-proof' && proofProgress > 0) {
        return (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="ml-2">Proving... {Math.round(proofProgress * 100)}%</span>
          </>
        )
      }
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
          <Send className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Send USDC</h2>
        </div>
        <button
          onClick={onClose}
          className="p-2 hover:bg-muted rounded-md transition-colors"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      <p className="text-sm text-muted-foreground mb-6">
        Send USDC privately to another shielded address, or cross-chain to a public
        address
      </p>

      <div className="space-y-4">
        {/* Recipient Input */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">To</label>
          {recipientType === 'ethereum' || recipient === '' ? (
            // Use full-featured RecipientAddressInput for EVM addresses
            <RecipientAddressInput
              value={recipient}
              onChange={setRecipient}
              onNameChange={setRecipientName}
              onNameValidationChange={() => {}}
              addressType="evm"
              placeholder="0zk... or 0x..."
            />
          ) : (
            // Simple input for Railgun addresses
            <div>
              <input
                type="text"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
                placeholder="0zk... or 0x..."
                className="w-full px-4 py-3 bg-background border border-input rounded-lg text-foreground font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring shadow-sm"
              />
            </div>
          )}

          {/* Transfer type indicator */}
          {recipient && recipientType === 'railgun' && (
            <div className="flex items-center gap-2 mt-2 text-xs text-primary">
              <Shield className="h-3.5 w-3.5" />
              <span>Private transfer (shielded → shielded)</span>
            </div>
          )}
          {recipient && recipientType === 'ethereum' && (
            <div className="flex items-center gap-2 mt-2 text-xs text-info-foreground">
              <ArrowUpRight className="h-3.5 w-3.5" />
              <span>Unshield to public address</span>
            </div>
          )}
          {recipient && !recipientType && (
            <p className="text-xs text-destructive mt-2">
              Invalid address format. Use 0zk... for private or 0x... for unshield.
            </p>
          )}
        </div>

        {/* Destination Chain (for unshield only) */}
        {recipientType === 'ethereum' && (
          <div>
            <label className="block text-sm text-muted-foreground mb-2">
              Destination Chain
            </label>
            <ChainSelect
              value={selectedChain}
              onChange={setSelectedChain}
              showEstimatedTime={true}
              timeType="send"
            />
          </div>
        )}

        {/* Amount Input */}
        <SendPaymentAmountInput
          amount={amount}
          onAmountChange={setAmount}
          availableBalance={availableBalance}
          isShieldedBalanceLoading={isShieldedBalanceLoading}
          hasBalanceError={hasBalanceError}
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
          {feeEstimate?.estimatedTime && (
            <div className="text-xs text-muted-foreground">
              Estimated time: {feeEstimate.estimatedTime}
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
                <span className="text-sm font-semibold text-foreground">Send now</span>
              </div>
              {!isValid && validationError && !isSubmitting && (
                <p className="text-xs text-warning ml-6">{validationError}</p>
              )}
            </div>
            <div className="flex items-center justify-between sm:justify-end gap-4">
              <span className="text-sm font-medium text-muted-foreground">
                {displayAmount}
              </span>
              <Button
                variant="primary"
                onClick={handleSend}
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
