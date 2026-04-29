// ABOUTME: Runtime store selection for the crowdfund indexer service and CLI.
// ABOUTME: Chooses Postgres for production durability or JSON files for local development.

import { FileIndexerStore } from './fileStore.js'
import { PostgresIndexerStore } from './postgresStore.js'
import type { IndexerStore } from './store.js'
import type { CursorState } from '../types.js'

export type IndexerStoreBackend = 'file' | 'postgres'

export interface CreateIndexerStoreOptions {
  initialCursor: CursorState
  defaultFilePath: string
}

function readStoreBackend(): IndexerStoreBackend {
  const raw = process.env.CROWDFUND_INDEXER_STORE ?? process.env.CROWDFUND_INDEXER_STORE_BACKEND
  if (!raw) return process.env.CROWDFUND_DATABASE_URL || process.env.DATABASE_URL ? 'postgres' : 'file'
  if (raw === 'file' || raw === 'postgres') return raw
  throw new Error('CROWDFUND_INDEXER_STORE must be "file" or "postgres"')
}

function readDatabaseUrl(): string {
  const value = process.env.CROWDFUND_DATABASE_URL ?? process.env.DATABASE_URL
  if (!value) throw new Error('Missing CROWDFUND_DATABASE_URL or DATABASE_URL for Postgres indexer store')
  return value
}

export function createIndexerStore(options: CreateIndexerStoreOptions): IndexerStore {
  const backend = readStoreBackend()
  if (backend === 'postgres') {
    return new PostgresIndexerStore({
      connectionString: readDatabaseUrl(),
      initialCursor: options.initialCursor,
    })
  }

  return new FileIndexerStore({
    path: process.env.CROWDFUND_INDEXER_STORE_PATH ?? options.defaultFilePath,
    initialCursor: options.initialCursor,
  })
}
