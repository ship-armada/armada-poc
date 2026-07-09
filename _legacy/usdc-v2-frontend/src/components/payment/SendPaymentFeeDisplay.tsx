import { FeeDisplay } from '@/components/common/FeeDisplay'

interface PaymentFeeInfo {
  feeToken: 'USDC' | 'NAM'
  feeAmount: string
}

interface SendPaymentFeeDisplayProps {
  feeInfo: PaymentFeeInfo | null
  isEstimatingFee: boolean
  total: string
  amount: string
}

/**
 * Payment-specific fee display component.
 * Wraps the generic FeeDisplay with payment-specific formatting.
 */
export function SendPaymentFeeDisplay({
  feeInfo,
  isEstimatingFee,
  total,
  amount,
}: SendPaymentFeeDisplayProps) {
  const formatFee = (info: unknown): string => {
    const paymentFee = info as PaymentFeeInfo
    return paymentFee.feeToken === 'USDC'
      ? `$${parseFloat(paymentFee.feeAmount).toFixed(2)}`
      : `${parseFloat(paymentFee.feeAmount).toFixed(6)} NAM`
  }

  const calculateTotal = (info: unknown): string => {
    const paymentFee = info as PaymentFeeInfo
    return paymentFee.feeToken === 'USDC' ? `$${total}` : `$${amount || '0.00'}`
  }

  return (
    <FeeDisplay
      feeInfo={feeInfo}
      isEstimatingFee={isEstimatingFee}
      total={total}
      amount={amount}
      formatFee={formatFee}
      calculateTotal={calculateTotal}
    />
  )
}

