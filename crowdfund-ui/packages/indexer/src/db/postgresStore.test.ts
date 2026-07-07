// ABOUTME: Unit tests for Postgres indexer schema metadata.
// ABOUTME: Guards the durable store tables needed for no-gap ingestion and snapshot recovery.

import { describe, expect, it } from 'vitest'
import { POSTGRES_SCHEMA_SQL, PostgresIndexerStore } from './postgresStore.js'
import type { Pool } from 'pg'
import type { CursorState, IndexedRawLog, IngestRangeRecord } from '../types.js'

describe('POSTGRES_SCHEMA_SQL', () => {
  it('creates durable cursor, range, raw log, and metadata tables', () => {
    expect(POSTGRES_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS crowdfund_indexer_cursor')
    expect(POSTGRES_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS crowdfund_indexer_ranges')
    expect(POSTGRES_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS crowdfund_indexer_raw_logs')
    expect(POSTGRES_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS crowdfund_indexer_metadata')
  })

  it('enforces idempotent raw log identity and range status constraints', () => {
    expect(POSTGRES_SCHEMA_SQL).toContain('PRIMARY KEY (chain_id, contract_address, transaction_hash, log_index)')
    expect(POSTGRES_SCHEMA_SQL).toContain("status IN ('pending', 'staged', 'verified', 'failed', 'suspicious')")
    expect(POSTGRES_SCHEMA_SQL).toContain('PRIMARY KEY (from_block, to_block)')
  })
})

// A recording fake pool: captures every query so we can assert WHICH statements the
// narrow operations issue (the whole point of the perf fix is the query shape, not just
// the result). Returns canned rows for SELECTs so reads resolve.
function makeFakePool(rows: { cursor?: unknown[]; metadata?: unknown[]; ranges?: unknown[]; rawLogs?: unknown[] } = {}) {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = []
  const respond = (text: string) => {
    if (/from crowdfund_indexer_cursor/i.test(text)) return { rows: rows.cursor ?? [] }
    if (/from crowdfund_indexer_metadata/i.test(text)) return { rows: rows.metadata ?? [] }
    if (/from crowdfund_indexer_ranges/i.test(text)) return { rows: rows.ranges ?? [] }
    if (/from crowdfund_indexer_raw_logs/i.test(text)) return { rows: rows.rawLogs ?? [] }
    return { rows: [] }
  }
  const query = async (text: string, values?: readonly unknown[]) => {
    queries.push({ text, values })
    return respond(text)
  }
  const client = { query, release() {} }
  const pool = { query, connect: async () => client, end: async () => {} }
  return { pool: pool as unknown as Pool, queries }
}

const initialCursor: CursorState = {
  deployBlock: 100, confirmationDepth: 12,
  chainHead: 0, confirmedHead: 0, ingestedCursor: 99, verifiedCursor: 99,
}

const cursorRow = {
  deploy_block: 100, confirmation_depth: 12,
  chain_head: 150, confirmed_head: 138, ingested_cursor: 120, verified_cursor: 110,
}

const metaRow = {
  last_ingested_at: null, last_verified_at: null, last_reconciled_at: null,
  last_error: null, latest_snapshot_hash: null, latest_static_snapshot_url: null,
}

function makeLog(blockNumber: number, txSuffix: string): IndexedRawLog {
  return {
    chainId: 11155111,
    contractAddress: '0xF681A7c700420e5CA93f77c8988d3eED02767035',
    blockNumber,
    blockHash: '0x' + '11'.repeat(32),
    transactionHash: '0x' + txSuffix.repeat(32),
    logIndex: 0,
    topics: ['0x' + '33'.repeat(32)],
    data: '0x',
  }
}

function makeRange(): IngestRangeRecord {
  return {
    fromBlock: 120, toBlock: 129, status: 'verified', provider: 'primary/audit',
    attempts: 1, logCount: 0, digest: '0xd', fetchedAt: null, verifiedAt: null,
    lastError: null, nextRetryAt: null,
  }
}

describe('PostgresIndexerStore narrow operations', () => {
  it('appendRawLogs writes only the given logs (no full read, no range rewrite)', async () => {
    const { pool, queries } = makeFakePool({ cursor: [cursorRow] })
    const store = new PostgresIndexerStore({ pool, initialCursor })
    await store.migrate()
    queries.length = 0

    await store.appendRawLogs([makeLog(120, 'a1'), makeLog(121, 'a2')])

    const logInserts = queries.filter((q) => /insert into crowdfund_indexer_raw_logs/i.test(q.text))
    expect(logInserts).toHaveLength(2)
    expect(queries.some((q) => /select .*from crowdfund_indexer_raw_logs/i.test(q.text))).toBe(false)
    expect(queries.some((q) => /crowdfund_indexer_ranges/i.test(q.text))).toBe(false)
  })

  it('patchRange upserts exactly one range row and touches no logs', async () => {
    const { pool, queries } = makeFakePool({ cursor: [cursorRow] })
    const store = new PostgresIndexerStore({ pool, initialCursor })
    await store.migrate()
    queries.length = 0

    await store.patchRange(makeRange())

    expect(queries.filter((q) => /insert into crowdfund_indexer_ranges/i.test(q.text))).toHaveLength(1)
    expect(queries.some((q) => /raw_logs/i.test(q.text))).toBe(false)
  })

  it('readMeta does not read the raw log table', async () => {
    const { pool, queries } = makeFakePool({ cursor: [cursorRow], metadata: [metaRow], ranges: [] })
    const store = new PostgresIndexerStore({ pool, initialCursor })
    await store.migrate()
    queries.length = 0

    const meta = await store.readMeta()

    expect(meta.cursor.verifiedCursor).toBe(110)
    expect(queries.some((q) => /raw_logs/i.test(q.text))).toBe(false)
  })

  it('readLogs filters by an upper block bound', async () => {
    const { pool, queries } = makeFakePool({ rawLogs: [] })
    const store = new PostgresIndexerStore({ pool, initialCursor })
    await store.migrate()
    queries.length = 0

    await store.readLogs(150)

    const select = queries.find((q) => /select .*from crowdfund_indexer_raw_logs/i.test(q.text))
    expect(select?.text).toMatch(/block_number <= \$1/)
    expect(select?.values).toEqual([150])
  })

  it('patchMeta updates only the provided columns and skips the cursor when absent', async () => {
    const { pool, queries } = makeFakePool({ cursor: [cursorRow] })
    const store = new PostgresIndexerStore({ pool, initialCursor })
    await store.migrate()
    queries.length = 0

    await store.patchMeta({ lastError: 'boom', latestSnapshotHash: '0xhash' })

    const update = queries.find((q) => /update crowdfund_indexer_metadata/i.test(q.text))
    expect(update).toBeDefined()
    expect(update!.text).toMatch(/last_error = \$1/)
    expect(update!.text).toMatch(/latest_snapshot_hash = \$2/)
    expect(update!.values).toEqual(['boom', '0xhash'])
    expect(queries.some((q) => /insert into crowdfund_indexer_cursor/i.test(q.text))).toBe(false)
  })
})
