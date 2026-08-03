// ABOUTME: EIP-712 ShieldIntent signing for the permissionless gasless wrappers — binds the full
// ABOUTME: ShieldRequest array (hub) / user+fee notes (client) so any relayer can submit safely.

import { readContract, signTypedData } from 'wagmi/actions'
import { keccak256, encodeAbiParameters } from 'viem'
import { wagmiConfig } from '@/config/wagmi'
import type { ShieldRequestData } from '@/lib/railgun/shield'

/**
 * On-chain `ShieldRequest` struct shape (hub `shield` / `gaslessShield`). The frontend builds these
 * so `requestsHash = keccak256(abi.encode(shieldRequests))` matches the wrapper's own hash of the
 * array it receives in calldata — the load-bearing binding that makes submission permissionless.
 */
export interface ShieldRequestStruct {
  readonly preimage: {
    readonly npk: `0x${string}`
    readonly token: {
      readonly tokenType: number
      readonly tokenAddress: `0x${string}`
      readonly tokenSubID: bigint
    }
    readonly value: bigint
  }
  readonly ciphertext: {
    readonly encryptedBundle: readonly [`0x${string}`, `0x${string}`, `0x${string}`]
    readonly shieldKey: `0x${string}`
  }
}

/** On-chain `ShieldData` struct shape (CCTP payload / client `crossChainShieldWithFee`). */
export interface ShieldDataStruct {
  readonly npk: `0x${string}`
  readonly value: bigint
  readonly encryptedBundle: readonly [`0x${string}`, `0x${string}`, `0x${string}`]
  readonly shieldKey: `0x${string}`
  readonly integrator: `0x${string}`
}

// ── ABI parameter definitions (must mirror the Solidity structs exactly) ──────────────────────

const SHIELD_REQUEST_COMPONENTS = [
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
] as const

const SHIELD_DATA_COMPONENTS = [
  { name: 'npk', type: 'bytes32' },
  { name: 'value', type: 'uint120' },
  { name: 'encryptedBundle', type: 'bytes32[3]' },
  { name: 'shieldKey', type: 'bytes32' },
  { name: 'integrator', type: 'address' },
] as const

// ── Struct converters (single source so the hash and the calldata never drift) ────────────────

/** Build a hub `ShieldRequest` struct from a `createShieldRequest()` output for `tokenAddress`. */
export function toShieldRequestStruct(
  data: ShieldRequestData,
  tokenAddress: `0x${string}`,
): ShieldRequestStruct {
  return {
    preimage: {
      npk: data.npk,
      token: { tokenType: 0, tokenAddress, tokenSubID: 0n }, // 0 = ERC20
      value: data.value,
    },
    ciphertext: { encryptedBundle: data.encryptedBundle, shieldKey: data.shieldKey },
  }
}

/** Build a `ShieldData` struct (CCTP payload) from a `createShieldRequest()` output. */
export function toShieldDataStruct(
  data: ShieldRequestData,
  integrator: `0x${string}`,
): ShieldDataStruct {
  return {
    npk: data.npk,
    value: data.value,
    encryptedBundle: data.encryptedBundle,
    shieldKey: data.shieldKey,
    integrator,
  }
}

// ── Hashing (mirrors keccak256(abi.encode(...)) on-chain) ─────────────────────────────────────

/** `keccak256(abi.encode(shieldRequests))` — the digest the hub wrapper binds in the intent. */
export function computeRequestsHash(requests: readonly ShieldRequestStruct[]): `0x${string}` {
  return keccak256(
    encodeAbiParameters([{ type: 'tuple[]', components: SHIELD_REQUEST_COMPONENTS }], [requests]),
  )
}

/** `keccak256(abi.encode(note))` for a single `ShieldData` — used by the cross-chain intent. */
export function computeShieldDataHash(note: ShieldDataStruct): `0x${string}` {
  return keccak256(
    encodeAbiParameters([{ type: 'tuple', components: SHIELD_DATA_COMPONENTS }], [note]),
  )
}

