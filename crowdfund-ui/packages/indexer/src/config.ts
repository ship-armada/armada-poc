// ABOUTME: Environment configuration parsing for the crowdfund indexer service.
// ABOUTME: Single source of truth for env readers, the initial cursor, and runtime config.

import type { CursorState } from './types.js'
import {
  CROWDFUND_PROFILE,
  CROWDFUND_PROFILES,
  isCrowdfundProfile,
  type CrowdfundProfile,
} from '../../shared/src/lib/constants.js'

export interface IndexerConfig {
  chainId: number
  contractAddress: string
  deployBlock: number
  // Optional so the API can run read-only without an RPC; required only when polling.
  primaryRpcUrl: string | null
  auditRpcUrl: string | null
  confirmationDepth: number
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
  profile: CrowdfundProfile
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

/** Like readNumberEnv but with no fallback — for values where a wrong default is
 *  dangerous (e.g. CROWDFUND_CHAIN_ID: silently defaulting to a testnet chain id
 *  would let a mainnet box index/label itself as the wrong network). */
export function readRequiredNumberEnv(name: string): number {
  const raw = process.env[name]
  if (!raw) throw new Error(`Missing required environment variable: ${name}`)
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

/** Anvil's chain id — the only chain where indexing from block 0 is reasonable. */
const LOCAL_CHAIN_ID = '31337'

/**
 * CROWDFUND_DEPLOY_BLOCK, defaulting to 0 only on local Anvil. Elsewhere 0 would backfill
 * from genesis (tens of thousands of getLogs ranges per RPC), so it must be the crowdfund
 * manifest's deployBlock.
 */
function readDeployBlock(): number {
  const deployBlock = readNumberEnv('CROWDFUND_DEPLOY_BLOCK', 0)
  if (deployBlock === 0 && process.env.CROWDFUND_CHAIN_ID !== LOCAL_CHAIN_ID) {
    throw new Error(
      'CROWDFUND_DEPLOY_BLOCK must be set to the crowdfund manifest deployBlock on non-local chains (0 backfills from genesis)',
    )
  }
  return deployBlock
}

/**
 * CROWDFUND_PROFILE: which set of sale constants (caps, budgets, sale sizes) the shared graph
 * and alert code applies. The shared constants read the same variable at import time; this
 * check makes a missing or misspelt value fail at startup instead of silently falling back to
 * the mainnet (Launch 1) profile. Defaults to mainnet only on local Anvil.
 */
export function readCrowdfundProfile(): CrowdfundProfile {
  const raw = process.env.CROWDFUND_PROFILE?.trim()
  if (!raw) {
    if (process.env.CROWDFUND_CHAIN_ID === LOCAL_CHAIN_ID) return 'mainnet'
    throw new Error(
      `CROWDFUND_PROFILE must be set on non-local chains (one of: ${CROWDFUND_PROFILES.join(', ')})`,
    )
  }
  if (!isCrowdfundProfile(raw)) {
    throw new Error(
      `CROWDFUND_PROFILE "${raw}" is not a known profile (expected one of: ${CROWDFUND_PROFILES.join(', ')})`,
    )
  }
  return raw
}

/**
 * Validate CROWDFUND_PROFILE and check it matches the profile the shared constants resolved at
 * import (`resolved`, normally the shared CROWDFUND_PROFILE). Call once at each entry point.
 */
export function assertActiveProfile(resolved: CrowdfundProfile = CROWDFUND_PROFILE): CrowdfundProfile {
  const profile = readCrowdfundProfile()
  if (profile !== resolved) {
    throw new Error(
      `CROWDFUND_PROFILE is "${profile}" but the shared constants resolved the "${resolved}" profile; ` +
        'set CROWDFUND_PROFILE in the process environment before the indexer starts',
    )
  }
  return profile
}

export function getInitialCursor(): CursorState {
  const deployBlock = readDeployBlock()
  return {
    deployBlock,
    confirmationDepth: readNumberEnv('CROWDFUND_CONFIRMATION_DEPTH', 12),
    chainHead: deployBlock,
    confirmedHead: deployBlock,
    ingestedCursor: deployBlock > 0 ? deployBlock - 1 : 0,
    verifiedCursor: deployBlock > 0 ? deployBlock - 1 : 0,
  }
}

export function loadIndexerConfig(): IndexerConfig {
  return {
    chainId: readRequiredNumberEnv('CROWDFUND_CHAIN_ID'),
    contractAddress: readRequiredEnv('CROWDFUND_CONTRACT_ADDRESS'),
    deployBlock: readDeployBlock(),
    primaryRpcUrl: process.env.CROWDFUND_PRIMARY_RPC_URL ?? null,
    auditRpcUrl: process.env.CROWDFUND_AUDIT_RPC_URL ?? null,
    confirmationDepth: readNumberEnv('CROWDFUND_CONFIRMATION_DEPTH', 12),
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
    profile: readCrowdfundProfile(),
  }
}
