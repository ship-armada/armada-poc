// ABOUTME: Tests for buildGaslessShieldCalldata — selector + arg-shape parity with the on-chain
// ABOUTME: permissionless wrapper. A regression here would have the relayer reject calldata.

import { describe, it, expect } from 'vitest'
import { decodeFunctionData, slice } from 'viem'
import {
  buildGaslessShieldCalldata,
  GASLESS_SHIELD_WRAPPER_ABI,
} from './gasless-shield'
import type { ShieldRequestStruct } from './shield-intent'

const USER = '0x1111111111111111111111111111111111111111' as const
const TOKEN = '0x2222222222222222222222222222222222222222' as const
const INTEGRATOR = '0x3333333333333333333333333333333333333333' as const

function note(npk: string, value: bigint): ShieldRequestStruct {
  return {
    preimage: {
      npk: npk as `0x${string}`,
      token: { tokenType: 0, tokenAddress: TOKEN, tokenSubID: 0n },
      value,
    },
    ciphertext: {
      encryptedBundle: [
        ('0x' + '00'.repeat(32)) as `0x${string}`,
        ('0x' + '00'.repeat(32)) as `0x${string}`,
        ('0x' + '00'.repeat(32)) as `0x${string}`,
      ] as const,
      shieldKey: ('0x' + '00'.repeat(32)) as `0x${string}`,
    },
  }
}

function baseInput() {
  return {
    user: USER,
    deadline: 9_999_999_999n,
    nonce: 0n,
    integrator: INTEGRATOR,
    permitV: 27,
    permitR: ('0x' + 'a'.repeat(64)) as `0x${string}`,
    permitS: ('0x' + 'b'.repeat(64)) as `0x${string}`,
    intentSig: ('0x' + 'd'.repeat(130)) as `0x${string}`,
    shieldRequests: [note('0x' + 'c'.repeat(64), 10_000_000n), note('0x' + 'e'.repeat(64), 500_000n)],
  }
}

describe('buildGaslessShieldCalldata', () => {
  it('pins the gaslessShield selector', () => {
    // WHY: the relayer's gasless-fee-verifier.ts hardcodes GASLESS_SHIELD_SELECTOR. If this
    // builder's ABI shape drifts (arg reorder, struct rename) the selector changes and the relayer
    // rejects the calldata. Hardcoding here fails LOUDLY on drift rather than silently agreeing.
    const data = buildGaslessShieldCalldata(baseInput())
    expect(slice(data, 0, 4)).toBe('0x6e53fbcb')
  })

  it('round-trips through the viem decoder with all args intact', () => {
    // WHY: the wrapper binds keccak256(abi.encode(shieldRequests)) in the signed intent, so the
    // calldata's array must match exactly what was hashed. Round-trip-decode to surface any silent
    // corruption (arg shift, dropped note) at test time instead of an on-chain "bad intent sig".
    const input = baseInput()
    const data = buildGaslessShieldCalldata(input)

    const decoded = decodeFunctionData({ abi: GASLESS_SHIELD_WRAPPER_ABI, data })
    expect(decoded.functionName).toBe('gaslessShield')
    const [params, intentSig, requests] = decoded.args

    expect(params.user).toBe(input.user)
    expect(params.deadline).toBe(input.deadline)
    expect(params.nonce).toBe(input.nonce)
    expect(params.integrator).toBe(input.integrator)
    expect(params.permitV).toBe(input.permitV)
    expect(params.permitR).toBe(input.permitR)
    expect(params.permitS).toBe(input.permitS)
    expect(intentSig).toBe(input.intentSig)

    expect(requests.length).toBe(2)
    // User note (index 0) + relayer fee note (index 1) preserved with their npks + values.
    expect(requests[0].preimage.npk).toBe(input.shieldRequests[0].preimage.npk)
    expect(requests[0].preimage.value).toBe(10_000_000n)
    expect(requests[0].preimage.token.tokenType).toBe(0)
    expect(requests[0].preimage.token.tokenAddress).toBe(TOKEN)
    expect(requests[1].preimage.npk).toBe(input.shieldRequests[1].preimage.npk)
    expect(requests[1].preimage.value).toBe(500_000n)
  })

  it('supports a single-note (fee-sponsored) shield', () => {
    // WHY: a relayer may sponsor gas with no fee note — a one-element array must encode/decode
    // cleanly (the wrapper loops the array, no hardcoded length).
    const input = { ...baseInput(), shieldRequests: [note('0x' + 'c'.repeat(64), 10_000_000n)] }
    const decoded = decodeFunctionData({
      abi: GASLESS_SHIELD_WRAPPER_ABI,
      data: buildGaslessShieldCalldata(input),
    })
    expect(decoded.args[2].length).toBe(1)
    expect(decoded.args[2][0].preimage.value).toBe(10_000_000n)
  })
})
