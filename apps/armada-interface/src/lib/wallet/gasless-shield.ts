// ABOUTME: GaslessShieldWrapper.gaslessShield(...) calldata builder — encodes the wrapper ABI for relayer POST.
// ABOUTME: Pure encode (no RPC, no signing); the permit signature is provided by signUsdcPermit().

import { encodeFunctionData } from 'viem'
import type { ShieldRequestData } from '@/lib/railgun/shield'

/**
 * Wrapper ABI fragment. The selector must match what the relayer's `gasless-fee-verifier.ts`
 * accepts via `GASLESS_SHIELD_SELECTOR`. The struct components mirror the on-chain
 * `ShieldRequest` shape so viem's encoder produces calldata the wrapper decodes verbatim.
 */
export const GASLESS_SHIELD_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'gaslessShield',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'totalAmount', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
      {
        name: 'shieldRequest',
        type: 'tuple',
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
      { name: 'integrator', type: 'address' },
    ],
    outputs: [],
  },
] as const

export interface BuildGaslessShieldCalldataInput {
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
  /**
   * Built-by-`createShieldRequest()`. The wrapper enforces `preimage.value == totalAmount - fee`
   * and rejects token mismatches, so the caller has to plumb the same fee math through here.
   */
  shieldRequest: ShieldRequestData
  /** USDC token address on the chain — must match the ShieldRequest's preimage.token.tokenAddress. */
  tokenAddress: `0x${string}`
  /** Integrator address for the pool's fee split; address(0) for none. */
  integrator: `0x${string}`
}

/**
 * Build the `data` field of a `submitRelay()` request targeting `GaslessShieldWrapper`.
 *
 * Returns the raw calldata hex. The caller supplies the wrapper `to` address (looked up from
 * the per-chain deployment manifest) and posts the full `{chainId, to, data, feesCacheId}` to
 * the relayer's `/relay`.
 *
 * Pure function — no RPC, no signing. Composable: tests can re-encode without standing up a
 * wallet or chain provider.
 */
export function buildGaslessShieldCalldata(
  input: BuildGaslessShieldCalldataInput,
): `0x${string}` {
  const shieldAmount = input.totalAmount - input.fee
  return encodeFunctionData({
    abi: GASLESS_SHIELD_WRAPPER_ABI,
    functionName: 'gaslessShield',
    args: [
      input.user,
      input.totalAmount,
      input.fee,
      input.deadline,
      input.v,
      input.r,
      input.s,
      {
        preimage: {
          npk: input.shieldRequest.npk,
          token: {
            tokenType: 0, // 0 = ERC20 — same encoding as the direct-shield handler
            tokenAddress: input.tokenAddress,
            tokenSubID: 0n,
          },
          value: shieldAmount,
        },
        ciphertext: {
          encryptedBundle: input.shieldRequest.encryptedBundle as readonly [
            `0x${string}`,
            `0x${string}`,
            `0x${string}`,
          ],
          shieldKey: input.shieldRequest.shieldKey,
        },
      },
      input.integrator,
    ],
  })
}
