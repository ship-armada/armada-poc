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

// When set, backfill skips a chunk whose existing record is failed/suspicious and is
// still within its repair backoff window or has exhausted its attempt limit. This keeps
// the poll loop from re-verifying a stuck range every cycle (which both ignored the
// backoff and double-incremented `attempts` alongside auto-reconcile). The operator CLI
// passes no policy, so `repair`/`backfill` remain an explicit immediate retry.
export interface BackfillRetryPolicy {
  maxAttempts: number
  // Injectable clock for deterministic tests.
  now?: () => Date
}

export interface BackfillInput extends RangePipelineConfig {
  store: IndexerStore
  provider: RangeLogProvider
  auditProvider?: RangeLogProvider
  auditProviderName?: string
  maxBlockRange: number
  toBlock?: number
  stopOnUnverified?: boolean
  retryPolicy?: BackfillRetryPolicy
}

export interface BackfillResult {
  fromBlock: number
  toBlock: number
  ranges: readonly IngestRangeRecord[]
  stoppedEarly: boolean
}

// True when an existing record for this range should NOT be re-verified yet under the
// given policy: it is failed/suspicious and either still inside its backoff window or
// already at the attempt limit. Ranges with no prior record (or non-failed records) are
// never deferred.
function isDeferredByPolicy(
  record: IngestRangeRecord | undefined,
  policy: BackfillRetryPolicy,
): boolean {
  if (!record) return false
  if (record.status !== 'failed' && record.status !== 'suspicious') return false
  if (policy.maxAttempts > 0 && record.attempts >= policy.maxAttempts) return true
  if (record.nextRetryAt === null) return false
  const now = (policy.now ?? (() => new Date()))()
  return new Date(record.nextRetryAt).getTime() > now.getTime()
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
    // Respect the repair backoff/attempt limit before re-verifying a known-bad chunk.
    // Because the verified cursor never skips a gap, a deferred chunk also stops every
    // later chunk this cycle — they cannot be promoted past it anyway.
    if (input.retryPolicy) {
      const existing = data.ranges.find(
        (record) => record.fromBlock === range.fromBlock && record.toBlock === range.toBlock,
      )
      if (isDeferredByPolicy(existing, input.retryPolicy)) {
        stoppedEarly = true
        break
      }
    }
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
