// ABOUTME: Tests for lib/tx/storage — Phase 7 AES-256-GCM at-rest encryption of tx records under the active wallet's historyEncryptionKey.
// ABOUTME: Mocks lib/cache to a flat in-memory map so we can inspect ciphertexts directly and prove foreign-key reads return [] / fresh writes overwrite garbage.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the IDB-backed cache layer with an in-memory map so we can inspect what storage.ts
// actually persists (envelope shape, ciphertext, etc.) and seed foreign-key blobs directly.
const hoisted = vi.hoisted(() => {
  const store = new Map<string, unknown>()
  return {
    store,
    cacheGet: vi.fn(async (_storeName: string, key: string) => store.get(key)),
    cachePut: vi.fn(async (_storeName: string, key: string, value: unknown) => {
      store.set(key, value)
    }),
    cacheDelete: vi.fn(async (_storeName: string, key: string) => {
      store.delete(key)
    }),
    cacheAll: vi.fn(async (_storeName: string) => {
      return Array.from(store.entries()).map(([key, value]) => ({ key, value }))
    }),
  }
})

vi.mock('../cache', () => ({
  cacheGet: hoisted.cacheGet,
  cachePut: hoisted.cachePut,
  cacheDelete: hoisted.cacheDelete,
  cacheAll: hoisted.cacheAll,
}))

import { putTxIfFresh, putTx, loadAllTx, deleteTx } from './storage'
import { setUnlocked, clear } from '../railgun/keyManager'
import { isEncryptedBlob, wrap } from '../crypto/cache-cipher'
import type { TxRecord } from './types'

function fixture(id: string, walletId: string, updatedSeq: number = 1): TxRecord<'shield'> {
  return {
    id,
    kind: 'shield',
    executionState: 'completed',
    stage: 'hub-confirmed',
    stagesCompleted: ['build-proof'],
    updatedSeq,
    createdAt: 0,
    updatedAt: id.length * 1000, // deterministic order via id length
    meta: { amount: 1_000_000n, feeCacheId: '', fromChainId: 31337 },
    artifacts: {},
    walletContext: {
      evmAddress: '0xabc',
      railgunWalletId: walletId,
      sourceChainId: 31337,
    },
  } as TxRecord<'shield'>
}

function makeKey(seed: number): Uint8Array {
  const k = new Uint8Array(32)
  for (let i = 0; i < 32; i++) k[i] = (seed + i) & 0xff
  return k
}

function unlock(walletId: string, historyKeySeed: number = 1) {
  const rootSecret = new Uint8Array(32)
  for (let i = 0; i < 32; i++) rootSecret[i] = (1 + i) & 0xff
  setUnlocked({
    rootSecret,
    walletId,
    sdkEncryptionKey: 'ff'.repeat(32),
    railgunAddress: '0zk1example',
    checksum: 'a3f2 91c8 b7e0',
    creationBlock: null,
    evmAddress: null,
    account: 0n,
    historyEncryptionKey: makeKey(historyKeySeed),
  })
}

beforeEach(() => {
  hoisted.store.clear()
  hoisted.cacheGet.mockClear()
  hoisted.cachePut.mockClear()
  hoisted.cacheDelete.mockClear()
  hoisted.cacheAll.mockClear()
  clear() // reset keyManager between tests
})

