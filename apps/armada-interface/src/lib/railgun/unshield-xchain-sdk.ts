// ABOUTME: SDK-backed cross-chain unshield builder — planTransfer(unshield to pool + CCTP-binding adaptParams)
// ABOUTME: → prove → toTransactionData → transactionToTuple → encode atomicCrossChainUnshield. @armada/sdk analogue of buildXchainUnshieldTransaction.

import { encodeFunctionData } from 'viem'
import { transactionToTuple, encodeCctpBinding } from '@armada/sdk'
import { getSdkWallet } from './sdk-read'

/**
 * Write-path cutover flag. When set, the cross-chain unshield handler builds + submits via
 * `@armada/sdk` (`buildXchainUnshieldSdk`) instead of the stock engine. Off by default; the engine drives.
 */
export function sdkXchainUnshieldEnabled(): boolean {
  return import.meta.env.VITE_SDK_XCHAIN_UNSHIELD === '1'
}

/**
 * PrivacyPool.atomicCrossChainUnshield ABI — the proved Transaction struct wrapped with the CCTP
 * destination + recipient + maxFee + per-tx nonce. The Transaction tuple is passed POSITIONALLY
 * (via `transactionToTuple`, which applies the G2-coordinate swap), so viem encodes by order.
 *
 * NOTE: duplicated from features/unshield-xchain/handler.ts during the differential phase; at the
 * cutover the handler drops its engine copy and imports this module's builder instead.
 */
const PRIVACY_POOL_XCHAIN_UNSHIELD_ABI = [
  {
    type: 'function',
    name: 'atomicCrossChainUnshield',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_transaction', type: 'tuple', components: [
        { name: 'proof', type: 'tuple', components: [
          { name: 'a', type: 'tuple', components: [
            { name: 'x', type: 'uint256' },
            { name: 'y', type: 'uint256' },
          ] },
          { name: 'b', type: 'tuple', components: [
            { name: 'x', type: 'uint256[2]' },
            { name: 'y', type: 'uint256[2]' },
          ] },
          { name: 'c', type: 'tuple', components: [
            { name: 'x', type: 'uint256' },
            { name: 'y', type: 'uint256' },
          ] },
        ] },
        { name: 'merkleRoot', type: 'bytes32' },
        { name: 'nullifiers', type: 'bytes32[]' },
        { name: 'commitments', type: 'bytes32[]' },
        { name: 'boundParams', type: 'tuple', components: [
          { name: 'treeNumber', type: 'uint16' },
          { name: 'minGasPrice', type: 'uint72' },
          { name: 'unshield', type: 'uint8' },
          { name: 'chainID', type: 'uint64' },
          { name: 'adaptContract', type: 'address' },
          { name: 'adaptParams', type: 'bytes32' },
          { name: 'commitmentCiphertext', type: 'tuple[]', components: [
            { name: 'ciphertext', type: 'bytes32[4]' },
            { name: 'blindedSenderViewingKey', type: 'bytes32' },
            { name: 'blindedReceiverViewingKey', type: 'bytes32' },
            { name: 'annotationData', type: 'bytes' },
            { name: 'memo', type: 'bytes' },
          ] },
        ] },
        { name: 'unshieldPreimage', type: 'tuple', components: [
          { name: 'npk', type: 'bytes32' },
          { name: 'token', type: 'tuple', components: [
            { name: 'tokenType', type: 'uint8' },
            { name: 'tokenAddress', type: 'address' },
            { name: 'tokenSubID', type: 'uint256' },
          ] },
          { name: 'value', type: 'uint120' },
        ] },
      ] },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'finalRecipient', type: 'address' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'uniqueNonce', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const

export interface SdkXchainUnshieldInputs {
  readonly amount: bigint
  /** Broadcaster (relayer) fee note, or null for direct user submission (no fee output). */
  readonly broadcasterFee: { readonly amount: bigint; readonly recipientAddress: string } | null
  /** PrivacyPool address — the unshield note's recipient (pool forwards via CCTP) AND the tx `to`. */
  readonly privacyPoolAddress: `0x${string}`
  /** Final USDC recipient on the destination chain — bound into adaptParams, NOT the unshield npk. */
  readonly finalRecipient: `0x${string}`
  readonly destinationDomain: number
  readonly maxFee: bigint
  /** Per-tx CCTP delivery marker (keccak256(recordId)) — echoed into hookData, not a proof input. */
  readonly uniqueNonce: `0x${string}`
  /** ZK-proof progress (0–1); the worker prover emits coarse start/end phases. */
  readonly onProgress?: (fraction: number) => void
}

/**
 * Build a cross-chain unshield transaction via `@armada/sdk`. The unshield note's recipient is the
 * PrivacyPool itself (it burns the shielded UTXO and emits CCTP messages to deliver USDC to the real
 * recipient on another chain); the real destination (`finalRecipient` + `destinationDomain` + `maxFee`)
 * is bound into `boundParams.adaptParams` via `encodeCctpBinding`, so a relayer/front-runner cannot
 * redirect the exit (#364/#378/#399). The proved struct is embedded into `atomicCrossChainUnshield`
 * calldata via `transactionToTuple` (which applies the G2 swap). Returns `{ to, data }`.
 */
export async function buildXchainUnshieldSdk(
  inputs: SdkXchainUnshieldInputs,
): Promise<{ to: `0x${string}`; data: `0x${string}` }> {
  const wallet = await getSdkWallet()
  const fee = inputs.broadcasterFee
    ? {
        schedule: { transfer: inputs.broadcasterFee.amount.toString() },
        broadcasterRailgunAddress: inputs.broadcasterFee.recipientAddress,
        feesCacheId: '',
        expiresAt: 0,
      }
    : { schedule: { transfer: '0' }, broadcasterRailgunAddress: '', feesCacheId: '', expiresAt: 0 }

  const adaptParams = encodeCctpBinding(inputs.finalRecipient, inputs.destinationDomain, inputs.maxFee)
  const plan = await wallet.planTransfer({
    outputs: [],
    unshield: { recipient: inputs.privacyPoolAddress, amount: inputs.amount, adaptParams },
    fee,
  })
  const handle = await wallet.prove(
    plan,
    inputs.onProgress ? { onProgress: (p) => inputs.onProgress?.(p.fraction) } : undefined,
  )
  const data = encodeFunctionData({
    abi: PRIVACY_POOL_XCHAIN_UNSHIELD_ABI,
    functionName: 'atomicCrossChainUnshield',
    // The proved Transaction as a positional tuple (G2-swapped by transactionToTuple), then the CCTP args.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: [transactionToTuple(handle.toTransactionData()) as any, inputs.destinationDomain, inputs.finalRecipient, inputs.maxFee, inputs.uniqueNonce],
  })
  return { to: inputs.privacyPoolAddress, data }
}
