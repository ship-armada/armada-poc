import { FeeDisplay } from '@/components/common/FeeDisplay'

interface DepositFeeInfo {
  totalNative: string
  nativeSymbol: string
  totalUsd?: number
}

interface DepositFeeDisplayProps {
  feeInfo: DepositFeeInfo | null
  isEstimatingFee: boolean
  total: string
}

/**
 * Deposit-specific fee display component.
 * Wraps the generic FeeDisplay with deposit-specific formatting.
 */
export function DepositFeeDisplay({ feeInfo, isEstimatingFee, total }: DepositFeeDisplayProps) {
  const formatFee = (info: unknown): string => {
    const depositFee = info as DepositFeeInfo
    return depositFee.totalUsd !== undefined
      ? `${depositFee.totalNative} ${depositFee.nativeSymbol} (~$${depositFee.totalUsd.toFixed(4)})`
      : `${depositFee.totalNative} ${depositFee.nativeSymbol}`
  }

  const calculateTotal = (): string => {
    return `$${total}`
  }

  return (
    <FeeDisplay
      feeInfo={feeInfo}
      isEstimatingFee={isEstimatingFee}
      total={total}
      formatFee={formatFee}
      calculateTotal={calculateTotal}
    />
  )
}