describe('encrypted writes', () => {
  it('wraps the record in an EncryptedBlob envelope when unlocked', async () => {
    unlock('rg-1')
    const r = fixture('tx-1', 'rg-1')
    await putTxIfFresh(r)
    const stored = hoisted.store.get('tx-1')
    expect(isEncryptedBlob(stored)).toBe(true)
    // No plaintext walletId leaks into the envelope.
    expect(stored).not.toHaveProperty('walletId')
    expect(stored).not.toHaveProperty('id')
  })

  it('uses a fresh nonce per write — same record body, different ciphertext', async () => {
    unlock('rg-1')
    const r = fixture('tx-1', 'rg-1')
    await putTx(r)
    const a = hoisted.store.get('tx-1') as { nonce: string; ciphertext: string }
    await putTx(r)
    const b = hoisted.store.get('tx-1') as { nonce: string; ciphertext: string }
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('throws synchronously when the wallet is locked (no plaintext on disk)', async () => {
    // No unlock() — keyManager is locked.
    await expect(putTxIfFresh(fixture('tx-1', 'rg-1'))).rejects.toThrow(/locked/)
    await expect(putTx(fixture('tx-1', 'rg-1'))).rejects.toThrow(/locked/)
    expect(hoisted.store.size).toBe(0)
  })

  it('OCC: rejects a stale updatedSeq', async () => {
    unlock('rg-1')
    await putTxIfFresh(fixture('tx-1', 'rg-1', 2))
    // Stale write (lower seq) — should be rejected.
    const ok = await putTxIfFresh(fixture('tx-1', 'rg-1', 1))
    expect(ok).toBe(false)
  })

  it('OCC: accepts a fresher updatedSeq', async () => {
    unlock('rg-1')
    await putTxIfFresh(fixture('tx-1', 'rg-1', 1))
    const ok = await putTxIfFresh(fixture('tx-1', 'rg-1', 2))
    expect(ok).toBe(true)
  })
})

describe('encrypted reads (loadAllTx)', () => {
  it('round-trips a single record', async () => {
    unlock('rg-1')
    const original = fixture('tx-1', 'rg-1')
    await putTx(original)
    const records = await loadAllTx('rg-1')
    expect(records).toHaveLength(1)
    expect(records[0]!.id).toBe('tx-1')
    // BigInt should round-trip correctly through the JSON sentinel.
    expect(records[0]!.meta.amount).toBe(1_000_000n)
    expect(typeof records[0]!.meta.amount).toBe('bigint')
  })

  it('returns [] when no walletId is supplied', async () => {
    unlock('rg-1')
    await putTx(fixture('tx-1', 'rg-1'))
    expect(await loadAllTx()).toEqual([])
  })

  it('returns [] when keyManager is locked even with a walletId supplied', async () => {
    // First unlock + write so there's something on disk; then lock.
    unlock('rg-1')
    await putTx(fixture('tx-1', 'rg-1'))
    clear()
    expect(await loadAllTx('rg-1')).toEqual([])
  })

  it('skips foreign-wallet records (records written under a different historyEncryptionKey)', async () => {
    // Seed the store directly with an envelope written under a DIFFERENT key — simulates the
    // case where another wallet had previously written records and the active wallet is now
    // hydrating. Without Phase 7's decrypt-as-isolation, those records would surface in the
    // active wallet's history.
    const foreignKey = makeKey(99)
    const foreignRecord = fixture('foreign-tx', 'rg-2')
    hoisted.store.set('foreign-tx', wrap(foreignRecord, foreignKey))

    unlock('rg-1', 1) // active wallet uses key seed 1
    // Active wallet writes one of its own.
    await putTx(fixture('own-tx', 'rg-1'))

    const records = await loadAllTx('rg-1')
    expect(records.map(r => r.id)).toEqual(['own-tx'])
  })

  it('skips pre-Phase-7 plaintext records left over from v6 (isEncryptedBlob shape check)', async () => {
    // Seed a legacy plaintext record (the v6 storage layer wrote raw TxRecords).
    const legacy = fixture('legacy-tx', 'rg-1')
    hoisted.store.set('legacy-tx', legacy as unknown)

    unlock('rg-1')
    const records = await loadAllTx('rg-1')
    expect(records).toEqual([])
  })

  it('post-decrypt walletId filter excludes records matching a key but bound to a different walletId', async () => {
    // Defensive case: same historyEncryptionKey but different walletContext.railgunWalletId
    // (e.g. a malicious or buggy write). The decrypt succeeds; the walletId mismatch filters it.
    unlock('rg-1', 1)
    const mine = fixture('mine', 'rg-1')
    const wrongId = fixture('wrong-id', 'rg-other') // same key, different walletId
    await putTx(mine)
    await putTx(wrongId)
    const records = await loadAllTx('rg-1')
    expect(records.map(r => r.id)).toEqual(['mine'])
  })

  it('sorts records by updatedAt desc', async () => {
    unlock('rg-1')
    // updatedAt is set from id.length * 1000 in our fixture, so longer ids → later.
    await putTx(fixture('a', 'rg-1'))      // updatedAt 1000
    await putTx(fixture('aa', 'rg-1'))     // updatedAt 2000
    await putTx(fixture('aaaa', 'rg-1'))   // updatedAt 4000
    const records = await loadAllTx('rg-1')
    expect(records.map(r => r.id)).toEqual(['aaaa', 'aa', 'a'])
  })
})

describe('deleteTx', () => {
  it('removes an entry by id', async () => {
    unlock('rg-1')
    await putTx(fixture('tx-1', 'rg-1'))
    await deleteTx('tx-1')
    expect(hoisted.store.has('tx-1')).toBe(false)
  })

  it('does not require an unlocked wallet (cache delete is a plain DROP)', async () => {
    hoisted.store.set('tx-1', { nonce: 'aa', ciphertext: 'bb' })
    await deleteTx('tx-1')
    expect(hoisted.store.has('tx-1')).toBe(false)
  })
})
