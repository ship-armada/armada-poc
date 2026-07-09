// ABOUTME: Tests for the v2 schema-migration that wipes legacy v1 shielded-wallet state on first run.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SCHEMA_VERSION } from '@/lib/crypto/eip712'
import {
  readStoredSchemaVersion,
  runSchemaMigrationIfNeeded,
} from './schema-migration'

const SCHEMA_VERSION_KEY = 'armada.shielded.schemaVersion'
const LEGACY_WALLET_ID_KEY = 'armada.shielded.walletId'
const LEGACY_CHECKSUM_KEY = 'armada.shielded.checksum'

describe('runSchemaMigrationIfNeeded', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns SCHEMA_VERSION as the current target', () => {
    // Sanity: tests below assume SCHEMA_VERSION matches the v2 fork value.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2)
  })

  it('reads stored version as 0 when missing', () => {
    expect(readStoredSchemaVersion()).toBe(0)
  })

  it('reads stored version as 0 when malformed', () => {
    window.localStorage.setItem(SCHEMA_VERSION_KEY, 'not-a-number')
    expect(readStoredSchemaVersion()).toBe(0)
  })

  it('wipes legacy localStorage keys when version is stale', async () => {
    window.localStorage.setItem(LEGACY_WALLET_ID_KEY, 'wallet-from-v1')
    window.localStorage.setItem(LEGACY_CHECKSUM_KEY, 'check-from-v1')
    // jsdom's indexedDB stub may not be present in all test environments; the migration
    // catches and resolves on missing IDB, so this still exercises the localStorage path.
    await runSchemaMigrationIfNeeded()
    expect(window.localStorage.getItem(LEGACY_WALLET_ID_KEY)).toBeNull()
    expect(window.localStorage.getItem(LEGACY_CHECKSUM_KEY)).toBeNull()
  })

  it('marks the schema as current after a successful migration', async () => {
    await runSchemaMigrationIfNeeded()
    expect(readStoredSchemaVersion()).toBe(SCHEMA_VERSION)
  })

  it('is a no-op when the schema is already current', async () => {
    window.localStorage.setItem(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION))
    window.localStorage.setItem(LEGACY_WALLET_ID_KEY, 'preserved-because-v2')
    await runSchemaMigrationIfNeeded()
    // Legacy keys are NOT wiped when the schema is already current — they belong to the
    // v2 owner (`lib/railgun/wallet.ts`) at that point.
    expect(window.localStorage.getItem(LEGACY_WALLET_ID_KEY)).toBe('preserved-because-v2')
  })

  it('treats stale versions as needing migration', async () => {
    window.localStorage.setItem(SCHEMA_VERSION_KEY, '1')
    window.localStorage.setItem(LEGACY_WALLET_ID_KEY, 'wallet-from-v1')
    await runSchemaMigrationIfNeeded()
    expect(window.localStorage.getItem(LEGACY_WALLET_ID_KEY)).toBeNull()
    expect(readStoredSchemaVersion()).toBe(SCHEMA_VERSION)
  })
})