// ── EIP-712 typed-data sets (must match the wrappers' *_INTENT_TYPEHASH) ───────────────────────

const SHIELD_INTENT_TYPES = {
  ShieldIntent: [
    { name: 'user', type: 'address' },
    { name: 'requestsHash', type: 'bytes32' },
    { name: 'integrator', type: 'address' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

const CROSS_CHAIN_SHIELD_INTENT_TYPES = {
  CrossChainShieldIntent: [
    { name: 'user', type: 'address' },
    { name: 'userNoteHash', type: 'bytes32' },
    { name: 'feeNoteHash', type: 'bytes32' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

const WRAPPER_NONCES_ABI = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/** Read the wrapper's per-user intent nonce. */
export async function readIntentNonce(
  wrapperAddress: `0x${string}`,
  chainId: number,
  user: `0x${string}`,
): Promise<bigint> {
  return readContract(wagmiConfig, {
    address: wrapperAddress,
    abi: WRAPPER_NONCES_ABI,
    functionName: 'nonces',
    args: [user],
    chainId,
  })
}

export interface SignShieldIntentInput {
  /** Hub GaslessShieldWrapper address (EIP-712 verifyingContract). */
  wrapperAddress: `0x${string}`
  chainId: number
  /** Intent signer — the connected EVM wallet (== permit signer). */
  user: `0x${string}`
  /** `keccak256(abi.encode(shieldRequests))` from `computeRequestsHash`. */
  requestsHash: `0x${string}`
  integrator: `0x${string}`
  deadline: bigint
  /** Current on-chain nonce for `user` (from `readIntentNonce`). Bound into the signature. */
  nonce: bigint
}

/** Sign the hub `ShieldIntent` through the connected wallet. Returns the 65-byte signature. */
export async function signShieldIntent(input: SignShieldIntentInput): Promise<`0x${string}`> {
  return signTypedData(wagmiConfig, {
    domain: {
      name: 'ArmadaGaslessShield',
      version: '1',
      chainId: input.chainId,
      verifyingContract: input.wrapperAddress,
    },
    types: SHIELD_INTENT_TYPES,
    primaryType: 'ShieldIntent',
    message: {
      user: input.user,
      requestsHash: input.requestsHash,
      integrator: input.integrator,
      deadline: input.deadline,
      nonce: input.nonce,
    },
  })
}

export interface SignCrossChainShieldIntentInput {
  /** Client GaslessShieldWrapperClient address (EIP-712 verifyingContract). */
  wrapperAddress: `0x${string}`
  /** The CLIENT chain id the intent is bound to. */
  chainId: number
  user: `0x${string}`
  /** `computeShieldDataHash(userNote)`. */
  userNoteHash: `0x${string}`
  /** `computeShieldDataHash(feeNote)`. */
  feeNoteHash: `0x${string}`
  maxFee: bigint
  minFinalityThreshold: number
  deadline: bigint
  nonce: bigint
}

/** Sign the client `CrossChainShieldIntent`. Returns the 65-byte signature. */
export async function signCrossChainShieldIntent(
  input: SignCrossChainShieldIntentInput,
): Promise<`0x${string}`> {
  return signTypedData(wagmiConfig, {
    domain: {
      name: 'ArmadaGaslessCrossChainShield',
      version: '1',
      chainId: input.chainId,
      verifyingContract: input.wrapperAddress,
    },
    types: CROSS_CHAIN_SHIELD_INTENT_TYPES,
    primaryType: 'CrossChainShieldIntent',
    message: {
      user: input.user,
      userNoteHash: input.userNoteHash,
      feeNoteHash: input.feeNoteHash,
      maxFee: input.maxFee,
      minFinalityThreshold: input.minFinalityThreshold,
      deadline: input.deadline,
      nonce: input.nonce,
    },
  })
}
