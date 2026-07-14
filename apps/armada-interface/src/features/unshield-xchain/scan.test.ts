// ABOUTME: Tests for scanCctpDeliveryWindow — verifies per-tick window cap, cursor advance, no-new-blocks short-circuit, and match detection.

import { describe, it, expect, vi } from 'vitest'
import { scanCctpDeliveryWindow, matchesXchainDelivery } from './scan'

describe('matchesXchainDelivery (T-M7)', () => {
  const marker = 'abc123' // per-tx uniqueNonce hex tail, lowercase (issue #287)
  const expected = { marker, sourceDomain: 100 }

  it('matches when the uniqueNonce marker is in the body AND the source domain is the hub', () => {
    expect(matchesXchainDelivery({ messageBody: `0xdeadABC123beef`, sourceDomain: 100 }, expected)).toBe(true)
  })

  it('rejects a transfer from a DIFFERENT source domain', () => {
    expect(matchesXchainDelivery({ messageBody: `0xdeadabc123beef`, sourceDomain: 6 }, expected)).toBe(false)
  })

  it('rejects when the uniqueNonce marker is absent even if the source domain matches', () => {
    expect(matchesXchainDelivery({ messageBody: `0xdeadbeef`, sourceDomain: 100 }, expected)).toBe(false)
  })

  it('handles bigint source domains and missing/non-string bodies', () => {
    expect(matchesXchainDelivery({ messageBody: `0xABC123`, sourceDomain: 100n }, expected)).toBe(true)
    expect(matchesXchainDelivery({ messageBody: undefined, sourceDomain: 100 }, expected)).toBe(false)
  })
})

function makeFakes(opts: {
  latest: bigint
  matchAtBlock?: bigint
  matchTxHash?: `0x${string}`
}): {
  getBlockNumber: () => Promise<bigint>
  getLogsForRange: (from: bigint, to: bigint) => Promise<Array<{ transactionHash: `0x${string}` }>>
  calls: Array<{ from: bigint; to: bigint }>
} {
  const calls: Array<{ from: bigint; to: bigint }> = []
  return {
    getBlockNumber: async () => opts.latest,
    getLogsForRange: vi.fn(async (fromBlock: bigint, toBlock: bigint) => {
      calls.push({ from: fromBlock, to: toBlock })
      if (
        opts.matchAtBlock !== undefined &&
        opts.matchAtBlock >= fromBlock &&
        opts.matchAtBlock <= toBlock
      ) {
        return [{ transactionHash: opts.matchTxHash ?? ('0xdead' as `0x${string}`) }]
      }
      return []
    }),
    calls,
  }
}

