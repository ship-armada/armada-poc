// ABOUTME: Pure range-ingestion helpers for no-gap crowdfund event indexing.
// ABOUTME: Keeps cursor promotion and digest creation deterministic and independently testable.

import { createHash } from 'node:crypto'
import type { BlockRange, IndexedRawLog, IngestRangeRecord } from '../types.js'

export function getLogIdentity(log: IndexedRawLog): string {
  return [
    log.chainId,
    log.contractAddress.toLowerCase(),
    log.blockHash.toLowerCase(),
    log.blockNumber,
    log.transactionHash.toLowerCase(),
    log.logIndex,
  ].join(':')
}

export function createRangeDigest(logs: readonly IndexedRawLog[]): string {
  const hash = createHash('sha256')
  const sorted = [...logs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber
    if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex
    return a.transactionHash.localeCompare(b.transactionHash)
  })

  for (const log of sorted) {
    hash.update(getLogIdentity(log))
    hash.update('|')
    hash.update(log.topics.join(',').toLowerCase())
    hash.update('|')
    hash.update(log.data.toLowerCase())
    hash.update('\n')
  }

  return `0x${hash.digest('hex')}`
}

export function findFirstGap(
  verifiedRanges: readonly BlockRange[],
  fromBlock: number,
  toBlock: number,
): BlockRange | null {
  let expected = fromBlock
  const sorted = [...verifiedRanges].sort((a, b) => a.fromBlock - b.fromBlock)

  for (const range of sorted) {
    if (range.toBlock < expected) continue
    if (range.fromBlock > expected) {
      return {
        fromBlock: expected,
        toBlock: Math.min(range.fromBlock - 1, toBlock),
      }
    }
    expected = Math.max(expected, range.toBlock + 1)
    if (expected > toBlock) return null
  }

  if (expected <= toBlock) return { fromBlock: expected, toBlock }
  return null
}

export function getContiguousVerifiedCursor(
  records: readonly IngestRangeRecord[],
  currentVerifiedCursor: number,
): number {
  let expected = currentVerifiedCursor + 1
  const verified = records
    .filter((record) => record.status === 'verified')
    .sort((a, b) => a.fromBlock - b.fromBlock)

  for (const range of verified) {
    if (range.toBlock < expected) continue
    if (range.fromBlock > expected) break
    expected = Math.max(expected, range.toBlock + 1)
  }

  return expected - 1
}

export function getRepairRanges(records: readonly IngestRangeRecord[]): BlockRange[] {
  return records
    .filter((record) => record.status === 'failed' || record.status === 'suspicious')
    .map((record) => ({
      fromBlock: record.fromBlock,
      toBlock: record.toBlock,
    }))
}
