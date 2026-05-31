// ABOUTME: EIP-2612 USDC permit signing helper — produces (v, r, s) the gasless shield wrappers consume.
// ABOUTME: Reads usdc.nonces() + usdc.name() via wagmi/actions; signs typed data through the connected wallet.

import { readContract, signTypedData } from 'wagmi/actions'
import { hexToSignature } from 'viem'
import { wagmiConfig } from '@/config/wagmi'

/**
 * EIP-2612 permit type-set used by `usdc.permit(...)`. The struct order and field types match
 * OpenZeppelin's `ERC20Permit` (which real USDC v2.2+ also implements verbatim). Any drift here
 * — wrong name, swapped owner/spender, missing nonce — produces a signature that ECDSA-recovers
 * to a different address and the wrapper's `IERC20Permit.permit(...)` call reverts.
 */
const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const ERC20_PERMIT_READ_ABI = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

/** Inputs the caller controls per permit. */
export interface SignUsdcPermitInput {
  /** Token contract — USDC on the chain the user is signing for. */
  usdcAddress: `0x${string}`
  /** The chain id the permit is bound to (part of the EIP-712 domain). */
  chainId: number
  /** Permit signer — the connected EVM wallet. Must equal the active wagmi account. */
  owner: `0x${string}`
  /** Permit grantee — typically the GaslessShieldWrapper contract address. */
  spender: `0x${string}`
  /** USDC raw amount (6 decimals) the spender is authorised to pull. */
  value: bigint
  /** Unix seconds; permit reverts after this. Caller picks based on a sane UX window. */
  deadline: bigint
}

/**
 * Sign an EIP-2612 USDC permit through the connected wallet.
 *
 * Returns the split `(v, r, s)` the wrapper expects, plus the `nonce` we observed at sign-time
 * (caller doesn't need it for the wrapper call, but logs/telemetry sometimes want it).
 *
 * Order of operations:
 *   1. Read the live `nonces(owner)` on chain — every successful `permit(...)` increments it,
 *      so a stale value would produce a signature that the next on-chain permit call rejects.
 *   2. Read `name()` — the EIP-712 domain binds the canonical token name (USDC's is `"USD Coin"`,
 *      the local mock's `MockUSDCV2` is `"USD Coin"` too). Hard-coding it would silently break
 *      a deployment that changes the token name.
 *   3. Build the typed-data envelope + ask wagmi to sign through the active wallet client.
 *   4. Split the 65-byte hex signature into `(v, r, s)`.
 *
 * Throws on any sub-step; the caller wraps into a TxError as part of the handler's outer catch.
 */
export async function signUsdcPermit(
  input: SignUsdcPermitInput,
): Promise<{ v: number; r: `0x${string}`; s: `0x${string}`; nonce: bigint }> {
  const [nonce, tokenName] = await Promise.all([
    readContract(wagmiConfig, {
      address: input.usdcAddress,
      abi: ERC20_PERMIT_READ_ABI,
      functionName: 'nonces',
      args: [input.owner],
      chainId: input.chainId,
    }),
    readContract(wagmiConfig, {
      address: input.usdcAddress,
      abi: ERC20_PERMIT_READ_ABI,
      functionName: 'name',
      chainId: input.chainId,
    }),
  ])

  const signatureHex = await signTypedData(wagmiConfig, {
    domain: {
      name: tokenName,
      // EIP-2612's spec leaves `version` to the token; OZ's ERC20Permit defaults to "1" and
      // real USDC v2.2+ matches. Hard-coded here for the same reason ethers tests on PRs to
      // this repo hard-code it — adding it as an input would just push the wrong-value risk up.
      version: '1',
      chainId: input.chainId,
      verifyingContract: input.usdcAddress,
    },
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: {
      owner: input.owner,
      spender: input.spender,
      value: input.value,
      nonce,
      deadline: input.deadline,
    },
  })

  const sig = hexToSignature(signatureHex)
  // viem >=2 returns yParity (0/1); recover v as 27/28 the way EIP-2612 / OZ permit expect.
  // `sig.v` is also present on viem's Signature for backward compat — use it when defined,
  // otherwise reconstruct from yParity. Either path lands at 27/28 on EVM-standard recovery.
  const v =
    typeof sig.v === 'bigint'
      ? Number(sig.v)
      : sig.yParity === 0
        ? 27
        : 28

  return { v, r: sig.r, s: sig.s, nonce }
}
