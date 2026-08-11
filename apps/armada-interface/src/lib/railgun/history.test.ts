// ABOUTME: Unit tests for the @armada/sdk history adapter — synthetic-id encoding + historyEntryToTxRecord category mapping.
// ABOUTME: Hand-rolls HistoryEntry fixtures so no @railgun-community runtime is touched.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HistoryEntry } from '@armada/sdk'

// Mock the two runtime deps of runHistoryScan so it can be unit-tested without an SDK/RPC. The
// pure mapper + id tests below don't touch these.
const hoisted = vi.hoisted(() => ({
  readSdkHistory: vi.fn(async (): Promise<HistoryEntry[]> => []),
  getHubBlockTimestamps: vi.fn(async () => new Map<number, number>()),
}))
vi.mock('./sdk-read', () => ({ readSdkHistory: hoisted.readSdkHistory }))
vi.mock('./network', () => ({ getHubBlockTimestamps: hoisted.getHubBlockTimestamps }))

import { historyEntryToTxRecord, isSyntheticTxId, runHistoryScan, syntheticTxId } from './history'

describe('syntheticTxId / isSyntheticTxId', () => {
  it('encodes txid + category', () => {
    // WHY: the id is the idempotency key for OCC. Two scans seeing the same txid+category
    // produce the same id, so re-runs are no-ops at the storage layer.
    expect(syntheticTxId('abc', 'ShieldERC20s')).toBe('synth:abc:ShieldERC20s')
  })
  it('distinguishes synthetic from authored ids', () => {
    // WHY: future code (incoming-transfer detector, UI affordances) needs a cheap classifier
    // to tell "I authored this" (ulid) from "recovered from chain" (synth:*).
    expect(isSyntheticTxId(syntheticTxId('abc', 'ShieldERC20s'))).toBe(true)
    expect(isSyntheticTxId('01J5XYZULID0001')).toBe(false)
  })
})

const SDK_CTX = { hubChainId: 31337 }
const sdkEntry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  txid: '0xabc',
  blockNumber: 100,
  category: 'shield',
  tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  value: 1_000_000n,
  ...over,
})

describe('historyEntryToTxRecord (@armada/sdk read path)', () => {
  it('shield → shield, amount includes the shield fee', () => {
    const r = historyEntryToTxRecord(sdkEntry({ category: 'shield', value: 995_000n, shieldFee: 5_000n }), 'w', SDK_CTX, 5000)
    expect(r).toMatchObject({ kind: 'shield', id: 'synth:0xabc:shield', createdAt: 5000, meta: { amount: 1_000_000n } })
  })

  it('transfer-sent → transfer-shielded, recipient + broadcaster fee split from sentOutputs', () => {
    const r = historyEntryToTxRecord(
      sdkEntry({ category: 'transfer-sent', value: -500_000n, broadcasterFee: 20_000n, sentOutputs: [{ recipientRailgunAddress: '0zk_bob', value: 480_000n }] }),
      'w', SDK_CTX, 5000,
    )
    expect(r).toMatchObject({ kind: 'transfer-shielded', meta: { amount: 480_000n, broadcasterFeeAmount: 20_000n, recipient: '0zk_bob' } })
  })

  it('transfer-received → received, memo passed through', () => {
    const r = historyEntryToTxRecord(sdkEntry({ category: 'transfer-received', value: 250_000n, memo: 'hi' }), 'w', SDK_CTX, 5000)
    expect(r).toMatchObject({ kind: 'transfer-shielded-received', meta: { amount: 250_000n, memoText: 'hi' } })
  })

  it('unshield → unshield-local, recipient + net amount (minus fees)', () => {
    const r = historyEntryToTxRecord(sdkEntry({ category: 'unshield', value: -500_000n, broadcasterFee: 10_000n, unshieldFee: 2_500n, recipient: '0xrecipient' }), 'w', SDK_CTX, 5000)
    expect(r).toMatchObject({ kind: 'unshield-local', meta: { amount: 487_500n, recipient: '0xrecipient', broadcasterFeeAmount: 10_000n } })
  })

  it('yield deposit + withdraw map natively (no adapter heuristic)', () => {
    expect(historyEntryToTxRecord(sdkEntry({ category: 'yield-deposit', value: -900_000n }), 'w', SDK_CTX, 5000)).toMatchObject({ kind: 'yield-deposit', meta: { amount: 900_000n } })
    expect(historyEntryToTxRecord(sdkEntry({ category: 'yield-withdraw', value: 950_000n }), 'w', SDK_CTX, 5000)).toMatchObject({ kind: 'yield-withdraw', meta: { amount: 950_000n } })
  })

  it('stamps walletContext: railgunWalletId + hub chain, undefined evmAddress', () => {
    // WHY: TxWalletContext allows undefined evmAddress for shielded-only ops. We don't fabricate an
    // EVM binding for historical records because the user may have switched EVMs since.
    const r = historyEntryToTxRecord(sdkEntry({ category: 'shield' }), 'w', SDK_CTX, 5000)
    expect(r!.walletContext).toEqual({ evmAddress: undefined, railgunWalletId: 'w', sourceChainId: 31337 })
  })
})

