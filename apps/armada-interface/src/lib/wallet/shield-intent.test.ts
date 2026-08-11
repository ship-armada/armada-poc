// ABOUTME: Parity tests for the intent note-hashing — viem computeRequestsHash/computeShieldDataHash
// ABOUTME: must equal Solidity keccak256(abi.encode(...)), cross-checked against ethers AbiCoder.

import { describe, it, expect } from 'vitest'
import { AbiCoder, keccak256 as ethersKeccak256 } from 'ethers'
import {
  computeRequestsHash,
  computeShieldDataHash,
  toShieldRequestStruct,
  toShieldDataStruct,
  type ShieldRequestStruct,
  type ShieldDataStruct,
} from './shield-intent'
import type { ShieldRequestData } from '@/lib/shielded/shield'

const TOKEN = '0x2222222222222222222222222222222222222222' as const
const INTEGRATOR = '0x3333333333333333333333333333333333333333' as const

// Solidity type strings (must mirror the on-chain structs) for the independent ethers encoding.
const SHIELD_REQUEST_ARRAY_TYPE =
  'tuple(tuple(bytes32,tuple(uint8,address,uint256),uint120),tuple(bytes32[3],bytes32))[]'
const SHIELD_DATA_TYPE = 'tuple(bytes32,uint120,bytes32[3],bytes32,address)'

function reqStruct(npk: string, value: bigint): ShieldRequestStruct {
  return {
    preimage: {
      npk: npk as `0x${string}`,
      token: { tokenType: 0, tokenAddress: TOKEN, tokenSubID: 0n },
      value,
    },
    ciphertext: {
      encryptedBundle: [
        ('0x' + '11'.repeat(32)) as `0x${string}`,
        ('0x' + '22'.repeat(32)) as `0x${string}`,
        ('0x' + '33'.repeat(32)) as `0x${string}`,
      ] as const,
      shieldKey: ('0x' + '44'.repeat(32)) as `0x${string}`,
    },
  }
}

function ethersRequestsHash(reqs: ShieldRequestStruct[]): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    [SHIELD_REQUEST_ARRAY_TYPE],
    [
      reqs.map((r) => [
        [r.preimage.npk, [r.preimage.token.tokenType, r.preimage.token.tokenAddress, r.preimage.token.tokenSubID], r.preimage.value],
        [r.ciphertext.encryptedBundle, r.ciphertext.shieldKey],
      ]),
    ],
  )
  return ethersKeccak256(encoded)
}

function ethersShieldDataHash(n: ShieldDataStruct): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    [SHIELD_DATA_TYPE],
    [[n.npk, n.value, n.encryptedBundle, n.shieldKey, n.integrator]],
  )
  return ethersKeccak256(encoded)
}

describe('computeRequestsHash', () => {
  it('matches ethers abi.encode + keccak256 for a two-note array', () => {
    // WHY: the hub wrapper binds keccak256(abi.encode(shieldRequests)) in the signed intent. If the
    // frontend hash diverges from Solidity's abi.encode by one byte, every honest gasless shield
    // reverts with "bad intent sig". ethers AbiCoder is an independent impl already proven equal to
    // the contract (see Hardhat gasless_shield_wrapper.ts), so viem == ethers ⇒ viem == contract.
    const reqs = [reqStruct('0x' + 'c'.repeat(64), 10_000_000n), reqStruct('0x' + 'e'.repeat(64), 500_000n)]
    expect(computeRequestsHash(reqs).toLowerCase()).toBe(ethersRequestsHash(reqs).toLowerCase())
  })

  it('matches for a single-note array', () => {
    const reqs = [reqStruct('0x' + 'a'.repeat(64), 7_000_000n)]
    expect(computeRequestsHash(reqs).toLowerCase()).toBe(ethersRequestsHash(reqs).toLowerCase())
  })
})

describe('computeShieldDataHash', () => {
  it('matches ethers abi.encode + keccak256 for a ShieldData note', () => {
    const n = toShieldDataStruct(
      {
        npk: ('0x' + 'c'.repeat(64)) as `0x${string}`,
        value: 500_000n,
        encryptedBundle: [
          ('0x' + '11'.repeat(32)) as `0x${string}`,
          ('0x' + '22'.repeat(32)) as `0x${string}`,
          ('0x' + '33'.repeat(32)) as `0x${string}`,
        ] as const,
        shieldKey: ('0x' + '44'.repeat(32)) as `0x${string}`,
        random: 'ff'.repeat(16),
      } satisfies ShieldRequestData,
      INTEGRATOR,
    )
    expect(computeShieldDataHash(n).toLowerCase()).toBe(ethersShieldDataHash(n).toLowerCase())
  })
})

describe('struct converters', () => {
  it('toShieldRequestStruct sets ERC20 token + preserves ciphertext', () => {
    const data: ShieldRequestData = {
      npk: ('0x' + 'c'.repeat(64)) as `0x${string}`,
      value: 9n,
      encryptedBundle: [
        ('0x' + '11'.repeat(32)) as `0x${string}`,
        ('0x' + '22'.repeat(32)) as `0x${string}`,
        ('0x' + '33'.repeat(32)) as `0x${string}`,
      ] as const,
      shieldKey: ('0x' + '44'.repeat(32)) as `0x${string}`,
      random: 'ab'.repeat(16),
    }
    const s = toShieldRequestStruct(data, TOKEN)
    expect(s.preimage.token.tokenType).toBe(0)
    expect(s.preimage.token.tokenAddress).toBe(TOKEN)
    expect(s.preimage.value).toBe(9n)
    expect(s.ciphertext.shieldKey).toBe(data.shieldKey)
  })
})
