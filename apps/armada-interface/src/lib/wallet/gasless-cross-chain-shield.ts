// ABOUTME: GaslessShieldWrapperClient.gaslessCrossChainShield(...) calldata builder — encodes the
// ABOUTME: client wrapper ABI for relayer POST. Permit signature comes from signUsdcPermit().

import { encodeFunctionData } from 'viem'
import type { ShieldRequestData } from '@/lib/railgun/shield'

/**
 * Wrapper ABI fragment. The selector must match the relayer's `gasless-fee-verifier.ts`
 * `GASLESS_CROSS_CHAIN_SHIELD_SELECTOR`. The two struct args mirror the on-chain wrapper's
 * `PermitInput` and `CrossChainParams` shapes verbatim — viem encodes them as tuples.
 */
export const GASLESS_CROSS_CHAIN_SHIELD_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'gaslessCrossChainShield',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'permitInput',
        type: 'tuple',
        components: [
          { name: 'user', type: 'address' },
          { name: 'totalAmount', type: 'uint256' },
          { name: 'fee', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
      {
        name: 'dest',
        type: 'tuple',
        components: [
          { name: 'maxFee', type: 'uint256' },
          { name: 'minFinalityThreshold', type: 'uint32' },
          { name: 'npk', type: 'bytes32' },
          { name: 'encryptedBundle', type: 'bytes32[3]' },
          { name: 'shieldKey', type: 'bytes32' },
          { name: 'destinationCaller', type: 'bytes32' },
          { name: 'integrator', type: 'address' },
        ],
      },
    ],
    outputs: [{ name: 'cctpNonce', type: 'uint64' }],
  },
] as const

export interface BuildGaslessCrossChainShieldCalldataInput {
  /** Permit signer + USDC source — the connected EVM wallet that signed the permit. */
  user: `0x${string}`
  /** Total USDC the wrapper is authorised to pull = shieldAmount + fee. Must match the permit. */
  totalAmount: bigint
  /** USDC paid to the relayer; the wrapper transfers it via transferFrom(user, relayer, fee). */
  fee: bigint
  /** Unix seconds; must match the permit signature's deadline. */
  deadline: bigint
  /** Permit signature components from signUsdcPermit(). */
  v: number
  r: `0x${string}`
  s: `0x${string}`
  /** CCTP V2 fast-fee cap in USDC raw units — wrapper requires `maxFee < shieldAmount`. */
  maxFee: bigint
  /** 1000 (FAST) or 0 / 2000 (STANDARD) — passed through to TokenMessenger.depositForBurn. */
  minFinalityThreshold: number
  /** Built-by-`createShieldRequest()` against the HUB usdc address (commitment lives on hub). */
  shieldRequest: ShieldRequestData
  /** Hub HookRouter address in bytes32 form — locks destinationCaller; pass `0x00…00` to allow any. */
  destinationCaller: `0x${string}`
  /** Integrator address for the pool's fee split; address(0) for none. */
  integrator: `0x${string}`
}

/**
 * Build the `data` field of a `submitRelay()` request targeting `GaslessShieldWrapperClient`.
 *
 * Returns raw calldata hex. Caller supplies the wrapper `to` address (looked up from the
 * client-chain deployment manifest) and posts `{chainId: clientChainId, to, data, feesCacheId}`
 * to the relayer's `/relay`.
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
        totalAmount: input.totalAmount,
        fee: input.fee,
        deadline: input.deadline,
        v: input.v,
        r: input.r,
        s: input.s,
      },
      {
        maxFee: input.maxFee,
        minFinalityThreshold: input.minFinalityThreshold,
        npk: input.shieldRequest.npk,
        encryptedBundle: input.shieldRequest.encryptedBundle as readonly [
          `0x${string}`,
          `0x${string}`,
          `0x${string}`,
        ],
        shieldKey: input.shieldRequest.shieldKey,
        destinationCaller: input.destinationCaller,
        integrator: input.integrator,
      },
    ],
  })
}
