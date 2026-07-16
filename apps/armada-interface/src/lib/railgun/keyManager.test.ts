// ABOUTME: Tests for lib/railgun/keyManager — set/get/clear, locked-state throws, best-effort zeroization of the rootSecret buffer on clear.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  setUnlocked,
  isUnlocked,
  getRootSecret,
  getWalletId,
  getSdkEncryptionKey,
  getRailgunAddress,
  getChecksum,
  getCreationBlock,
  getHistoryEncryptionKey,
  deriveChecksum,
  clear,
} from './keyManager'

function makeState(seed = 1, creationBlock: number | null = 100) {
  const rootSecret = new Uint8Array(32)
  for (let i = 0; i < 32; i++) rootSecret[i] = (seed + i) & 0xff
  // Phase 7: keyManager now also holds a historyEncryptionKey for at-rest tx-record AES-GCM.
  // Fixture uses a distinct seed so a copy-paste of rootSecret won't mask a bug.
  const historyEncryptionKey = new Uint8Array(32)
  for (let i = 0; i < 32; i++) historyEncryptionKey[i] = (seed + 64 + i) & 0xff
  return {
    rootSecret,
    walletId: 'wallet-id-xyz',
    sdkEncryptionKey: 'ff'.repeat(32),
    railgunAddress: '0zk1qexample…',
    checksum: 'a3f2 91c8 b7e0',
    creationBlock,
    evmAddress: null as `0x${string}` | null,
    account: 0n,
    historyEncryptionKey,
  }
}

beforeEach(() => {
  clear()
})

describe('setUnlocked + getters', () => {
  it('starts in locked state', () => {
    expect(isUnlocked()).toBe(false)
  })

  it('marks unlocked once set', () => {
    setUnlocked(makeState())
    expect(isUnlocked()).toBe(true)
  })

  it('exposes the stored values via getters', () => {
    const s = makeState()
    setUnlocked(s)
    expect(getRootSecret()).toBe(s.rootSecret) // same reference, not a copy
    expect(getWalletId()).toBe(s.walletId)
    expect(getSdkEncryptionKey()).toBe(s.sdkEncryptionKey)
    expect(getRailgunAddress()).toBe(s.railgunAddress)
    expect(getChecksum()).toBe(s.checksum)
  })

  it('rejects a rootSecret of the wrong length', () => {
    expect(() =>
      setUnlocked({
        rootSecret: new Uint8Array(16),
        walletId: 'x',
        sdkEncryptionKey: 'y',
        railgunAddress: 'z',
        checksum: 'cs',
        creationBlock: 0,
        evmAddress: null,
        account: 0n,
        historyEncryptionKey: new Uint8Array(32),
      }),
    ).toThrow(/32 bytes/)
  })

  it('exposes creationBlock when set', () => {
    // WHY: exportBackup reads getCreationBlock() to write the v2 blob. A null in-session
    // value writes 0 (the "unknown" sentinel); a populated value preserves the true
    // first-enrollment block so restores can fast-skip to the right tree position.
    setUnlocked(makeState(1, 12345))
    expect(getCreationBlock()).toBe(12345)
  })

  it('returns null from getCreationBlock when in-session value is null (paste-restore path)', () => {
    setUnlocked(makeState(1, null))
    expect(getCreationBlock()).toBeNull()
  })

  it('returns null from getCreationBlock when locked — does NOT throw', () => {
    // WHY: differs from other getters (which throw when locked). exportBackup is the only
    // caller; it needs to read defensively without crashing if a race locks mid-export.
    expect(getCreationBlock()).toBeNull()
  })
})

describe('locked-state behavior', () => {
  it('throws on every getter when locked', () => {
    expect(() => getRootSecret()).toThrow(/locked/)
    expect(() => getWalletId()).toThrow(/locked/)
    expect(() => getSdkEncryptionKey()).toThrow(/locked/)
    expect(() => getRailgunAddress()).toThrow(/locked/)
    expect(() => getChecksum()).toThrow(/locked/)
    expect(() => deriveChecksum()).toThrow(/locked/)
  })

  it('throws on getters after clear()', () => {
    setUnlocked(makeState())
    clear()
    expect(isUnlocked()).toBe(false)
    expect(() => getRootSecret()).toThrow(/locked/)
  })
})

describe('clear() zeroizes the rootSecret buffer (best-effort)', () => {
  it('overwrites the buffer contents with zeros', () => {
    const s = makeState()
    const buffer = s.rootSecret
    expect(buffer.some(b => b !== 0)).toBe(true)
    setUnlocked(s)
    clear()
    expect(buffer.every(b => b === 0)).toBe(true)
  })

  it('also zeroizes the historyEncryptionKey buffer (Phase 7)', () => {
    const s = makeState()
    const buffer = s.historyEncryptionKey
    expect(buffer.some(b => b !== 0)).toBe(true)
    setUnlocked(s)
    clear()
    expect(buffer.every(b => b === 0)).toBe(true)
  })
})

describe('getHistoryEncryptionKey (Phase 7)', () => {
  it('exposes the stored key when unlocked', () => {
    const s = makeState()
    setUnlocked(s)
    expect(getHistoryEncryptionKey()).toBe(s.historyEncryptionKey)
  })

  it('throws when locked', () => {
    expect(() => getHistoryEncryptionKey()).toThrow(/locked/)
  })

  it('throws after clear()', () => {
    setUnlocked(makeState())
    clear()
    expect(() => getHistoryEncryptionKey()).toThrow(/locked/)
  })
})

describe('deriveChecksum', () => {
  it('recomputes from the current rootSecret (matches the stored display string when set correctly)', () => {
    // The keyManager exposes both the stored checksum and a re-derive function so callers can
    // detect mismatches. Here we just verify deriveChecksum() returns the spec format.
    setUnlocked(makeState())
    const cs = deriveChecksum()
    expect(cs).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/)
  })
})
