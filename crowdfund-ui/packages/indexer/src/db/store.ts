// ABOUTME: Persistence interface shared by JSON and Postgres indexer stores.
// ABOUTME: Keeps ingestion, API, and CLI code independent from the storage backend.

import type { CursorState, IndexedRawLog, IndexerStoreData, IngestRangeRecord } from '../types.js'

export interface IndexerStore {
  read(): Promise<IndexerStoreData>
  write(data: IndexerStoreData): Promise<void>
  update(mutator: (data: IndexerStoreData) => IndexerStoreData): Promise<IndexerStoreData>
  upsertRange(record: IngestRangeRecord): Promise<IndexerStoreData>
  updateCursor(cursor: CursorState): Promise<IndexerStoreData>
  upsertRawLogs(logs: readonly IndexedRawLog[]): Promise<IndexerStoreData>
}
