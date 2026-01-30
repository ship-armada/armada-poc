import { useTransactionSubmission } from '@/hooks/useTransactionSubmission'
import {
  buildDepositTransaction,
  signDepositTransaction,
  broadcastDepositTransaction,
  saveDepositTransaction,
  type DepositTransactionDetails,
} from '@/services/deposit/depositService'
import { getEvmTxExplorerUrl } from '@/utils/explorerUtils'

export interface UseDepositTransactionParams {
  amount: string
  toAddress: string
  selectedChain: string
  chainName: string
  estimatedFee: string
  total: string
  evmAddress: string | undefined
  onAddressBookSave?: () => void
}

export interface UseDepositTransactionReturn {
  submitDeposit: (params: UseDepositTransactionParams) => Promise<void>
}

/**
 * Hook to handle deposit transaction submission
 */
export function useDepositTransaction(): UseDepositTransactionReturn {
  const { submit } = useTransactionSubmission<
    Omit<UseDepositTransactionParams, 'onAddressBookSave'>,
    DepositTransactionDetails
  >({
    transactionType: 'deposit',
    direction: 'deposit',
    buildTransaction: async (params) => {
      return await buildDepositTransaction({
        amount: params.amount,
        destinationAddress: params.toAddress,
        sourceChain: params.selectedChain,
      })
    },
    signTransaction: signDepositTransaction,
    broadcastTransaction: async (tx, callbacks) => {
      const hash = await broadcastDepositTransaction(tx, callbacks)
      return { hash }
    },
    saveTransaction: saveDepositTransaction,
    getExplorerUrl: async (chain: string | undefined, hash: string) => {
      if (!chain) {
        return ''
      }
      const url = await getEvmTxExplorerUrl(chain, hash)
      return url || ''
    },
  })

  const submitDeposit = async (params: UseDepositTransactionParams): Promise<void> => {
    const { onAddressBookSave, ...rest } = params
    const details: DepositTransactionDetails = {
      amount: params.amount,
      fee: params.estimatedFee,
      total: params.total,
      destinationAddress: params.toAddress,
      chainName: params.chainName,
      ...(params.evmAddress && { senderAddress: params.evmAddress }),
    }

    await submit({
      ...rest,
      details,
      onAddressBookSave,
    })
  }

  return {
    submitDeposit,
  }
}

