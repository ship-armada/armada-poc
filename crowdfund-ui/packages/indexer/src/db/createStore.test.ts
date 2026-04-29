// ABOUTME: Unit tests for runtime indexer store backend selection.
// ABOUTME: Verifies production Postgres selection remains explicit while file storage stays available for local runs.

import { afterEach, describe, expect, it } from 'vitest'
import { createIndexerStore } from './createStore.js'
import { FileIndexerStore } from './fileStore.js'
import { PostgresIndexerStore } from './postgresStore.js'
import type { CursorState } from '../types.js'

const originalStore = process.env.CROWDFUND_INDEXER_STORE
const originalStoreBackend = process.env.CROWDFUND_INDEXER_STORE_BACKEND
const originalDatabaseUrl = process.env.CROWDFUND_DATABASE_URL
const originalGenericDatabaseUrl = process.env.DATABASE_URL

const cursor: CursorState = {
  deployBlock: 100,
  confirmationDepth: 12,
  overlapWindow: 100,
  chainHead: 100,
  confirmedHead: 100,
  ingestedCursor: 99,
  verifiedCursor: 99,
}

afterEach(() => {
  process.env.CROWDFUND_INDEXER_STORE = originalStore
  process.env.CROWDFUND_INDEXER_STORE_BACKEND = originalStoreBackend
  process.env.CROWDFUND_DATABASE_URL = originalDatabaseUrl
  process.env.DATABASE_URL = originalGenericDatabaseUrl
})

describe('createIndexerStore', () => {
  it('uses file storage by default when no database URL is configured', () => {
    delete process.env.CROWDFUND_INDEXER_STORE
    delete process.env.CROWDFUND_INDEXER_STORE_BACKEND
    delete process.env.CROWDFUND_DATABASE_URL
    delete process.env.DATABASE_URL

    const store = createIndexerStore({
      defaultFilePath: '/tmp/crowdfund-indexer-store.json',
      initialCursor: cursor,
    })

    expect(store).toBeInstanceOf(FileIndexerStore)
  })

  it('uses Postgres when a database URL is configured', () => {
    delete process.env.CROWDFUND_INDEXER_STORE
    delete process.env.CROWDFUND_INDEXER_STORE_BACKEND
    process.env.CROWDFUND_DATABASE_URL = 'postgres://user:pass@localhost:5432/crowdfund'
    delete process.env.DATABASE_URL

    const store = createIndexerStore({
      defaultFilePath: '/tmp/crowdfund-indexer-store.json',
      initialCursor: cursor,
    })

    expect(store).toBeInstanceOf(PostgresIndexerStore)
  })

  it('rejects unknown storage backends', () => {
    process.env.CROWDFUND_INDEXER_STORE = 'sqlite'

    expect(() => createIndexerStore({
      defaultFilePath: '/tmp/crowdfund-indexer-store.json',
      initialCursor: cursor,
    })).toThrow('CROWDFUND_INDEXER_STORE must be "file" or "postgres"')
  })
})
