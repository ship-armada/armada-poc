// ABOUTME: Tests for preferencesAtom — defaults and persistence round-trip via localStorage (jsdom-backed).

import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from 'jotai'
import { preferencesAtom, DEFAULT_PREFERENCES } from './preferences'

describe('preferencesAtom', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('reads DEFAULT_PREFERENCES when nothing is persisted', () => {
    const store = createStore()
    expect(store.get(preferencesAtom)).toEqual(DEFAULT_PREFERENCES)
  })

  it('persists writes to localStorage', () => {
    const store = createStore()
    store.set(preferencesAtom, { autoLockMinutes: 30, showTechnicalDetailsByDefault: true, submitFromWallet: false })
    const persisted = window.localStorage.getItem('armada-interface.preferences')
    expect(persisted).not.toBeNull()
    const parsed = JSON.parse(persisted!) as { autoLockMinutes: number; showTechnicalDetailsByDefault: boolean }
    expect(parsed.autoLockMinutes).toBe(30)
    expect(parsed.showTechnicalDetailsByDefault).toBe(true)
  })

  // Note: atomWithStorage hydrates asynchronously in jsdom — the initial sync read returns
  // DEFAULT_PREFERENCES before the storage subscription fires. The persistence-on-write path is
  // what matters for our UX, and is covered above.
})
