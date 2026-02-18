/**
 * Generate Yield Adapt Redeem Proof
 *
 * Produces a trustless redeem proof: shielded ayUSDC -> unshield to adapter -> redeem -> shield USDC.
 * Uses generateYieldAdaptProofCore with mode 'redeem'.
 * Returns transaction data for adapter.redeemAndShield(transaction, npk, shieldCiphertext).
 */

import {
  generateYieldAdaptProofCore,
  type YieldAdaptProofResult,
} from './generateYieldAdaptProof'
import type { GenerateTransactionsProgressCallback } from '@railgun-community/wallet'
import type { RailgunERC20AmountRecipient } from '@railgun-community/shared-models'

export type YieldAdaptRedeemProofResult = YieldAdaptProofResult

export interface GenerateYieldAdaptRedeemProofParams {
  walletId: string
  encryptionKey: string
  shares: bigint
  railgunAddress: string
  adapterAddress: string
  usdcAddress: string
  vaultAddress: string
  broadcasterFeeRecipient?: RailgunERC20AmountRecipient
  sendWithPublicWallet: boolean
  progressCallback?: GenerateTransactionsProgressCallback
}

export async function generateYieldAdaptRedeemProof(
  params: GenerateYieldAdaptRedeemProofParams,
): Promise<YieldAdaptRedeemProofResult> {
  const {
    walletId,
    encryptionKey,
    shares,
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
    mode: 'redeem',
    unshieldToken: vaultAddress,
    unshieldAmount: shares,
    shieldOutputToken: usdcAddress,
    railgunAddress,
    adapterAddress,
    usdcAddress,
    vaultAddress,
    broadcasterFeeRecipient,
    sendWithPublicWallet,
    progressCallback,
  })
}
