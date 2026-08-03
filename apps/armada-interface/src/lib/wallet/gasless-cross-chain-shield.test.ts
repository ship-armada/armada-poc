// ABOUTME: Tests for buildGaslessCrossChainShieldCalldata — selector + arg-shape parity with the
// ABOUTME: on-chain GaslessShieldWrapperClient. Regression here surfaces as relayer INVALID_DATA.

import { describe, it, expect } from 'vitest'
import { decodeFunctionData, slice } from 'viem'
import {
  buildGaslessCrossChainShieldCalldata,
  GASLESS_CROSS_CHAIN_SHIELD_WRAPPER_ABI,
} from './gasless-cross-chain-shield'
import type { ShieldDataStruct } from './shield-intent'

const USER = '0x1111111111111111111111111111111111111111' as const
const INTEGRATOR = '0x3333333333333333333333333333333333333333' as const
const ZERO = '0x0000000000000000000000000000000000000000' as const

function note(npk: string, value: bigint, integrator: `0x${string}`): ShieldDataStruct {
  return {
    npk: npk as `0x${string}`,
    value,
    encryptedBundle: [
      ('0x' + '00'.repeat(32)) as `0x${string}`,
      ('0x' + '00'.repeat(32)) as `0x${string}`,
      ('0x' + '00'.repeat(32)) as `0x${string}`,
    ] as const,
    shieldKey: ('0x' + '00'.repeat(32)) as `0x${string}`,
    integrator,
  }
}

function baseInput() {
  return {
    user: USER,
    deadline: 9_999_999_999n,
    nonce: 0n,
    maxFee: 1000n,
    minFinalityThreshold: 1000,
    permitV: 27,
    permitR: ('0x' + 'a'.repeat(64)) as `0x${string}`,
    permitS: ('0x' + 'b'.repeat(64)) as `0x${string}`,
    intentSig: ('0x' + 'd'.repeat(130)) as `0x${string}`,
    userNote: note('0x' + 'c'.repeat(64), 10_000_000n, INTEGRATOR),
    feeNote: note('0x' + 'e'.repeat(64), 500_000n, ZERO),
  }
}

describe('buildGaslessCrossChainShieldCalldata', () => {
  it('pins the gaslessCrossChainShield selector', () => {
    // WHY: the relayer's GASLESS_CROSS_CHAIN_SHIELD_SELECTOR must match. Hardcoding fails loudly on
    // any ABI-shape drift rather than silently producing calldata the relayer rejects.
    const data = buildGaslessCrossChainShieldCalldata(baseInput())
    expect(slice(data, 0, 4)).toBe('0xd34e1968')
  })

  it('round-trips through the viem decoder with all args intact', () => {
    // WHY: the intent binds keccak256(abi.encode(userNote)) + keccak256(abi.encode(feeNote)) + the
    // CCTP params, so the calldata must carry exactly those. Round-trip-decode to surface silent
    // corruption at test time rather than an on-chain "bad intent sig".
    const input = baseInput()
    const data = buildGaslessCrossChainShieldCalldata(input)

    const decoded = decodeFunctionData({ abi: GASLESS_CROSS_CHAIN_SHIELD_WRAPPER_ABI, data })
    expect(decoded.functionName).toBe('gaslessCrossChainShield')
    const [params, intentSig, userNote, feeNote] = decoded.args

    expect(params.user).toBe(input.user)
    expect(params.deadline).toBe(input.deadline)
    expect(params.nonce).toBe(input.nonce)
    expect(params.maxFee).toBe(input.maxFee)
    expect(params.minFinalityThreshold).toBe(input.minFinalityThreshold)
    expect(params.permitV).toBe(input.permitV)
    expect(intentSig).toBe(input.intentSig)

    expect(userNote.npk).toBe(input.userNote.npk)
    expect(userNote.value).toBe(10_000_000n)
    expect(userNote.integrator).toBe(INTEGRATOR)
    expect(feeNote.npk).toBe(input.feeNote.npk)
    expect(feeNote.value).toBe(500_000n)
  })
})
