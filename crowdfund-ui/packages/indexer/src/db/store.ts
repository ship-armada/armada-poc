// ABOUTME: Persistence interface shared by JSON and Postgres indexer stores.
// ABOUTME: Keeps ingestion, API, and CLI code independent from the storage backend.

import type { CursorState, IndexedRawLog, IndexerStoreData, IngestRangeRecord } from '../types.js'

// Metadata view of the store without the (potentially large) raw-log set. Hot paths that
// only need cursor/range/metadata state read this instead of the whole store.
export type IndexerMeta = Omit<IndexerStoreData, 'rawLogs'>

// Partial metadata update. A field left `undefined` is untouched; an explicit `null`
// clears it. `cursor`, when present, replaces the cursor wholesale.
export interface IndexerMetaPatch {
  cursor?: CursorState
  lastIngestedAt?: string | null
  lastVerifiedAt?: string | null
  lastReconciledAt?: string | null
  lastError?: string | null
  latestSnapshotHash?: string | null
  latestStaticSnapshotUrl?: string | null
}

export interface IndexerStore {
  read(): Promise<IndexerStoreData>
  write(data: IndexerStoreData): Promise<void>
  update(mutator: (data: IndexerStoreData) => IndexerStoreData): Promise<IndexerStoreData>
  upsertRange(record: IngestRangeRecord): Promise<IndexerStoreData>
  updateCursor(cursor: CursorState): Promise<IndexerStoreData>
  upsertRawLogs(logs: readonly IndexedRawLog[]): Promise<IndexerStoreData>

  // Narrow operations — touch only the affected rows so hot ingest/API paths avoid the
  // whole-store read-modify-write cost (critical for the Postgres backend, where the
  // legacy update() rewrites every range and log row on each call).
  readMeta(): Promise<IndexerMeta>
  readLogs(upToBlock?: number): Promise<readonly IndexedRawLog[]>
  appendRawLogs(logs: readonly IndexedRawLog[]): Promise<void>
  patchRange(record: IngestRangeRecord): Promise<void>
  patchMeta(patch: IndexerMetaPatch): Promise<void>
}

// Applies a metadata patch to an in-memory store snapshot (used by the file store and as
// the reference semantics for the Postgres patchMeta implementation).
export function applyMetaPatch(data: IndexerStoreData, patch: IndexerMetaPatch): IndexerStoreData {
  return {
    ...data,
    cursor: patch.cursor ?? data.cursor,
    lastIngestedAt: patch.lastIngestedAt !== undefined ? patch.lastIngestedAt : data.lastIngestedAt,
    lastVerifiedAt: patch.lastVerifiedAt !== undefined ? patch.lastVerifiedAt : data.lastVerifiedAt,
    lastReconciledAt: patch.lastReconciledAt !== undefined ? patch.lastReconciledAt : data.lastReconciledAt,
    lastError: patch.lastError !== undefined ? patch.lastError : data.lastError,
    latestSnapshotHash: patch.latestSnapshotHash !== undefined ? patch.latestSnapshotHash : data.latestSnapshotHash,
    latestStaticSnapshotUrl:
      patch.latestStaticSnapshotUrl !== undefined ? patch.latestStaticSnapshotUrl : data.latestStaticSnapshotUrl,
  }
}