describe('runHistoryScan (@armada/sdk scan)', () => {
  beforeEach(() => {
    hoisted.readSdkHistory.mockReset()
    hoisted.getHubBlockTimestamps.mockReset()
    hoisted.getHubBlockTimestamps.mockResolvedValue(new Map())
  })

  it('maps entries, backfills block timestamps, and reports the highest block as the checkpoint', async () => {
    // WHY: the checkpoint must be the MAX block seen (the resume point); a min/first bug silently
    // skips rows on the next incremental scan. Timestamps come from a bulk block lookup because the
    // SDK doesn't stamp every chain — without it rows render the Unix epoch ("Dec 31, 1969").
    hoisted.readSdkHistory.mockResolvedValue([
      sdkEntry({ txid: 'a', blockNumber: 100_001, value: 1n }),
      sdkEntry({ txid: 'b', blockNumber: 100_005, value: 2n }),
      sdkEntry({ txid: 'c', blockNumber: 100_003, value: 3n }),
    ])
    hoisted.getHubBlockTimestamps.mockResolvedValue(new Map([
      [100_001, 1_700_000_000],
      [100_005, 1_700_000_300],
      [100_003, 1_700_000_150],
    ]))
    const result = await runHistoryScan('w', SDK_CTX, 100_000)
    expect(hoisted.readSdkHistory).toHaveBeenCalledWith(100_000)
    expect(result.highestBlock).toBe(100_005)
    expect(result.itemCount).toBe(3)
    // Sorted by updatedAt (=timestamp) descending, so the latest-block row is first.
    expect(result.records.map(r => r.createdAt)).toEqual([
      1_700_000_300_000, 1_700_000_150_000, 1_700_000_000_000,
    ])
  })

  it('leaves createdAt at 0 for entries whose block timestamp is unavailable (graceful degrade)', async () => {
    // WHY: a flaky RPC shouldn't crash the scan — the row still renders, just sorted to the bottom
    // with the epoch default. Strictly better than failing the whole recovery for the user.
    hoisted.readSdkHistory.mockResolvedValue([sdkEntry({ txid: 'a', blockNumber: 100_001, value: 1n })])
    hoisted.getHubBlockTimestamps.mockResolvedValue(new Map())
    const result = await runHistoryScan('w', SDK_CTX, undefined)
    expect(result.records[0]!.createdAt).toBe(0)
  })

  it('skips the block-timestamp lookup entirely when the scan is empty', async () => {
    // WHY: no entries → no blocks → no reason to pay for an RPC round-trip.
    hoisted.readSdkHistory.mockResolvedValue([])
    const result = await runHistoryScan('w', SDK_CTX, undefined)
    expect(hoisted.getHubBlockTimestamps).not.toHaveBeenCalled()
    expect(result).toEqual({ records: [], highestBlock: null, itemCount: 0 })
  })
})
