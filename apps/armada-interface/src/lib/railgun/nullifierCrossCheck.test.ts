// ABOUTME: Tests for the WI-5 nullifier cross-check — the on-chain safety net that catches a watcher omitting a Nullified event.
// ABOUTME: Covers the pure omission-detection logic + the wired check's happy paths and fail-open-on-error behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  walletForID: vi.fn(),
  getNetworkConfig: vi.fn(),
  loadDeployments: vi.fn(),
  timeoutProvider: vi.fn(() => ({})),
  contractInstance: { nullifiers: vi.fn() },
  ContractCtor: vi.fn(),
  aggregate3: vi.fn(),
  trackError: vi.fn(),
}))

vi.mock('@railgun-community/wallet', () => ({ walletForID: hoisted.walletForID }))
vi.mock('@railgun-community/shared-models', () => ({
  TXIDVersion: { V2_PoseidonMerkle: 'V2_PoseidonMerkle' },
}))
vi.mock('ethers', () => ({
  ethers: {
    Contract: class {
      constructor(...args: unknown[]) {
        hoisted.ContractCtor(...args)
        return hoisted.contractInstance
      }
    },
  },
}))
vi.mock('@/config/network', () => ({ getNetworkConfig: hoisted.getNetworkConfig }))
vi.mock('@/config/deployments', () => ({ loadDeployments: hoisted.loadDeployments }))
vi.mock('@/lib/multicall3', () => ({ aggregate3: hoisted.aggregate3 }))
vi.mock('./network', () => ({
  timeoutProvider: hoisted.timeoutProvider,
  getHubChainDescriptor: () => ({ type: 0, id: 31337 }),
}))
vi.mock('@/lib/telemetry', () => ({ trackError: hoisted.trackError }))

import {
  detectOmittedNullifiers,
  getOwnUnspentNotes,
  checkOwnNullifiersOnChain,
  toNullifierBytes32,
} from './nullifierCrossCheck'

function txo(overrides: Record<string, unknown>) {
  return { tree: 0, position: 0, nullifier: '0xnf', spendtxid: false as string | false, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.getNetworkConfig.mockReturnValue({ hub: { chainId: 31337, rpcUrls: ['http://localhost:8545'] } })
  hoisted.loadDeployments.mockResolvedValue({ hub: { contracts: { privacyPool: '0xpool' } } })
})

describe('detectOmittedNullifiers (pure)', () => {
  // Batch checker: returns one flag per note (in order), looked up by `${tree}:${nullifier}`.
  const spentBatch =
    (map: Record<string, boolean>) =>
    async (notes: readonly { tree: number; nullifier: string }[]) =>
      notes.map((n) => map[`${n.tree}:${n.nullifier}`] ?? false)

  it('reports no omission for an empty note set', async () => {
    const r = await detectOmittedNullifiers([], spentBatch({}))
    expect(r).toEqual({ checked: 0, omissionDetected: false })
  })

  it('reports ok when every own unspent note is also unspent on-chain', async () => {
    const notes = [
      { tree: 0, nullifier: '0xa' },
      { tree: 1, nullifier: '0xb' },
    ]
    const r = await detectOmittedNullifiers(notes, spentBatch({}))
    expect(r).toEqual({ checked: 2, omissionDetected: false })
  })

  it('detects an omission when the chain marks an own "unspent" note as spent', async () => {
    const notes = [
      { tree: 0, nullifier: '0xa' },
      { tree: 1, nullifier: '0xb' },
    ]
    const r = await detectOmittedNullifiers(notes, spentBatch({ '1:0xb': true }))
    expect(r).toEqual({ checked: 2, omissionDetected: true })
  })

  it('short-circuits (no batch call) for an empty note set', async () => {
    const checker = vi.fn(async () => [])
    await detectOmittedNullifiers([], checker)
    expect(checker).not.toHaveBeenCalled()
  })
})

describe('getOwnUnspentNotes', () => {
  it('returns only locally-unspent notes as {tree, nullifier}', async () => {
    hoisted.walletForID.mockReturnValue({
      TXOs: vi.fn(async () => [
        txo({ tree: 0, nullifier: '0xunspent', spendtxid: false }),
        txo({ tree: 0, nullifier: '0xspent', spendtxid: '0xsometx' }),
        txo({ tree: 2, nullifier: '0xunspent2', spendtxid: false }),
      ]),
    })

    const notes = await getOwnUnspentNotes('wallet-1')
    expect(notes).toEqual([
      { tree: 0, nullifier: '0xunspent' },
      { tree: 2, nullifier: '0xunspent2' },
    ])
  })
})

