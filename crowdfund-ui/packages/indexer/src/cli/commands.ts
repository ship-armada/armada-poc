// ABOUTME: Operator command helpers for indexer status and repair workflows.
// ABOUTME: Keeps CLI output deterministic and testable separately from process I/O.

import { buildHealth } from '../api/health.js'
import { getRepairRanges } from '../ingest/ranges.js'
import type { BlockRange, IndexerHealth, IndexerStoreData } from '../types.js'

export type CliCommand =
  | 'status'
  | 'verify'
  | 'repair'
  | 'backfill'
  | 'rebuild-snapshot'
  | 'publish-snapshot'

export interface ParsedCliArgs {
  command: CliCommand
  fromBlock: number | null
  toBlock: number | 'latest' | null
}

export interface CliCommandResult {
  exitCode: number
  output: string
}

const COMMANDS = new Set<CliCommand>([
  'status',
  'verify',
  'repair',
  'backfill',
  'rebuild-snapshot',
  'publish-snapshot',
])

function parseBlockValue(raw: string, name: string): number | 'latest' {
  if (raw === 'latest' && name === '--to') return 'latest'
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name} block: ${raw}`)
  }
  return parsed
}

export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const [commandRaw = 'status', ...rest] = args
  if (!COMMANDS.has(commandRaw as CliCommand)) {
    throw new Error(`Unknown command: ${commandRaw}`)
  }

  let fromBlock: number | null = null
  let toBlock: number | 'latest' | null = null
  if (commandRaw === 'backfill' && rest.length === 1 && !rest[0].startsWith('--')) {
    return {
      command: 'backfill',
      fromBlock,
      toBlock: parseBlockValue(rest[0], '--to'),
    }
  }

  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (!value) throw new Error(`Missing value for ${flag}`)
    if (flag === '--from') {
      const parsed = parseBlockValue(value, flag)
      if (parsed === 'latest') throw new Error('--from cannot be latest')
      fromBlock = parsed
    } else if (flag === '--to') {
      toBlock = parseBlockValue(value, flag)
    } else {
      throw new Error(`Unknown option: ${flag}`)
    }
  }

  return {
    command: commandRaw as CliCommand,
    fromBlock,
    toBlock,
  }
}

export function getStatusHealth(data: IndexerStoreData): IndexerHealth {
  return buildHealth({
    cursor: data.cursor,
    gapRanges: getRepairRanges(data.ranges),
    lastIngestedAt: data.lastIngestedAt,
    lastVerifiedAt: data.lastVerifiedAt,
    lastReconciledAt: data.lastReconciledAt,
    lastError: data.lastError,
    latestSnapshotHash: data.latestSnapshotHash,
    latestStaticSnapshotUrl: data.latestStaticSnapshotUrl,
  })
}

export function formatRange(range: BlockRange): string {
  return `${range.fromBlock}-${range.toBlock}`
}

export function formatStatus(data: IndexerStoreData): string {
  const health = getStatusHealth(data)
  const gaps = health.gapRanges.length > 0
    ? health.gapRanges.map(formatRange).join(', ')
    : 'none'

  return [
    `status: ${health.status}`,
    `chainHead: ${health.chainHead}`,
    `confirmedHead: ${health.confirmedHead}`,
    `ingestedCursor: ${health.ingestedCursor}`,
    `verifiedCursor: ${health.verifiedCursor}`,
    `lagBlocks: ${health.lagBlocks}`,
    `gaps: ${gaps}`,
    `lastError: ${health.lastError ?? 'none'}`,
    `latestSnapshotHash: ${health.latestSnapshotHash ?? 'none'}`,
    `latestStaticSnapshotUrl: ${health.latestStaticSnapshotUrl ?? 'none'}`,
  ].join('\n')
}

// Handles the read-only `status` command. RPC-backed commands (verify/repair/backfill,
// rebuild-snapshot, publish-snapshot) are dispatched in cli/index.ts before reaching here,
// so this function intentionally accepts only `status`.
export function runReadOnlyCommand(args: ParsedCliArgs, data: IndexerStoreData): CliCommandResult {
  if (args.command !== 'status') {
    throw new Error(`runReadOnlyCommand received non-status command: ${args.command}`)
  }
  return { exitCode: 0, output: formatStatus(data) }
}
