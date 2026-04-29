// ABOUTME: Unit tests for Postgres indexer schema metadata.
// ABOUTME: Guards the durable store tables needed for no-gap ingestion and snapshot recovery.

import { describe, expect, it } from 'vitest'
import { POSTGRES_SCHEMA_SQL } from './postgresStore.js'

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
