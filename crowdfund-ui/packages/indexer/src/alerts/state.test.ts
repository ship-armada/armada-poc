// ABOUTME: Unit tests for alert-state persistence — file roundtrip + missing-file behavior.
// ABOUTME: Uses a tmp directory; cleans up between tests.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileAlertStateStore, createInMemoryAlertStateStore } from './state.js'

describe('createInMemoryAlertStateStore', () => {
  it('roundtrips a Set of dedupe keys', async () => {
    const store = createInMemoryAlertStateStore(['A1'])
    expect((await store.read()).firedKeys.has('A1')).toBe(true)
    await store.write({ firedKeys: new Set(['A1', 'A11']) })
    expect(Array.from((await store.read()).firedKeys).sort()).toEqual(['A1', 'A11'])
  })
})

describe('createFileAlertStateStore', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'alert-state-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns empty state when file does not exist', async () => {
    const store = createFileAlertStateStore(join(dir, 'state.json'))
    const state = await store.read()
    expect(state.firedKeys.size).toBe(0)
  })

  it('writes and reads back a sorted, persistent state', async () => {
    const store = createFileAlertStateStore(join(dir, 'state.json'))
    await store.write({ firedKeys: new Set(['A11', 'A1', 'A4:80']) })
    const reread = await store.read()
    expect(Array.from(reread.firedKeys).sort()).toEqual(['A1', 'A11', 'A4:80'])
  })

  it('overwrites prior state cleanly (atomic replace, no leftover temp file)', async () => {
    const path = join(dir, 'state.json')
    const store = createFileAlertStateStore(path)
    await store.write({ firedKeys: new Set(['A1']) })
    await store.write({ firedKeys: new Set(['A2']) })
    const reread = await store.read()
    expect(Array.from(reread.firedKeys)).toEqual(['A2'])
    // The atomic write must not leave its temp file behind.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])
  })
})
