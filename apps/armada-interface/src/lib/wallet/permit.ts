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
  // EIP-5267 — standard way to read a contract's EIP-712 domain. OZ's ERC20Permit (≥4.7.2)
  // implements it. Circle's USDC (FiatTokenV2_2) does NOT — Circle uses its own custom EIP-712
  // library that predates EIP-5267 and exposes a plain `version()` getter instead. We try
  // eip712Domain first, fall back to version() + name() second, default to "1" last.
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
  // Circle FiatToken-style version getter. Returns "2" on real USDC v2+, missing on OZ's
  // ERC20Permit (which uses _hashedVersion internally and only exposes it via eip712Domain).
  {
    type: 'function',
    name: 'version',
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
 *   2. Resolve the EIP-712 domain (`name` + `version`) using a three-tier fallback:
 *      a. `eip712Domain()` (EIP-5267) — OZ's ERC20Permit ≥4.7.2 implements it.
 *      b. `name()` + `version()` — Circle's USDC has a plain `version()` getter (returns "2")
 *         but does NOT implement EIP-5267. This is the load-bearing path for real USDC.
 *      c. `name()` + version="1" — last-resort fallback for legacy ERC20Permit deployments
 *         that predate both EIP-5267 and the version() convention.
 *      Hardcoding `version: "1"` (OZ default) breaks against real Circle USDC, which uses
 *      `version: "2"` — the wrapper's permit() call then reverts with `EIP2612: invalid
 *      signature` because the signature recovers to a different address than `owner` due to
 *      the wrong domain separator.
 *   3. Build the typed-data envelope + ask wagmi to sign through the active wallet client.
 *   4. Split the 65-byte hex signature into `(v, r, s)`.
 *
 * Throws on any sub-step; the caller wraps into a TxError as part of the handler's outer catch.
 */
export async function signUsdcPermit(
  input: SignUsdcPermitInput,
): Promise<{ v: number; r: `0x${string}`; s: `0x${string}`; nonce: bigint }> {
  // Fetch nonce + every domain-resolution candidate in parallel. `.catch(() => null)` on the
  // optional reads means we only do one round trip's worth of latency regardless of which
  // candidates the token implements. Total: 4 parallel reads.
  const [nonce, domainResult, fallbackName, fallbackVersion] = await Promise.all([
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
    readContract(wagmiConfig, {
      address: input.usdcAddress,
      abi: ERC20_PERMIT_READ_ABI,
      functionName: 'name',
      chainId: input.chainId,
    }).catch(() => null),
    readContract(wagmiConfig, {
      address: input.usdcAddress,
      abi: ERC20_PERMIT_READ_ABI,
      functionName: 'version',
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
    if (fallbackName === null) {
      throw new Error(
        `signUsdcPermit: token at ${input.usdcAddress} implements neither eip712Domain() nor name() — cannot resolve EIP-712 domain.`,
      )
    }
    tokenName = fallbackName
    // Circle FiatToken returns "2"; legacy ERC20Permit returns nothing → default to "1".
    tokenVersion = fallbackVersion ?? '1'
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
