// ABOUTME: Auto-reconcile orchestration with bounded retry and exponential backoff.
// ABOUTME: Lets the polling loop self-heal transient gaps while escalating persistent failures.

import { verifyRange } from './rpc.js'
import type { IndexerStore } from '../db/store.js'
import type { RangeLogProvider, RangePipelineConfig } from './rpc.js'
import type { BlockRange, IngestRangeRecord } from '../types.js'

export interface AutoReconcileOptions {
  // Maximum total `attempts` count (initial ingest + repair retries combined) before
  // a range is considered exhausted and skipped by auto-reconcile. Setting this to
  // 0 disables auto-reconcile entirely. Operators can still bypass via the CLI.
  maxAttempts: number
  // Base delay for exponential backoff between repair attempts, in milliseconds.
  // The Nth repair attempt waits backoffBaseMs * 2^(attempts-1), capped at backoffMaxMs.
  backoffBaseMs: number
  backoffMaxMs: number
}

export interface ReconcileClassification {
  // Failed or suspicious ranges that are eligible for an immediate repair attempt.
  eligible: IngestRangeRecord[]
  // Failed or suspicious ranges still in their backoff window.
  deferred: IngestRangeRecord[]
  // Failed or suspicious ranges that have hit the attempt limit; require operator action.
  exhausted: IngestRangeRecord[]
}

export interface AutoReconcileInput extends RangePipelineConfig {
  store: IndexerStore
  provider: RangeLogProvider
  auditProvider?: RangeLogProvider
  auditProviderName?: string
  options: AutoReconcileOptions
  // Injectable clock for deterministic tests.
  now?: () => Date
}

export interface AutoReconcileResult {
  attempted: IngestRangeRecord[]
  deferredCount: number
  exhaustedCount: number
}

function isRepairCandidate(record: IngestRangeRecord): boolean {
  return record.status === 'failed' || record.status === 'suspicious'
}

export function computeNextRetryAt(
  attempts: number,
  options: AutoReconcileOptions,
  now: Date,
): string {
  const exponent = Math.max(0, attempts - 1)
  // Cap the multiplier exponent so 2^exponent never overflows safe integer range
  // even if a stuck range has been retried many times.
  const safeExponent = Math.min(exponent, 30)
  const candidate = options.backoffBaseMs * 2 ** safeExponent
  const delay = Math.min(options.backoffMaxMs, candidate)
  return new Date(now.getTime() + delay).toISOString()
}

export function classifyRepairableRanges(
  records: readonly IngestRangeRecord[],
  options: AutoReconcileOptions,
  now: Date,
): ReconcileClassification {
  const eligible: IngestRangeRecord[] = []
  const deferred: IngestRangeRecord[] = []
  const exhausted: IngestRangeRecord[] = []

  for (const record of records) {
    if (!isRepairCandidate(record)) continue
    if (options.maxAttempts > 0 && record.attempts >= options.maxAttempts) {
      exhausted.push(record)
      continue
    }
    if (record.nextRetryAt && new Date(record.nextRetryAt).getTime() > now.getTime()) {
      deferred.push(record)
      continue
    }
    eligible.push(record)
  }

  return { eligible, deferred, exhausted }
}

// Returns the subset of failed/suspicious ranges that have hit the attempt limit
// (i.e. auto-reconcile will no longer retry them). Used by the health endpoint to
// surface "operator action required" gaps separately from gaps still being repaired.
export function getExhaustedRepairRanges(
  records: readonly IngestRangeRecord[],
  maxAttempts: number,
): BlockRange[] {
  if (maxAttempts <= 0) return []
  return records
    .filter(isRepairCandidate)
    .filter((record) => record.attempts >= maxAttempts)
    .map((record) => ({ fromBlock: record.fromBlock, toBlock: record.toBlock }))
}

export async function autoReconcileGaps(input: AutoReconcileInput): Promise<AutoReconcileResult> {
  if (input.options.maxAttempts <= 0) {
    return { attempted: [], deferredCount: 0, exhaustedCount: 0 }
  }

  const now = (input.now ?? (() => new Date()))()
  const data = await input.store.read()
  const { eligible, deferred, exhausted } = classifyRepairableRanges(data.ranges, input.options, now)

  const attempted: IngestRangeRecord[] = []
  for (const candidate of eligible) {
    const range: BlockRange = { fromBlock: candidate.fromBlock, toBlock: candidate.toBlock }
    const result = await verifyRange({
      chainId: input.chainId,
      contractAddress: input.contractAddress,
      providerName: input.providerName,
      store: input.store,
      provider: input.provider,
      auditProvider: input.auditProvider,
      auditProviderName: input.auditProviderName,
      range,
    })
    attempted.push(result)

    // If still not verified, schedule the next backoff window. We pull the freshly
    // written record back from the store so that `attempts` reflects the increment
    // applied during this cycle.
    if (result.status !== 'verified') {
      const after = await input.store.read()
      const written = after.ranges.find(
        (record) => record.fromBlock === range.fromBlock && record.toBlock === range.toBlock,
      )
      if (written) {
        const scheduled: IngestRangeRecord = {
          ...written,
          nextRetryAt: computeNextRetryAt(written.attempts, input.options, (input.now ?? (() => new Date()))()),
        }
        await input.store.upsertRange(scheduled)
      }
    }
  }

  if (attempted.length > 0) {
    await input.store.update((current) => ({
      ...current,
      lastReconciledAt: (input.now ?? (() => new Date()))().toISOString(),
    }))
  }

  return {
    attempted,
    deferredCount: deferred.length,
    exhaustedCount: exhausted.length,
  }
}