describe('scanCctpDeliveryWindow', () => {
  it('caps the per-tick window to maxLogRange blocks', async () => {
    const { getBlockNumber, getLogsForRange, calls } = makeFakes({ latest: 1_000_000n })

    const out = await scanCctpDeliveryWindow({
      getBlockNumber, getLogsForRange, scanFromBlock: 100n, maxLogRange: 5_000n,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ from: 100n, to: 5_099n })
    expect(out).toEqual({ kind: 'no-match', nextScanFromBlock: 5_100n, scannedTo: 5_099n })
  })

  it('clamps the window to latest when fewer than maxLogRange new blocks exist', async () => {
    const { getBlockNumber, getLogsForRange, calls } = makeFakes({ latest: 250n })

    const out = await scanCctpDeliveryWindow({
      getBlockNumber, getLogsForRange, scanFromBlock: 100n, maxLogRange: 5_000n,
    })

    expect(calls[0]).toEqual({ from: 100n, to: 250n })
    expect(out).toEqual({ kind: 'no-match', nextScanFromBlock: 251n, scannedTo: 250n })
  })

  it('returns no-new-blocks without issuing getLogs when caught up to head', async () => {
    const { getBlockNumber, getLogsForRange, calls } = makeFakes({ latest: 99n })

    const out = await scanCctpDeliveryWindow({
      getBlockNumber, getLogsForRange, scanFromBlock: 100n, maxLogRange: 5_000n,
    })

    expect(calls).toEqual([])
    expect(out).toEqual({ kind: 'no-new-blocks' })
  })

  it('returns the tx hash when the match falls inside the bounded window', async () => {
    const { getBlockNumber, getLogsForRange, calls } = makeFakes({
      latest: 1_000_000n,
      matchAtBlock: 3_500n,
      matchTxHash: '0xbeef' as `0x${string}`,
    })

    const out = await scanCctpDeliveryWindow({
      getBlockNumber, getLogsForRange, scanFromBlock: 0n, maxLogRange: 5_000n,
    })

    expect(calls[0]).toEqual({ from: 0n, to: 4_999n })
    expect(out).toEqual({ kind: 'match', txHash: '0xbeef' })
  })

  it('does not find a match outside its bounded window (caller must keep ticking)', async () => {
    const { getBlockNumber, getLogsForRange } = makeFakes({
      latest: 1_000_000n,
      matchAtBlock: 20_000n,
    })

    const out = await scanCctpDeliveryWindow({
      getBlockNumber, getLogsForRange, scanFromBlock: 0n, maxLogRange: 5_000n,
    })

    expect(out.kind).toBe('no-match')
  })

  it('repeated ticks march the cursor forward chunk by chunk until match is found', async () => {
    const { getBlockNumber, getLogsForRange, calls } = makeFakes({
      latest: 50_000n,
      matchAtBlock: 12_345n,
      matchTxHash: '0xcafe' as `0x${string}`,
    })

    const t1 = await scanCctpDeliveryWindow({ getBlockNumber, getLogsForRange, scanFromBlock: 0n, maxLogRange: 5_000n })
    expect(t1.kind).toBe('no-match')
    if (t1.kind !== 'no-match') throw new Error('unreachable')

    const t2 = await scanCctpDeliveryWindow({ getBlockNumber, getLogsForRange, scanFromBlock: t1.nextScanFromBlock, maxLogRange: 5_000n })
    expect(t2.kind).toBe('no-match')
    if (t2.kind !== 'no-match') throw new Error('unreachable')

    const t3 = await scanCctpDeliveryWindow({ getBlockNumber, getLogsForRange, scanFromBlock: t2.nextScanFromBlock, maxLogRange: 5_000n })
    expect(t3).toEqual({ kind: 'match', txHash: '0xcafe' })

    expect(calls).toEqual([
      { from: 0n, to: 4_999n },
      { from: 5_000n, to: 9_999n },
      { from: 10_000n, to: 14_999n },
    ])
  })

  it('throws when maxLogRange is < 1', async () => {
    const { getBlockNumber, getLogsForRange } = makeFakes({ latest: 100n })
    await expect(scanCctpDeliveryWindow({
      getBlockNumber, getLogsForRange, scanFromBlock: 0n, maxLogRange: 0n,
    })).rejects.toThrow(/maxLogRange/)
  })

  it('uses matchPredicate to pick our log out of an unrelated-traffic batch', async () => {
    // Simulates the CCTP V2 destination scan: we drop the indexed nonce filter because the
    // emitted topic is an Iris-assigned eventNonce. The handler instead matches by a
    // unique-per-tx substring inside the messageBody (e.g. encryptedBundle[0] for shield-xchain,
    // or the padded recipient for unshield-xchain).
    const ours = '0xours' as `0x${string}`
    const someoneElse = '0xothr' as `0x${string}`
    const getBlockNumber = async () => 1_000_000n
    const getLogsForRange = vi.fn(async () => [
      { transactionHash: someoneElse, marker: 'unrelated-traffic' },
      { transactionHash: ours, marker: 'mine' },
      { transactionHash: someoneElse, marker: 'more-unrelated' },
    ])

    const out = await scanCctpDeliveryWindow<{ transactionHash: `0x${string}`; marker: string }>({
      getBlockNumber,
      getLogsForRange,
      matchPredicate: (log) => log.marker === 'mine',
      scanFromBlock: 0n,
      maxLogRange: 5_000n,
    })

    expect(out).toEqual({ kind: 'match', txHash: ours })
  })

  it('returns no-match when the matchPredicate rejects every log in the window', async () => {
    const getBlockNumber = async () => 1_000_000n
    const getLogsForRange = vi.fn(async () => [
      { transactionHash: '0xa' as `0x${string}`, marker: 'unrelated-traffic' },
      { transactionHash: '0xb' as `0x${string}`, marker: 'more-unrelated' },
    ])

    const out = await scanCctpDeliveryWindow<{ transactionHash: `0x${string}`; marker: string }>({
      getBlockNumber,
      getLogsForRange,
      matchPredicate: (log) => log.marker === 'mine',
      scanFromBlock: 0n,
      maxLogRange: 5_000n,
    })

    expect(out.kind).toBe('no-match')
  })
})
