// ABOUTME: Unit tests for indexer operator CLI command parsing and status output.
// ABOUTME: Ensures repair-oriented commands are accepted and status reflects store health.

import { describe, expect, it } from 'vitest'
import { formatStatus, parseCliArgs, runReadOnlyCommand } from './commands.js'
import type { CursorState, IndexerStoreData, IngestRangeRecord } from '../types.js'

const cursor: CursorState = {
  deployBlock: 100,
  confirmationDepth: 12,
  overlapWindow: 100,
  chainHead: 150,
  confirmedHead: 138,
  ingestedCursor: 138,
  verifiedCursor: 110,
}

function makeRange(overrides: Partial<IngestRangeRecord>): IngestRangeRecord {
  return {
    fromBlock: 120,
    toBlock: 129,
    status: 'failed',
    provider: 'primary',
    attempts: 2,
    logCount: 0,
    digest: null,
    fetchedAt: null,
    verifiedAt: null,
    lastError: 'RPC timeout',
    ...overrides,
  }
}

const storeData: IndexerStoreData = {
  cursor,
  ranges: [makeRange({})],
  rawLogs: [],
  lastIngestedAt: '2026-04-28T00:00:00.000Z',
  lastVerifiedAt: '2026-04-28T00:00:01.000Z',
  lastReconciledAt: null,
  lastError: 'RPC timeout',
  latestSnapshotHash: '0xabc',
  latestStaticSnapshotUrl: 'https://example.com/latest.json',
}

describe('CLI commands', () => {
  it('parses status as the default command', () => {
    expect(parseCliArgs([])).toEqual({
      command: 'status',
      fromBlock: null,
      toBlock: null,
    })
  })

  it('parses repair ranges with latest as an upper bound', () => {
    expect(parseCliArgs(['repair', '--from', '120', '--to', 'latest'])).toEqual({
      command: 'repair',
      fromBlock: 120,
      toBlock: 'latest',
    })
  })

  it('formats status with cursor, gap, and snapshot details', () => {
    expect(formatStatus(storeData)).toContain('status: unhealthy')
    expect(formatStatus(storeData)).toContain('verifiedCursor: 110')
    expect(formatStatus(storeData)).toContain('gaps: 120-129')
    expect(formatStatus(storeData)).toContain('latestSnapshotHash: 0xabc')
  })

  it('accepts repair workflow commands before RPC implementations are wired', () => {
    const result = runReadOnlyCommand(parseCliArgs(['publish-snapshot', '--from', '120', '--to', '129']), storeData)

    expect(result.exitCode).toBe(0)
    expect(result.output).toBe(
      'publish-snapshot command accepted for range 120-129; RPC-backed implementation will run in the next indexer slice.',
    )
  })

  it('parses backfill command', () => {
    expect(parseCliArgs(['backfill', '--to', 'latest'])).toEqual({
      command: 'backfill',
      fromBlock: null,
      toBlock: 'latest',
    })
  })

  it('parses backfill positional upper bound for nested npm scripts', () => {
    expect(parseCliArgs(['backfill', 'latest'])).toEqual({
      command: 'backfill',
      fromBlock: null,
      toBlock: 'latest',
    })
  })
})
