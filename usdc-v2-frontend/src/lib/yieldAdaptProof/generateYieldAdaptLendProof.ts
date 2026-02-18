/**
 * Generate Yield Adapt Lend Proof
 *
 * Produces a trustless lend proof: shielded USDC -> unshield to adapter -> deposit -> shield ayUSDC.
 * Uses generateYieldAdaptProofCore with mode 'lend'.
 * Returns transaction data for adapter.lendAndShield(transaction, npk, shieldCiphertext).
 */

import {
  generateYieldAdaptProofCore,
  type YieldAdaptProofResult,
} from './generateYieldAdaptProof'
import type { GenerateTransactionsProgressCallback } from '@railgun-community/wallet'
import type { RailgunERC20AmountRecipient } from '@railgun-community/shared-models'

export type YieldAdaptLendProofResult = YieldAdaptProofResult

export interface GenerateYieldAdaptLendProofParams {
  walletId: string
  encryptionKey: string
  amount: bigint
  railgunAddress: string
  adapterAddress: string
  usdcAddress: string
  vaultAddress: string
  broadcasterFeeRecipient?: RailgunERC20AmountRecipient
  sendWithPublicWallet: boolean
  progressCallback?: GenerateTransactionsProgressCallback
}

export async function generateYieldAdaptLendProof(
  params: GenerateYieldAdaptLendProofParams,
): Promise<YieldAdaptLendProofResult> {
  const {
    walletId,
    encryptionKey,
    amount,
    railgunAddress,
    adapterAddress,
    usdcAddress,
    vaultAddress,
    broadcasterFeeRecipient,
    sendWithPublicWallet,
    progressCallback,
  } = params

  return generateYieldAdaptProofCore({
    walletId,
    encryptionKey,
    mode: 'lend',
    unshieldToken: usdcAddress,
    unshieldAmount: amount,
    shieldOutputToken: vaultAddress,
    railgunAddress,
    adapterAddress,
    usdcAddress,
    vaultAddress,
    broadcasterFeeRecipient,
    sendWithPublicWallet,
    progressCallback,
  })
}
