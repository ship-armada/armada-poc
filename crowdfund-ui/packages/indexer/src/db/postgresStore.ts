// ABOUTME: Postgres-backed persistence for the resilient crowdfund indexer.
// ABOUTME: Stores cursors, range verification records, raw logs, and snapshot metadata in durable tables.

import { Pool } from 'pg'
import { getLogIdentity } from '../ingest/ranges.js'
import { createEmptyStoreData } from './fileStore.js'
import type { IndexerStore } from './store.js'
import type { CursorState, IndexedRawLog, IndexerStoreData, IngestRangeRecord, IngestRangeStatus } from '../types.js'
import type { PoolClient, PoolConfig, QueryResult } from 'pg'

export interface PostgresStoreOptions {
  connectionString?: string
  pool?: Pool
  initialCursor: CursorState
}

interface DbClient {
  query<T extends object = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>
}

interface CursorRow {
  deploy_block: number
  confirmation_depth: number
  overlap_window: number
  chain_head: number
  confirmed_head: number
  ingested_cursor: number
  verified_cursor: number
}

interface RangeRow {
  from_block: number
  to_block: number
  status: IngestRangeStatus
  provider: string
  attempts: number
  log_count: number
  digest: string | null
  fetched_at: Date | string | null
  verified_at: Date | string | null
  last_error: string | null
}

interface RawLogRow {
  chain_id: number
  contract_address: string
  block_number: number
  block_hash: string
  transaction_hash: string
  log_index: number
  topics: readonly string[] | string
  data: string
}

interface MetadataRow {
  last_ingested_at: Date | string | null
  last_verified_at: Date | string | null
  last_reconciled_at: Date | string | null
  last_error: string | null
  latest_snapshot_hash: string | null
  latest_static_snapshot_url: string | null
}

export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS crowdfund_indexer_cursor (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  deploy_block integer NOT NULL,
  confirmation_depth integer NOT NULL,
  overlap_window integer NOT NULL,
  chain_head integer NOT NULL,
  confirmed_head integer NOT NULL,
  ingested_cursor integer NOT NULL,
  verified_cursor integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crowdfund_indexer_ranges (
  from_block integer NOT NULL,
  to_block integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'staged', 'verified', 'failed', 'suspicious')),
  provider text NOT NULL,
  attempts integer NOT NULL,
  log_count integer NOT NULL,
  digest text,
  fetched_at timestamptz,
  verified_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_block, to_block),
  CHECK (from_block <= to_block)
);

CREATE TABLE IF NOT EXISTS crowdfund_indexer_raw_logs (
  chain_id integer NOT NULL,
  contract_address text NOT NULL,
  block_number integer NOT NULL,
  block_hash text NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  topics jsonb NOT NULL,
  data text NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS crowdfund_indexer_raw_logs_block_idx
  ON crowdfund_indexer_raw_logs (block_number, log_index);

CREATE TABLE IF NOT EXISTS crowdfund_indexer_metadata (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_ingested_at timestamptz,
  last_verified_at timestamptz,
  last_reconciled_at timestamptz,
  last_error text,
  latest_snapshot_hash text,
  latest_static_snapshot_url text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  return value
}

function sortRanges(ranges: readonly IngestRangeRecord[]): IngestRangeRecord[] {
  return [...ranges].sort((a, b) => {
    if (a.fromBlock !== b.fromBlock) return a.fromBlock - b.fromBlock
    return a.toBlock - b.toBlock
  })
}

function sortLogs(logs: readonly IndexedRawLog[]): IndexedRawLog[] {
  return [...logs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber
    if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex
    return a.transactionHash.localeCompare(b.transactionHash)
  })
}

function toCursor(row: CursorRow): CursorState {
  return {
    deployBlock: row.deploy_block,
    confirmationDepth: row.confirmation_depth,
    overlapWindow: row.overlap_window,
    chainHead: row.chain_head,
    confirmedHead: row.confirmed_head,
    ingestedCursor: row.ingested_cursor,
    verifiedCursor: row.verified_cursor,
  }
}

function toRange(row: RangeRow): IngestRangeRecord {
  return {
    fromBlock: row.from_block,
    toBlock: row.to_block,
    status: row.status,
    provider: row.provider,
    attempts: row.attempts,
    logCount: row.log_count,
    digest: row.digest,
    fetchedAt: toIso(row.fetched_at),
    verifiedAt: toIso(row.verified_at),
    lastError: row.last_error,
  }
}

