// ABOUTME: SDK-backed yield adapter builder — planTransfer(unshield to adapter + re-shield-bundle adaptParams)
// ABOUTME: → prove → transactionToTuple → encode lendAndShield / redeemAndShield calldata for the yield adapter.

import { ethers } from 'ethers'
import {
  buildShieldRequest,
  generateShieldPrivateKey,
  encodeYieldDepositBinding,
  encodeYieldRedeemBinding,
  transactionToTuple,
} from '@armada/sdk'
import { getSdkWallet } from './sdk-read'

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const

/**
 * Adapter entry points — the proved Transaction tuple + the user's re-shield destination (npk +
 * ciphertext). `redeemAndShield` additionally takes the relayer's fee-shield destination + amount,
 * all committed by `boundParams.adaptParams`. Mirrors contracts/yield/ArmadaYieldAdapter.sol; the same
 * human-readable strings the engine builder used, via `ethers.Interface` (viem's parseAbi can't parse
 * this depth of nested inline tuples). The Transaction is passed as a positional tuple.
 */
const ADAPTER_ABI = [
  'function lendAndShield(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) _transaction, bytes32 _npk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext) returns (uint256)',
  'function redeemAndShield(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) _transaction, bytes32 _npk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext, bytes32 _feeNpk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _feeShieldCiphertext, uint256 _feeAmount) returns (uint256)',
]

const as0x = (hex: string): `0x${string}` => {
  if (!hex.startsWith('0x')) throw new Error('yield-sdk: expected a 0x-prefixed hex value')
  return hex as `0x${string}`
}

/** A re-shield destination bound into adaptParams: npk (poseidon(mpk, random)) + the shield ECIES bundle. */
interface ReshieldBundle {
  readonly npk: `0x${string}`
  readonly encryptedBundle: readonly [`0x${string}`, `0x${string}`, `0x${string}`]
  readonly shieldKey: `0x${string}`
  readonly random: string
}

/**
 * Build a re-shield destination for `railgunAddress` in `tokenAddress` — the note the adapter shields
 * back into the pool after the vault op. Value is 0 (the adapter fills the real output amount at
 * runtime); only npk/encryptedBundle/shieldKey are bound into adaptParams, all value-independent.
 */
async function buildReshieldBundle(railgunAddress: string, tokenAddress: `0x${string}`): Promise<ReshieldBundle> {
  const { shieldRequest, random } = await buildShieldRequest(
    { railgunAddress, amount: 0n, tokenAddress },
    generateShieldPrivateKey(),
  )
  return {
    npk: as0x(shieldRequest.preimage.npk),
    encryptedBundle: [
      as0x(shieldRequest.ciphertext.encryptedBundle[0]),
      as0x(shieldRequest.ciphertext.encryptedBundle[1]),
      as0x(shieldRequest.ciphertext.encryptedBundle[2]),
    ],
    shieldKey: as0x(shieldRequest.ciphertext.shieldKey),
    random,
  }
}

export interface SdkYieldInputs {
  readonly mode: 'lend' | 'redeem'
  /** Unshield amount: USDC (lend) or vault shares (redeem) — the token spent to the adapter. */
  readonly amount: bigint
  /** Token spent to the adapter: USDC (lend) / ayUSDC shares (redeem). */
  readonly unshieldToken: `0x${string}`
  /** Token the adapter re-shields back to the user: ayUSDC shares (lend) / USDC (redeem). */
  readonly shieldOutputToken: `0x${string}`
  readonly adapterAddress: `0x${string}`
  /** The user's 0zk address — recipient of the re-shielded output. */
  readonly railgunAddress: string
  /** Broadcaster (relayer) fee. On lend it's a shielded fee note (SDK fee leg); on redeem it's the
   *  contract-side fee shielded to the relayer's 0zk from the redeemed USDC, bound into adaptParams. */
  readonly broadcasterFee: { readonly amount: bigint; readonly recipientAddress: string } | null
  readonly onProgress?: (fraction: number) => void
}

