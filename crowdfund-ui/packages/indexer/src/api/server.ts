// ABOUTME: HTTP API for serving verified crowdfund indexer health, snapshots, and event deltas.
// ABOUTME: Exposes JSON-safe snapshot data for observer and committer frontends.

import express from 'express'
import { join } from 'node:path'
import { JsonRpcProvider } from 'ethers'
import { buildHealth } from './health.js'
import { getInitialCursor, loadIndexerConfig, readBooleanEnv, readRequiredEnv } from '../config.js'
import { createIndexerStore } from '../db/createStore.js'
import type { IndexerMeta, IndexerStore } from '../db/store.js'
import { CrowdfundIndexerPoller } from '../ingest/poller.js'
import { getRepairRanges } from '../ingest/ranges.js'
import { getExhaustedRepairRanges } from '../ingest/reconcile.js'
import { createJsonRpcRangeProvider } from '../ingest/rpc.js'
import { sanitizeErrorMessage } from '../ingest/errors.js'
import { createReadableCrowdfundContract, reconcileSnapshot } from '../reconcile/contract.js'
import { buildSnapshot, withReconciliation } from '../snapshots/build.js'
import { toJsonValue } from '../snapshots/json.js'
import { publishSnapshot, publishSnapshotToObjectStorage, type PublishSnapshotResult } from '../snapshots/publish.js'
import type { IndexerStoreData } from '../types.js'

export interface CreateIndexerApiOptions {
  store: IndexerStore
  chainId: number
  contractAddress: string
  repairMaxAttempts: number
  staleAfterMs?: number
}

function buildHealthFromStore(data: IndexerMeta, repairMaxAttempts: number, staleAfterMs?: number) {
  return buildHealth({
    cursor: data.cursor,
    gapRanges: getRepairRanges(data.ranges),
    gapsRequiringIntervention: getExhaustedRepairRanges(data.ranges, repairMaxAttempts),
    lastIngestedAt: data.lastIngestedAt,
    lastVerifiedAt: data.lastVerifiedAt,
    lastReconciledAt: data.lastReconciledAt,
    lastError: data.lastError,
    latestSnapshotHash: data.latestSnapshotHash,
    latestStaticSnapshotUrl: data.latestStaticSnapshotUrl,
    staleAfterMs,
  })
}

function readOptionalNumber(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

// Only a publicly fetchable URL belongs in latestStaticSnapshotUrl, which is served
// on the unauthenticated /health endpoint. The object-storage publisher provides a
// real URL; the file publisher returns only a local disk path, which must not be
// exposed — so fall back to null rather than leaking the path.
export function selectStaticSnapshotUrl(result: PublishSnapshotResult): string | null {
  return result.latestUrl ?? null
}

async function publishCurrentSnapshot(
  store: IndexerStore,
  chainId: number,
  contractAddress: string,
  primaryRpcUrl: string | null,
): Promise<void> {
  const meta = await store.readMeta()
  const data: IndexerStoreData = { ...meta, rawLogs: await store.readLogs(meta.cursor.verifiedCursor) }
  let snapshot = buildSnapshot({ data, chainId, contractAddress })

  if (primaryRpcUrl) {
    const provider = new JsonRpcProvider(primaryRpcUrl)
    try {
      const contract = createReadableCrowdfundContract(provider, contractAddress)
      const reconciliation = await reconcileSnapshot({
        graph: snapshot.graph,
        contract,
        checkedBlock: data.cursor.verifiedCursor,
        providerName: 'primary',
      })
      snapshot = withReconciliation(snapshot, reconciliation)
    } finally {
      provider.destroy()
    }
  }

  if (snapshot.metadata.reconciliation.status === 'failed') {
    throw new Error(`Refusing to publish failed reconciliation: ${snapshot.metadata.reconciliation.mismatches.join('; ')}`)
  }

  const publisher = process.env.CROWDFUND_SNAPSHOT_PUBLISHER ?? 'file'
  if (publisher !== 'file' && publisher !== 's3') throw new Error('CROWDFUND_SNAPSHOT_PUBLISHER must be "file" or "s3"')
  const result = publisher === 's3'
    ? await publishSnapshotToObjectStorage(snapshot, {
        bucket: readRequiredEnv('CROWDFUND_SNAPSHOT_BUCKET'),
        prefix: process.env.CROWDFUND_SNAPSHOT_PREFIX,
        region: process.env.CROWDFUND_SNAPSHOT_REGION ?? process.env.AWS_REGION,
        endpoint: process.env.CROWDFUND_SNAPSHOT_ENDPOINT,
        publicBaseUrl: process.env.CROWDFUND_SNAPSHOT_PUBLIC_BASE_URL,
        forcePathStyle: readBooleanEnv('CROWDFUND_SNAPSHOT_FORCE_PATH_STYLE', false),
      })
    : await publishSnapshot(
        snapshot,
        process.env.CROWDFUND_SNAPSHOT_DIR ?? join(process.cwd(), 'data/crowdfund-indexer/snapshots'),
      )

  await store.patchMeta({
    latestSnapshotHash: snapshot.metadata.snapshotHash,
    latestStaticSnapshotUrl: selectStaticSnapshotUrl(result),
    ...(snapshot.metadata.reconciliation.checkedAt
      ? { lastReconciledAt: snapshot.metadata.reconciliation.checkedAt }
      : {}),
    lastError: null,
  })
}

export function createIndexerApi(options: CreateIndexerApiOptions) {
  const app = express()

  // Per-process snapshot cache keyed on the verified state. Building a snapshot parses
  // every verified log and rebuilds the graph; without this, every /snapshot and /events
  // request repeats that work. The key changes iff verified data changed (verifiedCursor
  // advances and lastVerifiedAt updates together on each successful verification), so no
  // TTL is needed. NOTE: this is not a request-rate limiter — front the service with a
  // reverse proxy for that (tracked separately).
  let snapshotCache: { key: string; snapshot: ReturnType<typeof buildSnapshot> } | null = null

  async function getSnapshot(): Promise<ReturnType<typeof buildSnapshot>> {
    const meta = await options.store.readMeta()
    const key = `${meta.cursor.verifiedCursor}:${meta.lastVerifiedAt ?? ''}`
    if (snapshotCache && snapshotCache.key === key) return snapshotCache.snapshot
    const rawLogs = await options.store.readLogs(meta.cursor.verifiedCursor)
    const snapshot = buildSnapshot({
      data: { ...meta, rawLogs },
      chainId: options.chainId,
      contractAddress: options.contractAddress,
    })
    snapshotCache = { key, snapshot }
    return snapshot
  }

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    next()
  })

  app.get('/health', async (_req, res, next) => {
    try {
      const meta = await options.store.readMeta()
      res.json(buildHealthFromStore(meta, options.repairMaxAttempts, options.staleAfterMs))
    } catch (err) {
      next(err)
    }
  })

  app.get('/snapshot', async (_req, res, next) => {
    try {
      res.json(toJsonValue(await getSnapshot()))
    } catch (err) {
      next(err)
    }
  })

  app.get('/events', async (req, res, next) => {
    try {
      const afterBlock = readOptionalNumber(req.query.afterBlock)
      const afterLogIndex = readOptionalNumber(req.query.afterLogIndex) ?? -1
      const snapshot = await getSnapshot()
      const events = snapshot.events.filter((event) => {
        if (afterBlock === null) return true
        if (event.blockNumber > afterBlock) return true
        return event.blockNumber === afterBlock && event.logIndex > afterLogIndex
      })
      res.json(toJsonValue({
        metadata: snapshot.metadata,
        events,
      }))
    } catch (err) {
      next(err)
    }
  })

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Never echo the raw error to the client — it can carry RPC keys or DB credentials.
    // Log the sanitized real message server-side; return a fixed message to the caller.
    const message = err instanceof Error ? err.message : 'Unknown indexer API error'
    process.stderr.write(`Crowdfund indexer API error: ${sanitizeErrorMessage(message)}\n`)
    res.status(500).json({ error: 'internal indexer error' })
  })

  return app
}

