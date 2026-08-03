// ABOUTME: GaslessShieldWrapper.gaslessShield(...) calldata builder — encodes the wrapper ABI for relayer POST.
// ABOUTME: Pure encode (no RPC, no signing); the permit + intent signatures are provided by the caller.

import { encodeFunctionData } from 'viem'
import type { ShieldRequestStruct } from '@/lib/wallet/shield-intent'

/**
 * Wrapper ABI fragment. The selector must match what the relayer's `gasless-fee-verifier.ts`
 * accepts via `GASLESS_SHIELD_SELECTOR`. The `ShieldIntentParams` tuple + `ShieldRequest[]` shapes
 * mirror the on-chain structs so viem's encoder produces calldata the wrapper decodes verbatim.
 */
export const GASLESS_SHIELD_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'gaslessShield',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'user', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'integrator', type: 'address' },
          { name: 'permitV', type: 'uint8' },
          { name: 'permitR', type: 'bytes32' },
          { name: 'permitS', type: 'bytes32' },
        ],
      },
      { name: 'intentSig', type: 'bytes' },
      {
        name: 'shieldRequests',
        type: 'tuple[]',
        components: [
          {
            name: 'preimage',
            type: 'tuple',
            components: [
              { name: 'npk', type: 'bytes32' },
              {
                name: 'token',
                type: 'tuple',
                components: [
                  { name: 'tokenType', type: 'uint8' },
                  { name: 'tokenAddress', type: 'address' },
                  { name: 'tokenSubID', type: 'uint256' },
                ],
              },
              { name: 'value', type: 'uint120' },
            ],
          },
          {
            name: 'ciphertext',
            type: 'tuple',
            components: [
              { name: 'encryptedBundle', type: 'bytes32[3]' },
              { name: 'shieldKey', type: 'bytes32' },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
] as const

export interface BuildGaslessShieldCalldataInput {
  /** Permit + intent signer / USDC source — the connected EVM wallet. */
  user: `0x${string}`
  /** Shared permit + intent deadline (unix seconds). */
  deadline: bigint
  /** The user's intent nonce this call consumes (must equal wrapper.nonces(user)). */
  nonce: bigint
  /** Integrator for the pool's fee split; address(0) for none. Bound in the intent. */
  integrator: `0x${string}`
  /** EIP-2612 permit signature components from signUsdcPermit(). */
  permitV: number
  permitR: `0x${string}`
  permitS: `0x${string}`
  /** 65-byte EIP-712 ShieldIntent signature from signShieldIntent(). */
  intentSig: `0x${string}`
  /** The exact note array the intent's requestsHash was computed over: [userNote, feeNote]. */
  shieldRequests: readonly ShieldRequestStruct[]
}

/**
 * Build the `data` field of a `submitRelay()` request targeting `GaslessShieldWrapper`.
 *
 * Returns the raw calldata hex. The caller supplies the wrapper `to` address (from the per-chain
 * deployment manifest) and posts `{chainId, to, data, feesCacheId, feeShieldRandom}` to `/relay`.
 *
 * Pure function — no RPC, no signing.
 */
export function buildGaslessShieldCalldata(input: BuildGaslessShieldCalldataInput): `0x${string}` {
  return encodeFunctionData({
    abi: GASLESS_SHIELD_WRAPPER_ABI,
    functionName: 'gaslessShield',
    args: [
      {
        user: input.user,
        deadline: input.deadline,
        nonce: input.nonce,
        integrator: input.integrator,
        permitV: input.permitV,
        permitR: input.permitR,
        permitS: input.permitS,
      },
      input.intentSig,
      input.shieldRequests,
    ],
  })
}
