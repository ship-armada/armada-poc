// ABOUTME: HTTP API for serving verified crowdfund indexer health, snapshots, and event deltas.
// ABOUTME: Exposes JSON-safe snapshot data for observer and committer frontends.

import express from 'express'
import { join } from 'node:path'
import { JsonRpcProvider } from 'ethers'
import { buildHealth } from './health.js'
import { createIndexerStore } from '../db/createStore.js'
import type { IndexerStore } from '../db/store.js'
import { CrowdfundIndexerPoller } from '../ingest/poller.js'
import { getRepairRanges } from '../ingest/ranges.js'
import { createJsonRpcRangeProvider } from '../ingest/rpc.js'
import { createReadableCrowdfundContract, reconcileSnapshot } from '../reconcile/contract.js'
import { buildSnapshot } from '../snapshots/build.js'
import { toJsonValue } from '../snapshots/json.js'
import { publishSnapshot, publishSnapshotToObjectStorage } from '../snapshots/publish.js'
import type { CursorState, IndexerStoreData, ReconciliationResult } from '../types.js'

export interface CreateIndexerApiOptions {
  store: IndexerStore
  chainId: number
  contractAddress: string
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`)
  }
  return parsed
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (!value) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Invalid boolean environment variable: ${name}`)
}

function getInitialCursor(): CursorState {
  const deployBlock = readNumberEnv('CROWDFUND_DEPLOY_BLOCK', 0)
  return {
    deployBlock,
    confirmationDepth: readNumberEnv('CROWDFUND_CONFIRMATION_DEPTH', 12),
    overlapWindow: readNumberEnv('CROWDFUND_OVERLAP_WINDOW', 100),
    chainHead: deployBlock,
    confirmedHead: deployBlock,
    ingestedCursor: deployBlock > 0 ? deployBlock - 1 : 0,
    verifiedCursor: deployBlock > 0 ? deployBlock - 1 : 0,
  }
}

function buildHealthFromStore(data: IndexerStoreData) {
  return buildHealth({
    cursor: data.cursor,
    gapRanges: getRepairRanges(data.ranges),
    lastIngestedAt: data.lastIngestedAt,
    lastVerifiedAt: data.lastVerifiedAt,
    lastReconciledAt: data.lastReconciledAt,
    lastError: data.lastError,
    latestSnapshotHash: data.latestSnapshotHash,
    latestStaticSnapshotUrl: data.latestStaticSnapshotUrl,
  })
}

function readOptionalNumber(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

async function publishCurrentSnapshot(
  store: IndexerStore,
  chainId: number,
  contractAddress: string,
  primaryRpcUrl: string | null,
): Promise<void> {
  const data = await store.read()
  let reconciliation: ReconciliationResult | undefined
  const pendingSnapshot = buildSnapshot({ data, chainId, contractAddress })

  if (primaryRpcUrl) {
    const provider = new JsonRpcProvider(primaryRpcUrl)
    const contract = createReadableCrowdfundContract(provider, contractAddress)
    reconciliation = await reconcileSnapshot({
      graph: pendingSnapshot.graph,
      contract,
      checkedBlock: data.cursor.verifiedCursor,
      providerName: 'primary',
    })
  }

  const snapshot = buildSnapshot({ data, chainId, contractAddress, reconciliation })
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

  await store.update((current) => ({
    ...current,
    latestSnapshotHash: snapshot.metadata.snapshotHash,
    latestStaticSnapshotUrl: result.latestUrl ?? result.latestPath,
    lastReconciledAt: snapshot.metadata.reconciliation.checkedAt ?? current.lastReconciledAt,
    lastError: null,
  }))
}

export function createIndexerApi(options: CreateIndexerApiOptions) {
  const app = express()

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    next()
  })

  app.get('/health', async (_req, res, next) => {
    try {
      const data = await options.store.read()
      res.json(buildHealthFromStore(data))
    } catch (err) {
      next(err)
    }
  })

  app.get('/snapshot', async (_req, res, next) => {
    try {
      const data = await options.store.read()
      const snapshot = buildSnapshot({
        data,
        chainId: options.chainId,
        contractAddress: options.contractAddress,
      })
      res.json(toJsonValue(snapshot))
    } catch (err) {
      next(err)
    }
  })

  app.get('/events', async (req, res, next) => {
    try {
      const afterBlock = readOptionalNumber(req.query.afterBlock)
      const afterLogIndex = readOptionalNumber(req.query.afterLogIndex) ?? -1
      const data = await options.store.read()
      const snapshot = buildSnapshot({
        data,
        chainId: options.chainId,
        contractAddress: options.contractAddress,
      })
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
    const message = err instanceof Error ? err.message : 'Unknown indexer API error'
    res.status(500).json({ error: message })
  })

  return app
}