async function main(): Promise<void> {
  const config = loadIndexerConfig()
  const store = createIndexerStore({
    defaultFilePath: join(process.cwd(), 'data/crowdfund-indexer/store.json'),
    initialCursor: getInitialCursor(),
  })
  const app = createIndexerApi({
    store,
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    repairMaxAttempts: config.repairMaxAttempts,
    staleAfterMs: config.staleAfterMs,
  })
  const server = app.listen(config.port, () => {
    process.stdout.write(`Crowdfund indexer API listening on ${config.port}\n`)
  })

  // Release the store backend (e.g. Postgres pool) on shutdown signals.
  const shutdown = () => {
    server.close()
    void store.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  if (config.pollOnStart || config.backfillOnStart) {
    if (!config.primaryRpcUrl) throw new Error('Missing required environment variable: CROWDFUND_PRIMARY_RPC_URL')
    const primaryRpcUrl = config.primaryRpcUrl
    if (!config.auditRpcUrl) {
      process.stderr.write(
        'Warning: CROWDFUND_AUDIT_RPC_URL is unset — ranges are verified against the same provider twice (no independent audit).\n',
      )
    }
    const poller = new CrowdfundIndexerPoller({
      chainId: config.chainId,
      contractAddress: config.contractAddress,
      providerName: 'primary',
      store,
      provider: createJsonRpcRangeProvider(primaryRpcUrl),
      auditProvider: config.auditRpcUrl ? createJsonRpcRangeProvider(config.auditRpcUrl) : undefined,
      auditProviderName: config.auditRpcUrl ? 'audit' : undefined,
      maxBlockRange: config.maxBlockRange,
      pollIntervalMs: config.pollIntervalMs,
      errorBackoffMs: config.errorBackoffMs,
      rpcTimeoutMs: config.rpcTimeoutMs,
      rpcMaxRetries: config.rpcMaxRetries,
      retryBaseDelayMs: config.retryBaseDelayMs,
      retryJitterMs: config.retryJitterMs,
      reconcileOptions: {
        maxAttempts: config.repairMaxAttempts,
        backoffBaseMs: config.repairBackoffBaseMs,
        backoffMaxMs: config.repairBackoffMaxMs,
      },
      publishOnPoll: config.publishOnPoll,
      snapshotPublishIntervalMs: config.snapshotPublishIntervalMs,
      publishSnapshot: config.publishOnPoll
        ? () => publishCurrentSnapshot(store, config.chainId, config.contractAddress, primaryRpcUrl)
        : undefined,
      logger: {
        info: (message) => process.stdout.write(`${message}\n`),
        warn: (message) => process.stderr.write(`${message}\n`),
        error: (message) => process.stderr.write(`${message}\n`),
      },
    })
    if (config.pollOnStart) {
      poller.start()
      process.stdout.write('Crowdfund indexer polling worker started\n')
    } else {
      poller.runOnce()
        .then((result) => {
          if (result.status === 'completed') {
            process.stdout.write(`Startup backfill checked ${result.backfill?.ranges.length ?? 0} chunks; stoppedEarly=${result.backfill?.stoppedEarly ? 'yes' : 'no'}\n`)
          } else {
            process.stderr.write(`Startup backfill ${result.status}: ${result.error ?? 'no details'}\n`)
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Unknown startup backfill error'
          process.stderr.write(`Startup backfill failed: ${message}\n`)
        })
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Unknown indexer API startup error'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