describe('toNullifierBytes32', () => {
  it('0x-prefixes the engine\'s unprefixed 32-byte nullifier hex', () => {
    const raw = 'ab'.repeat(32) // 64 hex chars, no 0x — exactly what the engine hands us
    expect(toNullifierBytes32(raw)).toBe(`0x${raw}`)
  })

  it('left-pads a short (leading-zero-trimmed) value to 32 bytes', () => {
    expect(toNullifierBytes32('5f4caf43')).toBe(`0x${'5f4caf43'.padStart(64, '0')}`)
  })

  it('is idempotent on an already-prefixed value', () => {
    const v = `0x${'cd'.repeat(32)}`
    expect(toNullifierBytes32(v)).toBe(v)
  })
})

describe('checkOwnNullifiersOnChain (wired)', () => {
  it('flags omission-detected and batches a 0x-prefixed bytes32 into one aggregate3 call', async () => {
    // The engine yields the nullifier UNPREFIXED; the wired check must normalize it before the
    // ethers encode, else ethers throws "invalid BytesLike value" (the WI-5 fail-open regression).
    const rawNullifier = 'ab'.repeat(32)
    hoisted.walletForID.mockReturnValue({
      TXOs: vi.fn(async () => [txo({ tree: 0, nullifier: rawNullifier, spendtxid: false })]),
    })
    hoisted.aggregate3.mockResolvedValue([{ success: true, result: [true] }]) // chain says spent

    const r = await checkOwnNullifiersOnChain('wallet-1')
    expect(r.omissionDetected).toBe(true)
    // One aggregate3 batch, one call per note, with the normalized bytes32 arg.
    expect(hoisted.aggregate3).toHaveBeenCalledTimes(1)
    const [, calls] = hoisted.aggregate3.mock.calls[0]
    expect(calls).toEqual([
      { contract: hoisted.contractInstance, functionName: 'nullifiers', args: [0, `0x${rawNullifier}`] },
    ])
    // Multicall collapses the fan-out to a single eth_call, so batching no longer needs disabling.
    expect(hoisted.timeoutProvider).toHaveBeenCalledWith(expect.any(String))
  })

  it('batches every unspent note into a single aggregate3 call', async () => {
    hoisted.walletForID.mockReturnValue({
      TXOs: vi.fn(async () => [
        txo({ tree: 0, nullifier: '0xa', spendtxid: false }),
        txo({ tree: 1, nullifier: '0xb', spendtxid: false }),
        txo({ tree: 2, nullifier: '0xc', spendtxid: false }),
      ]),
    })
    hoisted.aggregate3.mockResolvedValue([
      { success: true, result: [false] },
      { success: true, result: [false] },
      { success: true, result: [false] },
    ])

    const r = await checkOwnNullifiersOnChain('wallet-1')
    expect(r).toEqual({ checked: 3, omissionDetected: false })
    expect(hoisted.aggregate3).toHaveBeenCalledTimes(1)
    const [, calls] = hoisted.aggregate3.mock.calls[0]
    expect(calls).toHaveLength(3)
  })

  it('returns ok when the chain agrees the notes are unspent', async () => {
    hoisted.walletForID.mockReturnValue({
      TXOs: vi.fn(async () => [txo({ tree: 0, nullifier: '0xa', spendtxid: false })]),
    })
    hoisted.aggregate3.mockResolvedValue([{ success: true, result: [false] }])

    const r = await checkOwnNullifiersOnChain('wallet-1')
    expect(r).toEqual({ checked: 1, omissionDetected: false })
  })

  it('treats an unreadable sub-call as not-spent (fail-open per note)', async () => {
    hoisted.walletForID.mockReturnValue({
      TXOs: vi.fn(async () => [
        txo({ tree: 0, nullifier: '0xa', spendtxid: false }),
        txo({ tree: 1, nullifier: '0xb', spendtxid: false }),
      ]),
    })
    // First note unreadable (success:false), second reads unspent → no omission flagged.
    hoisted.aggregate3.mockResolvedValue([
      { success: false, result: undefined },
      { success: true, result: [false] },
    ])

    const r = await checkOwnNullifiersOnChain('wallet-1')
    expect(r).toEqual({ checked: 2, omissionDetected: false })
  })

  it('short-circuits (no RPC) when the wallet has no unspent notes', async () => {
    hoisted.walletForID.mockReturnValue({ TXOs: vi.fn(async () => []) })

    const r = await checkOwnNullifiersOnChain('wallet-1')
    expect(r).toEqual({ checked: 0, omissionDetected: false })
    expect(hoisted.aggregate3).not.toHaveBeenCalled()
  })

  it('fails open (no false block) and logs when the on-chain query errors', async () => {
    hoisted.walletForID.mockReturnValue({
      TXOs: vi.fn(async () => [txo({ tree: 0, nullifier: '0xa', spendtxid: false })]),
    })
    hoisted.aggregate3.mockRejectedValue(new Error('rpc down'))

    const r = await checkOwnNullifiersOnChain('wallet-1')
    expect(r.omissionDetected).toBe(false)
    expect(hoisted.trackError).toHaveBeenCalled()
  })
})
