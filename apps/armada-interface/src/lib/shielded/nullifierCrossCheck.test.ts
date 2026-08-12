// ABOUTME: Tests for the WI-5 nullifier cross-check — the on-chain safety net that catches a watcher omitting a Nullified event.
// ABOUTME: Covers the pure omission-detection logic + the wired check's happy paths and fail-open-on-error behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  getSdkWallet: vi.fn(),
  getNetworkConfig: vi.fn(),
  loadDeployments: vi.fn(),
  timeoutProvider: vi.fn(() => ({})),
  contractInstance: { nullifiers: vi.fn() },
  ContractCtor: vi.fn(),
  aggregate3: vi.fn(),
  trackError: vi.fn(),
}))

// The cross-check now reads the wallet's spendable notes' (tree, nullifier) from @armada/sdk.
vi.mock('./sdk-read', () => ({ getSdkWallet: hoisted.getSdkWallet }))
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
vi.mock('./network', () => ({ timeoutProvider: hoisted.timeoutProvider }))
vi.mock('@/lib/telemetry', () => ({ trackError: hoisted.trackError }))

import {
  detectOmittedNullifiers,
  getOwnUnspentNotes,
  checkOwnNullifiersOnChain,
  toNullifierBytes32,
} from './nullifierCrossCheck'

/** Stub the SDK wallet's `spendableNullifiers()` — the read the cross-check consumes. */
function mockSpendable(refs: { tree: number; nullifier: bigint }[]): void {
  hoisted.getSdkWallet.mockResolvedValue({ spendableNullifiers: () => refs })
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
  it('maps the SDK\'s spendable (tree, nullifier) refs to {tree, nullifier-hex}', async () => {
    // spendableNullifiers is already unspent-filtered by the SDK; the nullifier is a field bigint.
    mockSpendable([
      { tree: 0, nullifier: 0xdeadn },
      { tree: 2, nullifier: 0xbeefn },
    ])
    const notes = await getOwnUnspentNotes()
    expect(notes).toEqual([
      { tree: 0, nullifier: (0xdeadn).toString(16) },
      { tree: 2, nullifier: (0xbeefn).toString(16) },
    ])
  })
})

describe('toNullifierBytes32', () => {
  it('0x-prefixes an unprefixed 32-byte nullifier hex', () => {
    const raw = 'ab'.repeat(32) // 64 hex chars, no 0x
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
    // The SDK yields the nullifier as a field bigint; the wired check renders + normalizes it to a
    // 0x-prefixed bytes32 before the ethers encode, else ethers throws "invalid BytesLike value".
    const rawNullifier = 'ab'.repeat(32)
    mockSpendable([{ tree: 0, nullifier: BigInt(`0x${rawNullifier}`) }])
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
    mockSpendable([
      { tree: 0, nullifier: 0xan },
      { tree: 1, nullifier: 0xbn },
      { tree: 2, nullifier: 0xcn },
    ])
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
    mockSpendable([{ tree: 0, nullifier: 0xan }])
    hoisted.aggregate3.mockResolvedValue([{ success: true, result: [false] }])

    const r = await checkOwnNullifiersOnChain('wallet-1')
    expect(r).toEqual({ checked: 1, omissionDetected: false })
  })

  it('treats an unreadable sub-call as not-spent (fail-open per note)', async () => {
    mockSpendable([
      { tree: 0, nullifier: 0xan },
      { tree: 1, nullifier: 0xbn },
    ])
    // First note unreadable (success:false), second reads unspent → no omission flagged.
    hoisted.aggregate3.mockResolvedValue([
      { success: false, result: undefined },
      { success: true, result: [false] },
    ])

    const r = await checkOwnNullifiersOnChain('wallet-1')
    expect(r).toEqual({ checked: 2, omissionDetected: false })
  })

  it('short-circuits (no RPC) when the wallet has no unspent notes', async () => {
    mockSpendable([])

    const r = await checkOwnNullifiersOnChain('wallet-1')
    expect(r).toEqual({ checked: 0, omissionDetected: false })
    expect(hoisted.aggregate3).not.toHaveBeenCalled()
  })

  it('fails open (no false block) and logs when the on-chain query errors', async () => {
    mockSpendable([{ tree: 0, nullifier: 0xan }])
    hoisted.aggregate3.mockRejectedValue(new Error('rpc down'))

    const r = await checkOwnNullifiersOnChain('wallet-1')
    expect(r.omissionDetected).toBe(false)
    expect(hoisted.trackError).toHaveBeenCalled()
  })
})
