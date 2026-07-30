// ABOUTME: Tests for the Multicall3 aggregate3 helper — encoding, decoding, and partial-failure handling.
// ABOUTME: Uses a fake provider whose `call` returns a precomputed aggregate3 response.

import { describe, it, expect, vi } from 'vitest'
import { Contract, Interface, type JsonRpcProvider } from 'ethers'
import { aggregate3, getMulticall3Contract, MULTICALL3_ADDRESS } from './multicall3'

const TEST_ABI = [
  'function phase() view returns (uint256)',
  'function flag() view returns (bool)',
  'function pair() view returns (uint256 a, uint256 b)',
]

const MC_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
]
const mcIface = new Interface(MC_ABI)

const contract = new Contract('0x' + '1'.repeat(40), TEST_ABI)

function providerReturning(raw: string): JsonRpcProvider {
  return { call: vi.fn().mockResolvedValue(raw) } as unknown as JsonRpcProvider
}

// Encode an aggregate3 response from [success, returnData] tuples.
function encodeAggregate3Return(rows: Array<[boolean, string]>): string {
  return mcIface.encodeFunctionResult('aggregate3', [rows])
}

describe('aggregate3', () => {
  it('decodes successful sub-calls', async () => {
    const raw = encodeAggregate3Return([
      [true, contract.interface.encodeFunctionResult('phase', [5n])],
      [true, contract.interface.encodeFunctionResult('flag', [true])],
    ])
    const provider = providerReturning(raw)

    const results = await aggregate3(provider, [
      { contract, functionName: 'phase' },
      { contract, functionName: 'flag' },
    ])

    expect(results[0]?.success).toBe(true)
    expect(results[0]?.result?.[0]).toBe(5n)
    expect(results[1]?.success).toBe(true)
    expect(results[1]?.result?.[0]).toBe(true)
  })

  it('marks a failed sub-call as unsuccessful with undefined result', async () => {
    const raw = encodeAggregate3Return([
      [true, contract.interface.encodeFunctionResult('phase', [9n])],
      [false, '0x'],
    ])
    const provider = providerReturning(raw)

    const results = await aggregate3(provider, [
      { contract, functionName: 'phase' },
      { contract, functionName: 'flag' },
    ])

    expect(results[0]?.success).toBe(true)
    expect(results[0]?.result?.[0]).toBe(9n)
    expect(results[1]?.success).toBe(false)
    expect(results[1]?.result).toBeUndefined()
  })

  it('decodes multi-return tuples by name', async () => {
    const raw = encodeAggregate3Return([
      [true, contract.interface.encodeFunctionResult('pair', [3n, 4n])],
    ])
    const provider = providerReturning(raw)

    const results = await aggregate3(provider, [{ contract, functionName: 'pair' }])
    expect(results[0]?.result?.a).toBe(3n)
    expect(results[0]?.result?.b).toBe(4n)
  })

  it('targets the canonical Multicall3 address with one eth_call', async () => {
    const raw = encodeAggregate3Return([[true, contract.interface.encodeFunctionResult('phase', [1n])]])
    const provider = providerReturning(raw)
    await aggregate3(provider, [{ contract, functionName: 'phase' }])

    const call = (provider.call as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.to).toBe(MULTICALL3_ADDRESS)
    expect((provider.call as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('propagates a provider/RPC failure (throws)', async () => {
    const provider = { call: vi.fn().mockRejectedValue(new Error('RPC down')) } as unknown as JsonRpcProvider
    await expect(aggregate3(provider, [{ contract, functionName: 'phase' }])).rejects.toThrow('RPC down')
  })

  it('getMulticall3Contract exposes getCurrentBlockTimestamp for timestamp folding', () => {
    const mc = getMulticall3Contract(providerReturning('0x'))
    expect(mc.interface.getFunction('getCurrentBlockTimestamp')).toBeTruthy()
    expect(mc.target).toBe(MULTICALL3_ADDRESS)
  })
})
