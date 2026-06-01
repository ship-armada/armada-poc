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
  // EIP-5267 — standard way to read a contract's EIP-712 domain. Both OZ's ERC20Permit (≥4.7.2)
  // and Circle's USDC v2.2+ (FiatTokenV2_2) implement it. Returning here lets us source `name`
  // + `version` dynamically instead of hardcoding either — hardcoding `version: "1"` (OZ default)
  // breaks against real Circle USDC which uses `version: "2"`, surfacing as
  // `EIP2612: invalid signature` from the wrapper's permit call.
  {
    type: 'function',
    name: 'eip712Domain',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'fields', type: 'bytes1' },
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
      { name: 'salt', type: 'bytes32' },
      { name: 'extensions', type: 'uint256[]' },
    ],
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
 *   2. Resolve the EIP-712 domain (`name` + `version`). Try `eip712Domain()` (EIP-5267) first —
 *      both OZ's ERC20Permit (≥4.7.2) and Circle's USDC v2.2+ implement it. Falls back to
 *      `name()` + `version="1"` when the token predates EIP-5267 (legacy contracts only).
 *      Critical: hardcoding `version: "1"` works for OZ's default but breaks against real
 *      Circle USDC, which uses `version: "2"` — the wrapper's permit() call then reverts with
 *      `EIP2612: invalid signature` because the signature recovers to a different address than
 *      `owner` due to the wrong domain separator.
 *   3. Build the typed-data envelope + ask wagmi to sign through the active wallet client.
 *   4. Split the 65-byte hex signature into `(v, r, s)`.
 *
 * Throws on any sub-step; the caller wraps into a TxError as part of the handler's outer catch.
 */
export async function signUsdcPermit(
  input: SignUsdcPermitInput,
): Promise<{ v: number; r: `0x${string}`; s: `0x${string}`; nonce: bigint }> {
  // Nonce + domain reads in parallel. `eip712Domain()` may revert on legacy contracts that
  // predate EIP-5267 — catch and fall back to `name()` + version="1". The fallback path keeps
  // legacy ERC20Permit deployments working at the cost of an extra round trip on failure.
  const [nonce, domainResult] = await Promise.all([
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
      functionName: 'eip712Domain',
      chainId: input.chainId,
    }).catch(() => null),
  ])

  let tokenName: string
  let tokenVersion: string
  if (domainResult) {
    // EIP-5267 returns (fields, name, version, chainId, verifyingContract, salt, extensions).
    // We rely on name + version only — chainId + verifyingContract are inputs to this fn,
    // and fields/salt/extensions matter only for non-standard domain shapes (USDC + OZ aren't).
    tokenName = domainResult[1]
    tokenVersion = domainResult[2]
  } else {
    tokenName = await readContract(wagmiConfig, {
      address: input.usdcAddress,
      abi: ERC20_PERMIT_READ_ABI,
      functionName: 'name',
      chainId: input.chainId,
    })
    tokenVersion = '1'
  }

  const signatureHex = await signTypedData(wagmiConfig, {
    domain: {
      name: tokenName,
      version: tokenVersion,
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