function parseTopics(value: RawLogRow['topics']): readonly string[] {
  if (typeof value === 'string') return JSON.parse(value) as readonly string[]
  return value
}

function toRawLog(row: RawLogRow): IndexedRawLog {
  return {
    chainId: row.chain_id,
    contractAddress: row.contract_address,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
    topics: parseTopics(row.topics),
    data: row.data,
  }
}

function rangeKey(range: Pick<IngestRangeRecord, 'fromBlock' | 'toBlock'>): string {
  return `${range.fromBlock}-${range.toBlock}`
}

function dedupeLogs(logs: readonly IndexedRawLog[]): IndexedRawLog[] {
  const records = new Map<string, IndexedRawLog>()
  for (const log of logs) records.set(getLogIdentity(log), log)
  return [...records.values()]
}

async function ensureSeedRows(client: DbClient, initialCursor: CursorState): Promise<void> {
  await client.query(
    `INSERT INTO crowdfund_indexer_cursor (
      id, deploy_block, confirmation_depth, overlap_window, chain_head, confirmed_head, ingested_cursor, verified_cursor
    )
    VALUES (true, $1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO NOTHING`,
    [
      initialCursor.deployBlock,
      initialCursor.confirmationDepth,
      initialCursor.overlapWindow,
      initialCursor.chainHead,
      initialCursor.confirmedHead,
      initialCursor.ingestedCursor,
      initialCursor.verifiedCursor,
    ],
  )
  await client.query('INSERT INTO crowdfund_indexer_metadata (id) VALUES (true) ON CONFLICT (id) DO NOTHING')
}

export class PostgresIndexerStore implements IndexerStore {
  private readonly pool: Pool
  private readonly initialCursor: CursorState
  private readonly ownsPool: boolean
  private isReady = false

