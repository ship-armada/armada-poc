// ABOUTME: Environment configuration parsing for the crowdfund indexer service.
// ABOUTME: Keeps deployment-specific values explicit and validates required runtime inputs.

export interface IndexerConfig {
  chainId: number
  contractAddress: string
  deployBlock: number
  primaryRpcUrl: string
  auditRpcUrl: string | null
  confirmationDepth: number
  overlapWindow: number
  maxBlockRange: number
  port: number
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`)
  }
  return parsed
}

export function loadIndexerConfig(): IndexerConfig {
  return {
    chainId: readNumberEnv('CROWDFUND_CHAIN_ID', 11155111),
    contractAddress: readRequiredEnv('CROWDFUND_CONTRACT_ADDRESS'),
    deployBlock: readNumberEnv('CROWDFUND_DEPLOY_BLOCK', 0),
    primaryRpcUrl: readRequiredEnv('CROWDFUND_PRIMARY_RPC_URL'),
    auditRpcUrl: process.env.CROWDFUND_AUDIT_RPC_URL ?? null,
    confirmationDepth: readNumberEnv('CROWDFUND_CONFIRMATION_DEPTH', 12),
    overlapWindow: readNumberEnv('CROWDFUND_OVERLAP_WINDOW', 100),
    maxBlockRange: readNumberEnv('CROWDFUND_MAX_BLOCK_RANGE', 500),
    port: readNumberEnv('CROWDFUND_INDEXER_PORT', 3002),
  }
}