/**
 * Build a yield adapter transaction via `@armada/sdk`. The proof unshields `amount` of `unshieldToken`
 * TO the adapter (`adaptContract` = adapter), with the user's re-shield destination bound into
 * `boundParams.adaptParams`; the adapter deposits into (lend) / redeems from (redeem) the vault and
 * shields the result back to the user. Returns the encoded `lendAndShield`/`redeemAndShield` calldata.
 *
 * `feeShieldRandom` is surfaced on redeem so the relayer can recompute the fee note's npk =
 * poseidon(itsMasterPublicKey, feeShieldRandom) and confirm the fee is addressed to itself (#312).
 */
export async function buildYieldAdaptSdk(
  inputs: SdkYieldInputs,
): Promise<{ to: `0x${string}`; data: `0x${string}`; feeShieldRandom?: string }> {
  const isRedeem = inputs.mode === 'redeem'
  const wallet = await getSdkWallet()

  // The user's re-shield destination + the deposit/redeem binding.
  const user = await buildReshieldBundle(inputs.railgunAddress, inputs.shieldOutputToken)

  // The relayer fee re-shield destination (redeem only, when a broadcaster fee is charged).
  let feeNpk: `0x${string}` = ZERO_BYTES32
  let feeEncryptedBundle: readonly [`0x${string}`, `0x${string}`, `0x${string}`] = [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32]
  let feeShieldKey: `0x${string}` = ZERO_BYTES32
  let feeAmount = 0n
  let feeShieldRandom: string | undefined
  if (isRedeem && inputs.broadcasterFee && inputs.broadcasterFee.amount > 0n) {
    const fee = await buildReshieldBundle(inputs.broadcasterFee.recipientAddress, inputs.shieldOutputToken)
    feeNpk = fee.npk
    feeEncryptedBundle = fee.encryptedBundle
    feeShieldKey = fee.shieldKey
    feeAmount = inputs.broadcasterFee.amount
    feeShieldRandom = fee.random
  }

  const adaptParams = isRedeem
    ? encodeYieldRedeemBinding(BigInt(user.npk), user.encryptedBundle, user.shieldKey, BigInt(feeNpk), feeEncryptedBundle, feeShieldKey, feeAmount)
    : encodeYieldDepositBinding(BigInt(user.npk), user.encryptedBundle, user.shieldKey)

  // Lend pays the relayer via the SDK fee leg (a shielded USDC output note); redeem does not (its fee
  // is the contract-side re-shield above), so it plans with no fee output.
  const fee = !isRedeem && inputs.broadcasterFee
    ? {
        schedule: { transfer: inputs.broadcasterFee.amount.toString() },
        broadcasterRailgunAddress: inputs.broadcasterFee.recipientAddress,
        feesCacheId: '',
        expiresAt: 0,
      }
    : { schedule: { transfer: '0' }, broadcasterRailgunAddress: '', feesCacheId: '', expiresAt: 0 }

  const plan = await wallet.planTransfer({
    outputs: [],
    unshield: { recipient: inputs.adapterAddress, amount: inputs.amount, adaptContract: inputs.adapterAddress, adaptParams },
    tokenAddress: inputs.unshieldToken,
    fee,
  })
  const handle = await wallet.prove(
    plan,
    inputs.onProgress ? { onProgress: (p) => inputs.onProgress?.(p.fraction) } : undefined,
  )
  const tuple = transactionToTuple(handle.toTransactionData())
  const iface = new ethers.Interface(ADAPTER_ABI)

  const data = (
    isRedeem
      ? iface.encodeFunctionData('redeemAndShield', [
          tuple,
          user.npk,
          { encryptedBundle: user.encryptedBundle, shieldKey: user.shieldKey },
          feeNpk,
          { encryptedBundle: feeEncryptedBundle, shieldKey: feeShieldKey },
          feeAmount,
        ])
      : iface.encodeFunctionData('lendAndShield', [tuple, user.npk, { encryptedBundle: user.encryptedBundle, shieldKey: user.shieldKey }])
  ) as `0x${string}`

  return { to: inputs.adapterAddress, data, ...(feeShieldRandom !== undefined ? { feeShieldRandom } : {}) }
}