  constructor(options: PostgresStoreOptions) {
    this.initialCursor = options.initialCursor
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString } satisfies PoolConfig)
    this.ownsPool = options.pool === undefined
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }

  async migrate(): Promise<void> {
    await this.pool.query(POSTGRES_SCHEMA_SQL)
    await ensureSeedRows(this.pool, this.initialCursor)
    this.isReady = true
  }

  async read(): Promise<IndexerStoreData> {
    await this.ensureReady()
    return this.readWithClient(this.pool)
  }

  async write(data: IndexerStoreData): Promise<void> {
    await this.ensureReady()
    await this.withTransaction(async (client) => {
      await this.writeWithClient(client, data)
    })
  }

  async update(mutator: (data: IndexerStoreData) => IndexerStoreData): Promise<IndexerStoreData> {
    await this.ensureReady()
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('armada_crowdfund_indexer_store'))")
      const current = await this.readWithClient(client)
      const next = mutator(current)
      await this.writeWithClient(client, next)
      return next
    })
  }

  async upsertRange(record: IngestRangeRecord): Promise<IndexerStoreData> {
    return this.update((data) => {
      const records = new Map(data.ranges.map((range) => [rangeKey(range), range]))
      records.set(rangeKey(record), record)
      return {
        ...data,
        ranges: sortRanges([...records.values()]),
      }
    })
  }

  async updateCursor(cursor: CursorState): Promise<IndexerStoreData> {
    return this.update((data) => ({
      ...data,
      cursor,
    }))
  }

  async upsertRawLogs(logs: readonly IndexedRawLog[]): Promise<IndexerStoreData> {
    return this.update((data) => ({
      ...data,
      rawLogs: sortLogs(dedupeLogs([...data.rawLogs, ...logs])),
    }))
  }

  private async ensureReady(): Promise<void> {
    if (!this.isReady) await this.migrate()
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  private async readWithClient(client: DbClient): Promise<IndexerStoreData> {
    const cursor = await client.query<CursorRow>('SELECT * FROM crowdfund_indexer_cursor WHERE id = true')
    if (cursor.rows.length === 0) return createEmptyStoreData(this.initialCursor)

    const metadata = await client.query<MetadataRow>('SELECT * FROM crowdfund_indexer_metadata WHERE id = true')
    const ranges = await client.query<RangeRow>('SELECT * FROM crowdfund_indexer_ranges ORDER BY from_block, to_block')
    const rawLogs = await client.query<RawLogRow>(
      'SELECT * FROM crowdfund_indexer_raw_logs ORDER BY block_number, log_index, transaction_hash',
    )
    const meta = metadata.rows[0]

    return {
      cursor: toCursor(cursor.rows[0]),
      ranges: ranges.rows.map(toRange),
      rawLogs: rawLogs.rows.map(toRawLog),
      lastIngestedAt: meta ? toIso(meta.last_ingested_at) : null,
      lastVerifiedAt: meta ? toIso(meta.last_verified_at) : null,
      lastReconciledAt: meta ? toIso(meta.last_reconciled_at) : null,
      lastError: meta?.last_error ?? null,
      latestSnapshotHash: meta?.latest_snapshot_hash ?? null,
      latestStaticSnapshotUrl: meta?.latest_static_snapshot_url ?? null,
    }
  }

  private async writeWithClient(client: DbClient, data: IndexerStoreData): Promise<void> {
    await client.query(
      `INSERT INTO crowdfund_indexer_cursor (
        id, deploy_block, confirmation_depth, overlap_window, chain_head, confirmed_head, ingested_cursor, verified_cursor
      )
      VALUES (true, $1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        deploy_block = EXCLUDED.deploy_block,
        confirmation_depth = EXCLUDED.confirmation_depth,
        overlap_window = EXCLUDED.overlap_window,
        chain_head = EXCLUDED.chain_head,
        confirmed_head = EXCLUDED.confirmed_head,
        ingested_cursor = EXCLUDED.ingested_cursor,
        verified_cursor = EXCLUDED.verified_cursor,
        updated_at = now()`,
      [
        data.cursor.deployBlock,
        data.cursor.confirmationDepth,
        data.cursor.overlapWindow,
        data.cursor.chainHead,
        data.cursor.confirmedHead,
        data.cursor.ingestedCursor,
        data.cursor.verifiedCursor,
      ],
    )
    await client.query(
      `INSERT INTO crowdfund_indexer_metadata (
        id, last_ingested_at, last_verified_at, last_reconciled_at, last_error, latest_snapshot_hash, latest_static_snapshot_url
      )
      VALUES (true, $1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        last_ingested_at = EXCLUDED.last_ingested_at,
        last_verified_at = EXCLUDED.last_verified_at,
        last_reconciled_at = EXCLUDED.last_reconciled_at,
        last_error = EXCLUDED.last_error,
        latest_snapshot_hash = EXCLUDED.latest_snapshot_hash,
        latest_static_snapshot_url = EXCLUDED.latest_static_snapshot_url,
        updated_at = now()`,
      [
        data.lastIngestedAt,
        data.lastVerifiedAt,
        data.lastReconciledAt,
        data.lastError,
        data.latestSnapshotHash,
        data.latestStaticSnapshotUrl,
      ],
    )

    for (const range of sortRanges(data.ranges)) {
      await client.query(
        `INSERT INTO crowdfund_indexer_ranges (
          from_block, to_block, status, provider, attempts, log_count, digest, fetched_at, verified_at, last_error
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (from_block, to_block) DO UPDATE SET
          status = EXCLUDED.status,
          provider = EXCLUDED.provider,
          attempts = EXCLUDED.attempts,
          log_count = EXCLUDED.log_count,
          digest = EXCLUDED.digest,
          fetched_at = EXCLUDED.fetched_at,
          verified_at = EXCLUDED.verified_at,
          last_error = EXCLUDED.last_error,
          updated_at = now()`,
        [
          range.fromBlock,
          range.toBlock,
          range.status,
          range.provider,
          range.attempts,
          range.logCount,
          range.digest,
          range.fetchedAt,
          range.verifiedAt,
          range.lastError,
        ],
      )
    }

    for (const log of sortLogs(dedupeLogs(data.rawLogs))) {
      await client.query(
        `INSERT INTO crowdfund_indexer_raw_logs (
          chain_id, contract_address, block_number, block_hash, transaction_hash, log_index, topics, data
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        ON CONFLICT (chain_id, contract_address, transaction_hash, log_index) DO UPDATE SET
          block_number = EXCLUDED.block_number,
          block_hash = EXCLUDED.block_hash,
          topics = EXCLUDED.topics,
          data = EXCLUDED.data`,
        [
          log.chainId,
          log.contractAddress.toLowerCase(),
          log.blockNumber,
          log.blockHash,
          log.transactionHash,
          log.logIndex,
          JSON.stringify(log.topics),
          log.data,
        ],
      )
    }
  }
}
