// ABOUTME: JSON-file backed persistence for indexer cursor, range, and snapshot metadata.
// ABOUTME: Provides a durable development store with atomic writes before a production DB is selected.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getLogIdentity } from '../ingest/ranges.js'
import type { IndexerStore } from './store.js'
import type { CursorState, IndexedRawLog, IndexerStoreData, IngestRangeRecord } from '../types.js'

export interface FileStoreOptions {
  path: string
  initialCursor: CursorState
}

function rangeKey(range: Pick<IngestRangeRecord, 'fromBlock' | 'toBlock'>): string {
  return `${range.fromBlock}-${range.toBlock}`
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

export function createEmptyStoreData(cursor: CursorState): IndexerStoreData {
  return {
    cursor,
    ranges: [],
    rawLogs: [],
    lastIngestedAt: null,
    lastVerifiedAt: null,
    lastReconciledAt: null,
    lastError: null,
    latestSnapshotHash: null,
    latestStaticSnapshotUrl: null,
  }
}

export class FileIndexerStore implements IndexerStore {
  private readonly path: string
  private readonly initialCursor: CursorState

  constructor(options: FileStoreOptions) {
    this.path = options.path
    this.initialCursor = options.initialCursor
  }

  get filePath(): string {
    return this.path
  }

  async read(): Promise<IndexerStoreData> {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as IndexerStoreData
      return {
        ...parsed,
        ranges: sortRanges(parsed.ranges),
        rawLogs: sortLogs(parsed.rawLogs ?? []),
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return createEmptyStoreData(this.initialCursor)
      }
      throw err
    }
  }

  async write(data: IndexerStoreData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const normalized: IndexerStoreData = {
      ...data,
      ranges: sortRanges(data.ranges),
      rawLogs: sortLogs(data.rawLogs),
    }
    const tmpPath = `${this.path}.${process.pid}.tmp`
    await writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await rename(tmpPath, this.path)
  }

  async update(mutator: (data: IndexerStoreData) => IndexerStoreData): Promise<IndexerStoreData> {
    const current = await this.read()
    const next = mutator(current)
    await this.write(next)
    return next
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
    return this.update((data) => {
      const records = new Map(data.rawLogs.map((log) => [getLogIdentity(log), log]))
      for (const log of logs) records.set(getLogIdentity(log), log)
      return {
        ...data,
        rawLogs: sortLogs([...records.values()]),
      }
    })
  }
}