async function main(): Promise<void> {
  const chainId = readNumberEnv('CROWDFUND_CHAIN_ID', 11155111)
  const contractAddress = readRequiredEnv('CROWDFUND_CONTRACT_ADDRESS')
  const port = readNumberEnv('CROWDFUND_INDEXER_PORT', 3002)
  const maxBlockRange = readNumberEnv('CROWDFUND_MAX_BLOCK_RANGE', 500)
  const pollOnStart = readBooleanEnv('CROWDFUND_POLL_ON_START', false)
  const backfillOnStart = readBooleanEnv('CROWDFUND_BACKFILL_ON_START', false)
  const publishOnPoll = readBooleanEnv('CROWDFUND_PUBLISH_ON_POLL', false)
  const store = createIndexerStore({
    defaultFilePath: join(process.cwd(), 'data/crowdfund-indexer/store.json'),
    initialCursor: getInitialCursor(),
  })
  const app = createIndexerApi({ store, chainId, contractAddress })
  app.listen(port, () => {
    process.stdout.write(`Crowdfund indexer API listening on ${port}\n`)
  })

  if (pollOnStart || backfillOnStart) {
    const primaryRpcUrl = readRequiredEnv('CROWDFUND_PRIMARY_RPC_URL')
    const auditRpcUrl = process.env.CROWDFUND_AUDIT_RPC_URL
    const poller = new CrowdfundIndexerPoller({
      chainId,
      contractAddress,
      providerName: 'primary',
      store,
      provider: createJsonRpcRangeProvider(primaryRpcUrl),
      auditProvider: auditRpcUrl ? createJsonRpcRangeProvider(auditRpcUrl) : undefined,
      auditProviderName: auditRpcUrl ? 'audit' : undefined,
      maxBlockRange,
      pollIntervalMs: readNumberEnv('CROWDFUND_POLL_INTERVAL_MS', 15_000),
      errorBackoffMs: readNumberEnv('CROWDFUND_POLL_ERROR_BACKOFF_MS', 60_000),
      rpcTimeoutMs: readNumberEnv('CROWDFUND_RPC_TIMEOUT_MS', 15_000),
      rpcMaxRetries: readNumberEnv('CROWDFUND_RPC_MAX_RETRIES', 3),
      retryBaseDelayMs: readNumberEnv('CROWDFUND_RPC_RETRY_BASE_DELAY_MS', 1_000),
      retryJitterMs: readNumberEnv('CROWDFUND_RPC_RETRY_JITTER_MS', 250),
      publishOnPoll,
      snapshotPublishIntervalMs: readNumberEnv('CROWDFUND_SNAPSHOT_PUBLISH_INTERVAL_MS', 60_000),
      publishSnapshot: publishOnPoll
        ? () => publishCurrentSnapshot(store, chainId, contractAddress, primaryRpcUrl)
        : undefined,
      logger: {
        info: (message) => process.stdout.write(`${message}\n`),
        warn: (message) => process.stderr.write(`${message}\n`),
        error: (message) => process.stderr.write(`${message}\n`),
      },
    })
    if (pollOnStart) {
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
