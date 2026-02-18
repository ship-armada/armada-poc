/**
 * Shared yield adapt proof generation
 *
 * Core logic for trustless lend/redeem proofs via ArmadaYieldAdapter.
 * Uses adaptContract/adaptParams pattern - adapter cannot deviate from user's committed shield destination.
 */

import { ethers } from 'ethers'
import {
  generateProofTransactions,
  type GenerateTransactionsProgressCallback,
} from '@railgun-community/wallet'
import { RelayAdaptHelper } from '@railgun-community/engine'
import {
  TXIDVersion,
  ProofType,
  NetworkName,
  type RailgunERC20AmountRecipient,
} from '@railgun-community/shared-models'
import { encodeYieldAdaptParams } from './yieldAdaptParams'
import { normalizeTransactionForAdapter } from './normalizeTransaction'

export type YieldAdaptMode = 'lend' | 'redeem'

const ADAPTER_ABI = [
  'function lendAndShield(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) _transaction, bytes32 _npk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext) view returns (uint256)',
  'function redeemAndShield(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) _transaction, bytes32 _npk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext) view returns (uint256)',
]

export interface YieldAdaptProofResult {
  transaction: {
    to: string
    data: string
    value: bigint
  }
  npk: string
  shieldCiphertext: {
    encryptedBundle: [string, string, string]
    shieldKey: string
  }
}

export interface GenerateYieldAdaptProofCoreParams {
  walletId: string
  encryptionKey: string
  mode: YieldAdaptMode
  unshieldToken: string
  unshieldAmount: bigint
  shieldOutputToken: string
  railgunAddress: string
  adapterAddress: string
  usdcAddress: string
  vaultAddress: string
  broadcasterFeeRecipient?: RailgunERC20AmountRecipient
  sendWithPublicWallet: boolean
  progressCallback?: GenerateTransactionsProgressCallback
}

export async function generateYieldAdaptProofCore(
  params: GenerateYieldAdaptProofCoreParams,
): Promise<YieldAdaptProofResult> {
  const {
    walletId,
    encryptionKey,
    mode,
    unshieldToken,
    unshieldAmount,
    shieldOutputToken,
    railgunAddress,
    adapterAddress,
    broadcasterFeeRecipient,
    sendWithPublicWallet,
    progressCallback,
  } = params

  const shieldRandom = ethers.hexlify(ethers.randomBytes(16))

  const relayShieldRequests = await RelayAdaptHelper.generateRelayShieldRequests(
    shieldRandom,
    [{ tokenAddress: shieldOutputToken, recipientAddress: railgunAddress }],
    [],
  )

  if (relayShieldRequests.length === 0) {
    throw new Error('Failed to generate shield request')
  }

  const shieldRequest = relayShieldRequests[0]
  const npk = shieldRequest.preimage.npk as string
  const encryptedBundle = shieldRequest.ciphertext.encryptedBundle as [string, string, string]
  const shieldKey = shieldRequest.ciphertext.shieldKey as string

  const adaptParams = encodeYieldAdaptParams(npk, encryptedBundle, shieldKey)
  const relayAdaptID = {
    contract: adapterAddress,
    parameters: adaptParams,
  }

  const unshieldRecipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress: unshieldToken,
      amount: unshieldAmount,
      recipientAddress: adapterAddress,
    },
  ]

  const { provedTransactions } = await generateProofTransactions(
    ProofType.CrossContractCalls,
    'Hardhat' as NetworkName,
    walletId,
    TXIDVersion.V2_PoseidonMerkle,
    encryptionKey,
    false,
    undefined,
    unshieldRecipients,
    [],
    broadcasterFeeRecipient,
    sendWithPublicWallet,
    relayAdaptID,
    false,
    undefined,
    progressCallback ?? (() => {}),
  )

  if (!provedTransactions.length) {
    throw new Error('No proved transactions generated')
  }

  const tx = provedTransactions[0]
  const transaction = normalizeTransactionForAdapter(tx)
  const functionName = mode === 'lend' ? 'lendAndShield' : 'redeemAndShield'
  const iface = new ethers.Interface(ADAPTER_ABI)
  const data = iface.encodeFunctionData(functionName, [
    transaction,
    npk,
    {
      encryptedBundle,
      shieldKey,
    },
  ])

  return {
    transaction: {
      to: adapterAddress,
      data,
      value: 0n,
    },
    npk,
    shieldCiphertext: {
      encryptedBundle,
      shieldKey,
    },
  }
}
