// ABOUTME: GaslessShieldWrapperClient.gaslessCrossChainShield(...) calldata builder — encodes the
// ABOUTME: client wrapper ABI for relayer POST. Permit + intent signatures come from the caller.

import { encodeFunctionData } from 'viem'
import type { ShieldDataStruct } from '@/lib/wallet/shield-intent'

const SHIELD_DATA_COMPONENTS = [
  { name: 'npk', type: 'bytes32' },
  { name: 'value', type: 'uint120' },
  { name: 'encryptedBundle', type: 'bytes32[3]' },
  { name: 'shieldKey', type: 'bytes32' },
  { name: 'integrator', type: 'address' },
] as const

/**
 * Wrapper ABI fragment. The selector must match the relayer's `gasless-fee-verifier.ts`
 * `GASLESS_CROSS_CHAIN_SHIELD_SELECTOR`. The `CrossChainIntentParams` tuple + two `ShieldData`
 * args mirror the on-chain wrapper verbatim — viem encodes them as tuples.
 */
export const GASLESS_CROSS_CHAIN_SHIELD_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'gaslessCrossChainShield',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'user', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'maxFee', type: 'uint256' },
          { name: 'minFinalityThreshold', type: 'uint32' },
          { name: 'permitV', type: 'uint8' },
          { name: 'permitR', type: 'bytes32' },
          { name: 'permitS', type: 'bytes32' },
        ],
      },
      { name: 'intentSig', type: 'bytes' },
      { name: 'userNote', type: 'tuple', components: SHIELD_DATA_COMPONENTS },
      { name: 'feeNote', type: 'tuple', components: SHIELD_DATA_COMPONENTS },
    ],
    outputs: [{ name: 'cctpNonce', type: 'uint64' }],
  },
] as const

export interface BuildGaslessCrossChainShieldCalldataInput {
  /** Permit + intent signer / USDC source — the connected EVM wallet. */
  user: `0x${string}`
  /** Shared permit + intent deadline (unix seconds). */
  deadline: bigint
  /** The user's intent nonce this call consumes (must equal wrapper.nonces(user)). */
  nonce: bigint
  /** CCTP V2 fast-fee cap in USDC raw units — bound in the intent. */
  maxFee: bigint
  /** 1000 (FAST) or 0 / 2000 (STANDARD) — bound in the intent. */
  minFinalityThreshold: number
  /** EIP-2612 permit signature components from signUsdcPermit(). */
  permitV: number
  permitR: `0x${string}`
  permitS: `0x${string}`
  /** 65-byte EIP-712 CrossChainShieldIntent signature. */
  intentSig: `0x${string}`
  /** The user's recipient note (built against the HUB usdc address; minted on the hub). */
  userNote: ShieldDataStruct
  /** The relayer's fee note (to the relayer's 0zk npk); minted on the hub at full value. */
  feeNote: ShieldDataStruct
}

/**
 * Build the `data` field of a `submitRelay()` request targeting `GaslessShieldWrapperClient`.
 *
 * Returns raw calldata hex. Caller supplies the wrapper `to` address (from the client-chain
 * manifest) and posts `{chainId: clientChainId, to, data, feesCacheId, feeShieldRandom}` to
 * `/relay`.
 *
 * Pure function — no RPC, no signing.
 */
export function buildGaslessCrossChainShieldCalldata(
  input: BuildGaslessCrossChainShieldCalldataInput,
): `0x${string}` {
  return encodeFunctionData({
    abi: GASLESS_CROSS_CHAIN_SHIELD_WRAPPER_ABI,
    functionName: 'gaslessCrossChainShield',
    args: [
      {
        user: input.user,
        deadline: input.deadline,
        nonce: input.nonce,
        maxFee: input.maxFee,
        minFinalityThreshold: input.minFinalityThreshold,
        permitV: input.permitV,
        permitR: input.permitR,
        permitS: input.permitS,
      },
      input.intentSig,
      input.userNote,
      input.feeNote,
    ],
  })
}
