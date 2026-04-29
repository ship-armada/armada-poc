// ABOUTME: Chunked backfill orchestration for the crowdfund indexer.
// ABOUTME: Verifies confirmed block ranges sequentially without advancing past failed or suspicious chunks.

import type { IndexerStore } from '../db/store.js'
import { verifyRange } from './rpc.js'
import type { BlockRange, IngestRangeRecord } from '../types.js'
import type { RangeLogProvider, RangePipelineConfig } from './rpc.js'

export interface PlanBackfillRangesInput {
  fromBlock: number
  toBlock: number
  maxBlockRange: number
}

export interface BackfillInput extends RangePipelineConfig {
  store: IndexerStore
  provider: RangeLogProvider
  auditProvider?: RangeLogProvider
  auditProviderName?: string
  maxBlockRange: number
  toBlock?: number
  stopOnUnverified?: boolean
}

export interface BackfillResult {
  fromBlock: number
  toBlock: number
  ranges: readonly IngestRangeRecord[]
  stoppedEarly: boolean
}

export function planBackfillRanges(input: PlanBackfillRangesInput): BlockRange[] {
  if (input.maxBlockRange <= 0) throw new Error('maxBlockRange must be greater than zero')
  if (input.fromBlock > input.toBlock) return []

  const ranges: BlockRange[] = []
  let cursor = input.fromBlock
  while (cursor <= input.toBlock) {
    const chunkEnd = Math.min(cursor + input.maxBlockRange - 1, input.toBlock)
    ranges.push({ fromBlock: cursor, toBlock: chunkEnd })
    cursor = chunkEnd + 1
  }
  return ranges
}

export async function backfillVerifiedRanges(input: BackfillInput): Promise<BackfillResult> {
  const data = await input.store.read()
  const chainHead = await input.provider.getBlockNumber()
  const confirmedHead = Math.max(0, chainHead - data.cursor.confirmationDepth)
  const toBlock = input.toBlock === undefined ? confirmedHead : Math.min(input.toBlock, confirmedHead)
  const fromBlock = data.cursor.verifiedCursor + 1
  const ranges = planBackfillRanges({
    fromBlock,
    toBlock,
    maxBlockRange: input.maxBlockRange,
  })

  await input.store.update((current) => ({
    ...current,
    cursor: {
      ...current.cursor,
      chainHead,
      confirmedHead,
    },
  }))

  const records: IngestRangeRecord[] = []
  let stoppedEarly = false
  for (const range of ranges) {
    const record = await verifyRange({ ...input, range })
    records.push(record)
    if ((input.stopOnUnverified ?? true) && record.status !== 'verified') {
      stoppedEarly = true
      break
    }
  }

  return {
    fromBlock,
    toBlock,
    ranges: records,
    stoppedEarly,
  }
}
