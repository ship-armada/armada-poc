// ABOUTME: Environment configuration parsing for the crowdfund indexer service.
// ABOUTME: Single source of truth for env readers, the initial cursor, and runtime config.

import type { CursorState } from './types.js'

export interface IndexerConfig {
  chainId: number
  contractAddress: string
  deployBlock: number
  // Optional so the API can run read-only without an RPC; required only when polling.
  primaryRpcUrl: string | null
  auditRpcUrl: string | null
  confirmationDepth: number
  overlapWindow: number
  maxBlockRange: number
  port: number
  staleAfterMs: number
  repairMaxAttempts: number
  repairBackoffBaseMs: number
  repairBackoffMaxMs: number
  pollOnStart: boolean
  backfillOnStart: boolean
  publishOnPoll: boolean
  pollIntervalMs: number
  errorBackoffMs: number
  rpcTimeoutMs: number
  rpcMaxRetries: number
  retryBaseDelayMs: number
  retryJitterMs: number
  snapshotPublishIntervalMs: number
}

export function readRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`)
  }
  return parsed
}

export function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (!value) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Invalid boolean environment variable: ${name}`)
}

export function getInitialCursor(): CursorState {
  const deployBlock = readNumberEnv('CROWDFUND_DEPLOY_BLOCK', 0)
  return {
    deployBlock,
    confirmationDepth: readNumberEnv('CROWDFUND_CONFIRMATION_DEPTH', 12),
    overlapWindow: readNumberEnv('CROWDFUND_OVERLAP_WINDOW', 100),
    chainHead: deployBlock,
    confirmedHead: deployBlock,
    ingestedCursor: deployBlock > 0 ? deployBlock - 1 : 0,
    verifiedCursor: deployBlock > 0 ? deployBlock - 1 : 0,
  }
}

export function loadIndexerConfig(): IndexerConfig {
  return {
    chainId: readNumberEnv('CROWDFUND_CHAIN_ID', 11155111),
    contractAddress: readRequiredEnv('CROWDFUND_CONTRACT_ADDRESS'),
    deployBlock: readNumberEnv('CROWDFUND_DEPLOY_BLOCK', 0),
    primaryRpcUrl: process.env.CROWDFUND_PRIMARY_RPC_URL ?? null,
    auditRpcUrl: process.env.CROWDFUND_AUDIT_RPC_URL ?? null,
    confirmationDepth: readNumberEnv('CROWDFUND_CONFIRMATION_DEPTH', 12),
    overlapWindow: readNumberEnv('CROWDFUND_OVERLAP_WINDOW', 100),
    maxBlockRange: readNumberEnv('CROWDFUND_MAX_BLOCK_RANGE', 500),
    port: readNumberEnv('CROWDFUND_INDEXER_PORT', 3002),
    staleAfterMs: readNumberEnv('CROWDFUND_STALE_AFTER_MS', 300_000),
    repairMaxAttempts: readNumberEnv('CROWDFUND_REPAIR_MAX_ATTEMPTS', 6),
    repairBackoffBaseMs: readNumberEnv('CROWDFUND_REPAIR_BACKOFF_BASE_MS', 30_000),
    repairBackoffMaxMs: readNumberEnv('CROWDFUND_REPAIR_BACKOFF_MAX_MS', 1_800_000),
    pollOnStart: readBooleanEnv('CROWDFUND_POLL_ON_START', false),
    backfillOnStart: readBooleanEnv('CROWDFUND_BACKFILL_ON_START', false),
    publishOnPoll: readBooleanEnv('CROWDFUND_PUBLISH_ON_POLL', false),
    pollIntervalMs: readNumberEnv('CROWDFUND_POLL_INTERVAL_MS', 15_000),
    errorBackoffMs: readNumberEnv('CROWDFUND_POLL_ERROR_BACKOFF_MS', 60_000),
    rpcTimeoutMs: readNumberEnv('CROWDFUND_RPC_TIMEOUT_MS', 15_000),
    rpcMaxRetries: readNumberEnv('CROWDFUND_RPC_MAX_RETRIES', 3),
    retryBaseDelayMs: readNumberEnv('CROWDFUND_RPC_RETRY_BASE_DELAY_MS', 1_000),
    retryJitterMs: readNumberEnv('CROWDFUND_RPC_RETRY_JITTER_MS', 250),
    snapshotPublishIntervalMs: readNumberEnv('CROWDFUND_SNAPSHOT_PUBLISH_INTERVAL_MS', 60_000),
  }
}
