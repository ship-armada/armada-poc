// ABOUTME: Tests for buildGaslessShieldCalldata — selector + arg-shape parity with the on-chain
// ABOUTME: wrapper. A regression here would have the relayer reject calldata as INVALID_DATA.

import { describe, it, expect } from 'vitest'
import { decodeFunctionData, encodeFunctionData, slice, zeroAddress } from 'viem'
import {
  buildGaslessShieldCalldata,
  GASLESS_SHIELD_WRAPPER_ABI,
} from './gasless-shield'

const USER = '0x1111111111111111111111111111111111111111' as const
const TOKEN = '0x2222222222222222222222222222222222222222' as const
const INTEGRATOR = '0x3333333333333333333333333333333333333333' as const

function baseRequest() {
  return {
    user: USER,
    totalAmount: 10_500_000n, // 10.5 USDC (10 shield + 0.5 fee)
    fee: 500_000n,
    deadline: 9_999_999_999n,
    v: 27,
    r: ('0x' + 'a'.repeat(64)) as `0x${string}`,
    s: ('0x' + 'b'.repeat(64)) as `0x${string}`,
    shieldRequest: {
      npk: ('0x' + 'c'.repeat(64)) as `0x${string}`,
      value: 10_000_000n,
      encryptedBundle: [
        ('0x' + '00'.repeat(32)) as `0x${string}`,
        ('0x' + '00'.repeat(32)) as `0x${string}`,
        ('0x' + '00'.repeat(32)) as `0x${string}`,
      ] as const,
      shieldKey: ('0x' + '00'.repeat(32)) as `0x${string}`,
    },
    tokenAddress: TOKEN,
    integrator: INTEGRATOR,
  }
}

describe('buildGaslessShieldCalldata', () => {
  it('pins the gaslessShield selector', () => {
    // WHY: the relayer's gasless-fee-verifier.ts hardcodes the gaslessShield selector
    // (`0x1de05794`, the first 4 bytes of keccak256("gaslessShield(address,uint256,uint256,
    // uint256,uint8,bytes32,bytes32,((bytes32,(uint8,address,uint256),uint120),(bytes32[3],
    // bytes32)),address)")). A wrapper-signature refactor (arg reorder, struct rename) would
    // change the selector and silently produce calldata the relayer rejects as INVALID_DATA.
    // Hardcoding rather than recomputing here so the test fails LOUDLY on drift instead of
    // silently agreeing with whatever the new shape became.
    const data = buildGaslessShieldCalldata(baseRequest())
    expect(slice(data, 0, 4)).toBe('0x1de05794')
  })

  it('round-trips through viem decoder with all args intact', () => {
    // WHY: the wrapper validates `preimage.value == totalAmount - fee` and rejects token/type
    // mismatches. If our builder ever shifts an arg position the on-chain contract will revert
    // — but only after gas is burned. Round-trip-decode the calldata so any silent corruption
    // surfaces at test time.
    const input = baseRequest()
    const data = buildGaslessShieldCalldata(input)

    const decoded = decodeFunctionData({
      abi: GASLESS_SHIELD_WRAPPER_ABI,
      data,
    })
    expect(decoded.functionName).toBe('gaslessShield')
    const args = decoded.args
    expect(args[0]).toBe(input.user)
    expect(args[1]).toBe(input.totalAmount)
    expect(args[2]).toBe(input.fee)
    expect(args[3]).toBe(input.deadline)
    expect(args[4]).toBe(input.v)
    expect(args[5]).toBe(input.r)
    expect(args[6]).toBe(input.s)
    expect(args[8]).toBe(input.integrator)

    const sr = args[7]
    expect(sr.preimage.npk).toBe(input.shieldRequest.npk)
    expect(sr.preimage.token.tokenType).toBe(0)
    expect(sr.preimage.token.tokenAddress).toBe(input.tokenAddress)
    expect(sr.preimage.token.tokenSubID).toBe(0n)
    // value must equal totalAmount - fee (wrapper-enforced); builder derives it that way so a
    // hand-typed shieldRequest.value can't get out of sync with the permit'd total.
    expect(sr.preimage.value).toBe(input.totalAmount - input.fee)
    expect(sr.ciphertext.shieldKey).toBe(input.shieldRequest.shieldKey)
  })

  it('derives shieldAmount from (totalAmount - fee), ignoring caller-supplied shieldRequest.value', () => {
    // WHY: the ShieldRequest the SDK produces ALSO has a `value` field. To make sure the on-chain
    // wrapper sees a consistent `preimage.value == totalAmount - fee` regardless of what the SDK
    // returned, the builder uses the (totalAmount - fee) math directly. A user passing a
    // mismatching shieldRequest.value (e.g. SDK rounded differently) wouldn't bypass the wrapper
    // check — this pins that we deliberately drop the caller's value.
    const input = baseRequest()
    input.shieldRequest.value = 12_345n // deliberately wrong
    const data = buildGaslessShieldCalldata(input)
    const decoded = decodeFunctionData({ abi: GASLESS_SHIELD_WRAPPER_ABI, data })
    const sr = decoded.args[7]
    expect(sr.preimage.value).toBe(input.totalAmount - input.fee) // 10_000_000n
  })

  it('handles zero integrator (no fee split)', () => {
    // WHY: address(0) is the canonical "no integrator" sentinel the pool accepts. Builder must
    // pass it through verbatim — defensive against a future zero-address rejection in viem.
    const input = { ...baseRequest(), integrator: zeroAddress }
    // Re-encode via viem directly (sanity that the helper's encoder reaches the same bytes).
    const expected = encodeFunctionData({
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
            token: { tokenType: 0, tokenAddress: input.tokenAddress, tokenSubID: 0n },
            value: input.totalAmount - input.fee,
          },
          ciphertext: {
            encryptedBundle: input.shieldRequest.encryptedBundle,
            shieldKey: input.shieldRequest.shieldKey,
          },
        },
        input.integrator,
      ],
    })
    expect(buildGaslessShieldCalldata(input)).toBe(expected)
  })
})
