// ABOUTME: Supervised polling worker for continuous crowdfund indexer catch-up.
// ABOUTME: Adds bounded RPC retries, timeouts, backoff, and non-overlapping cycles around backfill.

import type { IndexerStore } from '../db/store.js'
import { backfillVerifiedRanges } from './backfill.js'
import type { BackfillResult } from './backfill.js'
import { autoReconcileGaps } from './reconcile.js'
import type { AutoReconcileOptions, AutoReconcileResult } from './reconcile.js'
import type { RangeLogProvider, RangePipelineConfig } from './rpc.js'

export type RpcErrorKind = 'timeout' | 'rate_limited' | 'network' | 'malformed_response' | 'unknown'
export type PollCycleStatus = 'completed' | 'failed' | 'skipped'

export interface ResilientProviderOptions {
  timeoutMs: number
  maxRetries: number
  retryBaseDelayMs: number
  jitterMs?: number
}

export interface PollerLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface CrowdfundIndexerPollerOptions extends RangePipelineConfig {
  store: IndexerStore
  provider: RangeLogProvider
  auditProvider?: RangeLogProvider
  auditProviderName?: string
  maxBlockRange: number
  pollIntervalMs: number
  errorBackoffMs: number
  rpcTimeoutMs: number
  rpcMaxRetries: number
  retryBaseDelayMs?: number
  retryJitterMs?: number
  // When provided, each poll cycle runs auto-reconcile against any failed/suspicious
  // ranges before backfill advances the verified cursor. Omit to disable auto-repair.
  reconcileOptions?: AutoReconcileOptions
  publishSnapshot?: () => Promise<void>
  publishOnPoll?: boolean
  snapshotPublishIntervalMs?: number
  logger?: PollerLogger
}

export interface PollCycleResult {
  status: PollCycleStatus
  backfill?: BackfillResult
  reconcile?: AutoReconcileResult
  error?: string
}

const noopLogger: PollerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function classifyRpcError(err: unknown): RpcErrorKind {
  const message = getErrorMessage(err).toLowerCase()
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code).toLowerCase() : ''
  const status = typeof err === 'object' && err !== null && 'status' in err ? String(err.status) : ''

  if (message.includes('timeout') || code.includes('timeout')) return 'timeout'
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests') || status === '429') {
    return 'rate_limited'
  }
  if (message.includes('malformed') || message.includes('invalid json') || message.includes('unexpected token')) {
    return 'malformed_response'
  }
  if (
    message.includes('network') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    message.includes('socket')
  ) {
    return 'network'
  }
  return 'unknown'
}

