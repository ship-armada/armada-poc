// ABOUTME: Tests for buildGaslessCrossChainShieldCalldata — selector + arg-shape parity with the
// ABOUTME: on-chain GaslessShieldWrapperClient. Regression here surfaces as relayer INVALID_DATA.

import { describe, it, expect } from 'vitest'
import { decodeFunctionData, slice } from 'viem'
import {
  buildGaslessCrossChainShieldCalldata,
  GASLESS_CROSS_CHAIN_SHIELD_WRAPPER_ABI,
} from './gasless-cross-chain-shield'

const USER = '0x1111111111111111111111111111111111111111' as const
const INTEGRATOR = '0x2222222222222222222222222222222222222222' as const

function baseRequest() {
  return {
    user: USER,
    totalAmount: 10_500_000n, // 10.5 USDC (10 shield + 0.5 fee)
    fee: 500_000n,
    deadline: 9_999_999_999n,
    v: 28,
    r: ('0x' + 'a'.repeat(64)) as `0x${string}`,
    s: ('0x' + 'b'.repeat(64)) as `0x${string}`,
    maxFee: 100_000n,
    minFinalityThreshold: 1000,
    shieldRequest: {
      npk: ('0x' + 'c'.repeat(64)) as `0x${string}`,
      value: 10_000_000n,
      encryptedBundle: [
        ('0x' + '11'.repeat(32)) as `0x${string}`,
        ('0x' + '22'.repeat(32)) as `0x${string}`,
        ('0x' + '33'.repeat(32)) as `0x${string}`,
      ] as const,
      shieldKey: ('0x' + '44'.repeat(32)) as `0x${string}`,
    },
    integrator: INTEGRATOR,
  }
}

describe('buildGaslessCrossChainShieldCalldata', () => {
  it('pins the gaslessCrossChainShield selector', () => {
    // WHY: the relayer's gasless-fee-verifier.ts hardcodes the gaslessCrossChainShield selector
    // (`0x742d0b54`, the first 4 bytes of keccak256("gaslessCrossChainShield((address,uint256,
    // uint256,uint256,uint8,bytes32,bytes32),(uint256,uint32,bytes32,bytes32[3],bytes32,
    // address))")). A wrapper-signature refactor (arg reorder, struct rename) would change the
    // selector and silently produce calldata the relayer rejects as INVALID_DATA. Hardcoding
    // rather than recomputing so the test fails LOUDLY on drift instead of silently agreeing with
    // whatever the new shape became. (destinationCaller was removed per issue #64 — pinned on-chain.)
    const data = buildGaslessCrossChainShieldCalldata(baseRequest())
    expect(slice(data, 0, 4)).toBe('0x742d0b54')
  })

  it('round-trips through viem decoder with all PermitInput + CrossChainParams args intact', () => {
    // WHY: a position shift inside either tuple would silently corrupt the wrapper's permit
    // verification or the CCTP destination context (npk, ciphertext bundle, finality
    // threshold). Round-trip decode pins every arg as a defensive layer above the viem ABI
    // encoder so a future encoder-version bump doesn't reshape outputs unnoticed.
    const input = baseRequest()
    const data = buildGaslessCrossChainShieldCalldata(input)

    const decoded = decodeFunctionData({
      abi: GASLESS_CROSS_CHAIN_SHIELD_WRAPPER_ABI,
      data,
    })
    expect(decoded.functionName).toBe('gaslessCrossChainShield')
    const [permitInput, dest] = decoded.args
    expect(permitInput.user).toBe(input.user)
    expect(permitInput.totalAmount).toBe(input.totalAmount)
    expect(permitInput.fee).toBe(input.fee)
    expect(permitInput.deadline).toBe(input.deadline)
    expect(permitInput.v).toBe(input.v)
    expect(permitInput.r).toBe(input.r)
    expect(permitInput.s).toBe(input.s)

    expect(dest.maxFee).toBe(input.maxFee)
    expect(dest.minFinalityThreshold).toBe(input.minFinalityThreshold)
    expect(dest.npk).toBe(input.shieldRequest.npk)
    expect(dest.encryptedBundle).toEqual(input.shieldRequest.encryptedBundle)
    expect(dest.shieldKey).toBe(input.shieldRequest.shieldKey)
    expect(dest.integrator).toBe(input.integrator)
  })

  it('standard finality threshold (0) encodes cleanly', () => {
    // WHY: minFinalityThreshold 0 is the STANDARD default (the contract resolves 0 → STANDARD).
    // Pin that the builder encodes the zero value cleanly rather than rejecting it.
    const input = {
      ...baseRequest(),
      minFinalityThreshold: 0,
    }
    const data = buildGaslessCrossChainShieldCalldata(input)
    const decoded = decodeFunctionData({
      abi: GASLESS_CROSS_CHAIN_SHIELD_WRAPPER_ABI,
      data,
    })
    const [, dest] = decoded.args
    expect(dest.minFinalityThreshold).toBe(0)
  })
})
