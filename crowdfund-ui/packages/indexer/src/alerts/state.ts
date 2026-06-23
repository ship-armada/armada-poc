// ABOUTME: Persisted "already fired" alert dedupe state, stored as JSON next to the indexer store.
// ABOUTME: Keeps a Set of dedupeKey strings; missing file is treated as empty.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AlertState {
  firedKeys: ReadonlySet<string>
}

export interface AlertStateStore {
  read(): Promise<AlertState>
  write(state: AlertState): Promise<void>
}

interface PersistedShape {
  firedKeys: string[]
}

export function createFileAlertStateStore(filePath: string): AlertStateStore {
  return {
    async read() {
      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed = JSON.parse(raw) as PersistedShape
        if (!Array.isArray(parsed.firedKeys)) return { firedKeys: new Set() }
        return { firedKeys: new Set(parsed.firedKeys.filter((k): k is string => typeof k === 'string')) }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'ENOENT') return { firedKeys: new Set() }
        throw err
      }
    },
    async write(state) {
      const persisted: PersistedShape = { firedKeys: Array.from(state.firedKeys).sort() }
      await mkdir(dirname(filePath), { recursive: true })
      // Atomic write (tmp + rename) so a crash mid-write cannot corrupt the dedupe
      // state and cause every alert to re-fire on the next tick.
      const tmpPath = `${filePath}.${process.pid}.tmp`
      await writeFile(tmpPath, JSON.stringify(persisted, null, 2) + '\n', 'utf8')
      await rename(tmpPath, filePath)
    },
  }
}

export function createInMemoryAlertStateStore(initial?: Iterable<string>): AlertStateStore {
  let state: AlertState = { firedKeys: new Set(initial ?? []) }
  return {
    async read() {
      return state
    },
    async write(next) {
      state = { firedKeys: new Set(next.firedKeys) }
    },
  }
}