function retryDelayMs(attempt: number, options: ResilientProviderOptions): number {
  const base = options.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1)
  const jitter = options.jitterMs ? Math.floor(Math.random() * options.jitterMs) : 0
  return base + jitter
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`RPC timeout after ${timeoutMs}ms during ${label}`)), timeoutMs)
  })

  try {
    return await Promise.race([operation, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function withRetries<T>(
  label: string,
  options: ResilientProviderOptions,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      return await withTimeout(operation(), options.timeoutMs, label)
    } catch (err) {
      lastError = err
      if (attempt >= options.maxRetries) break
      await sleep(retryDelayMs(attempt + 1, options))
    }
  }

  const kind = classifyRpcError(lastError)
  throw new Error(`${kind}: ${getErrorMessage(lastError)}`)
}

export function createResilientRangeProvider(
  provider: RangeLogProvider,
  options: ResilientProviderOptions,
): RangeLogProvider {
  return {
    getBlockNumber: () => withRetries('getBlockNumber', options, () => provider.getBlockNumber()),
    getLogs: (filter) => withRetries(
      `getLogs ${filter.fromBlock}-${filter.toBlock}`,
      options,
      () => provider.getLogs(filter),
    ),
  }
}

export class CrowdfundIndexerPoller {
  private readonly options: CrowdfundIndexerPollerOptions
  private readonly logger: PollerLogger
  private running = false
  private stopped = true
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastPublishedAt = 0

  constructor(options: CrowdfundIndexerPollerOptions) {
    this.options = options
    this.logger = options.logger ?? noopLogger
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async runOnce(): Promise<PollCycleResult> {
    if (this.running) {
      this.logger.warn('Crowdfund indexer poll skipped: previous cycle still running')
      return { status: 'skipped' }
    }

    this.running = true
    try {
      const resilientOptions: ResilientProviderOptions = {
        timeoutMs: this.options.rpcTimeoutMs,
        maxRetries: this.options.rpcMaxRetries,
        retryBaseDelayMs: this.options.retryBaseDelayMs ?? 1_000,
        jitterMs: this.options.retryJitterMs ?? 250,
      }
      const resilientProvider = createResilientRangeProvider(this.options.provider, resilientOptions)
      const resilientAuditProvider = this.options.auditProvider
        ? createResilientRangeProvider(this.options.auditProvider, resilientOptions)
        : undefined

      // Repair any known gaps before advancing. Failures here are logged but do not
      // block backfill — a transient repair miss should not stall fresh ingest.
      let reconcile: AutoReconcileResult | undefined
      if (this.options.reconcileOptions && this.options.reconcileOptions.maxAttempts > 0) {
        try {
          reconcile = await autoReconcileGaps({
            chainId: this.options.chainId,
            contractAddress: this.options.contractAddress,
            providerName: this.options.providerName,
            store: this.options.store,
            provider: resilientProvider,
            auditProvider: resilientAuditProvider,
            auditProviderName: this.options.auditProviderName,
            options: this.options.reconcileOptions,
          })
          if (reconcile.attempted.length > 0 || reconcile.exhaustedCount > 0) {
            this.logger.info(
              `Crowdfund indexer reconcile attempted ${reconcile.attempted.length}; deferred ${reconcile.deferredCount}; exhausted ${reconcile.exhaustedCount}`,
            )
          }
        } catch (err) {
          this.logger.warn(`Crowdfund indexer reconcile failed: ${getErrorMessage(err)}`)
        }
      }

      const result = await backfillVerifiedRanges({
        chainId: this.options.chainId,
        contractAddress: this.options.contractAddress,
        providerName: this.options.providerName,
        store: this.options.store,
        provider: resilientProvider,
        auditProvider: resilientAuditProvider,
        auditProviderName: this.options.auditProviderName,
        maxBlockRange: this.options.maxBlockRange,
      })

      this.logger.info(`Crowdfund indexer poll checked ${result.ranges.length} chunks; stoppedEarly=${result.stoppedEarly ? 'yes' : 'no'}`)
      await this.maybePublish(result)
      return { status: 'completed', backfill: result, reconcile }
    } catch (err) {
      const message = getErrorMessage(err)
      await this.options.store.update((data) => ({
        ...data,
        lastError: message,
      }))
      this.logger.error(`Crowdfund indexer poll failed: ${message}`)
      return { status: 'failed', error: message }
    } finally {
      this.running = false
    }
  }

  private async maybePublish(result: BackfillResult): Promise<void> {
    if (!this.options.publishOnPoll || !this.options.publishSnapshot) return
    if (result.stoppedEarly) return

    const now = Date.now()
    const interval = this.options.snapshotPublishIntervalMs ?? this.options.pollIntervalMs
    if (this.lastPublishedAt > 0 && now - this.lastPublishedAt < interval) return

    await this.options.publishSnapshot()
    this.lastPublishedAt = now
    this.logger.info('Crowdfund indexer poll published snapshot')
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.runOnce()
        .then((result) => {
          const delay = result.status === 'failed' ? this.options.errorBackoffMs : this.options.pollIntervalMs
          this.schedule(delay)
        })
        .catch((err: unknown) => {
          this.logger.error(`Crowdfund indexer poll scheduler failed unexpectedly: ${getErrorMessage(err)}`)
          this.schedule(this.options.errorBackoffMs)
        })
    }, delayMs)
  }
}
