// ABOUTME: Unit tests for the per-wallet history-scan checkpoint persistence layer.
// ABOUTME: Uses jsdom localStorage; isolates each test by clearing storage in beforeEach.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearHistoryCheckpoint,
  readHistoryCheckpoint,
  writeHistoryCheckpoint,
} from './history-checkpoint'

const WALLET_A = 'rg-a'
const WALLET_B = 'rg-b'

beforeEach(() => {
  window.localStorage.clear()
})

describe('history-checkpoint', () => {
  it('returns null when no checkpoint exists', () => {
    expect(readHistoryCheckpoint(WALLET_A)).toBeNull()
  })

  it('round-trips block + scannedAt', () => {
    // WHY: the recovery hook reads `block + 1` as the next `startingBlock`. Off-by-one or
    // type-confusion here would cause the SDK to re-scan or skip a window.
    writeHistoryCheckpoint(WALLET_A, { block: 12345, scannedAt: 1_700_000_000_000 })
    expect(readHistoryCheckpoint(WALLET_A)).toEqual({
      block: 12345,
      scannedAt: 1_700_000_000_000,
    })
  })

  it('scopes checkpoints per wallet', () => {
    // WHY: a multi-wallet device (rare today; future-proofing per state/wallet.ts plural schema)
    // must not collide checkpoints. Resetting wallet A should never touch wallet B's scan resume.
    writeHistoryCheckpoint(WALLET_A, { block: 100, scannedAt: 1 })
    writeHistoryCheckpoint(WALLET_B, { block: 200, scannedAt: 2 })
    expect(readHistoryCheckpoint(WALLET_A)?.block).toBe(100)
    expect(readHistoryCheckpoint(WALLET_B)?.block).toBe(200)
    clearHistoryCheckpoint(WALLET_A)
    expect(readHistoryCheckpoint(WALLET_A)).toBeNull()
    expect(readHistoryCheckpoint(WALLET_B)?.block).toBe(200)
  })

  it('treats corrupt JSON as a missing checkpoint (graceful degrade)', () => {
    // WHY: a partially-written or schema-rotated value shouldn't crash the recovery hook.
    // Best behavior is "rescan from scratch" — equivalent to no checkpoint at all.
    window.localStorage.setItem('armada.shielded.historyScanBlock.rg-x', '{not-json')
    expect(readHistoryCheckpoint('rg-x')).toBeNull()
  })

  it('treats schema-mismatched values (missing fields) as missing', () => {
    // WHY: a future-shape migration must fail safe — read returns null so the next write
    // overwrites with the current shape. No silent half-decoded checkpoints.
    window.localStorage.setItem(
      'armada.shielded.historyScanBlock.rg-x',
      JSON.stringify({ block: 'oops' }),
    )
    expect(readHistoryCheckpoint('rg-x')).toBeNull()
  })
})
