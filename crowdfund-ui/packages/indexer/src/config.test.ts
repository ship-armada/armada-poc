// ABOUTME: Unit tests for indexer environment configuration parsing.
// ABOUTME: Locks in defaults, overrides, and required-variable enforcement.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getInitialCursor, loadIndexerConfig } from './config.js'

const TOUCHED = [
  'CROWDFUND_CONTRACT_ADDRESS', 'CROWDFUND_CHAIN_ID', 'CROWDFUND_DEPLOY_BLOCK',
  'CROWDFUND_PRIMARY_RPC_URL', 'CROWDFUND_AUDIT_RPC_URL', 'CROWDFUND_CONFIRMATION_DEPTH',
  'CROWDFUND_OVERLAP_WINDOW', 'CROWDFUND_MAX_BLOCK_RANGE', 'CROWDFUND_INDEXER_PORT',
  'CROWDFUND_STALE_AFTER_MS', 'CROWDFUND_REPAIR_MAX_ATTEMPTS', 'CROWDFUND_POLL_ON_START',
  'CROWDFUND_POLL_INTERVAL_MS', 'CROWDFUND_RPC_MAX_RETRIES',
]

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of TOUCHED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('loadIndexerConfig', () => {
  it('applies documented defaults when chain id + contract address are set', () => {
    process.env.CROWDFUND_CHAIN_ID = '11155111'
    process.env.CROWDFUND_CONTRACT_ADDRESS = '0xabc'
    const config = loadIndexerConfig()
    expect(config).toMatchObject({
      chainId: 11155111,
      contractAddress: '0xabc',
      deployBlock: 0,
      primaryRpcUrl: null,
      auditRpcUrl: null,
      confirmationDepth: 12,
      overlapWindow: 100,
      maxBlockRange: 500,
      port: 3002,
      staleAfterMs: 300_000,
      repairMaxAttempts: 6,
      pollOnStart: false,
      pollIntervalMs: 15_000,
      rpcMaxRetries: 3,
    })
  })

  it('parses overrides from the environment', () => {
    process.env.CROWDFUND_CONTRACT_ADDRESS = '0xabc'
    process.env.CROWDFUND_CHAIN_ID = '1'
    process.env.CROWDFUND_PRIMARY_RPC_URL = 'https://rpc.example.com/key'
    process.env.CROWDFUND_POLL_ON_START = 'true'
    process.env.CROWDFUND_STALE_AFTER_MS = '120000'
    const config = loadIndexerConfig()
    expect(config.chainId).toBe(1)
    expect(config.primaryRpcUrl).toBe('https://rpc.example.com/key')
    expect(config.pollOnStart).toBe(true)
    expect(config.staleAfterMs).toBe(120_000)
  })

  it('throws when the required chain id is missing', () => {
    process.env.CROWDFUND_CONTRACT_ADDRESS = '0xabc'
    expect(() => loadIndexerConfig()).toThrow('CROWDFUND_CHAIN_ID')
  })

  it('throws when the required contract address is missing', () => {
    process.env.CROWDFUND_CHAIN_ID = '11155111'
    expect(() => loadIndexerConfig()).toThrow('CROWDFUND_CONTRACT_ADDRESS')
  })

  it('rejects an invalid numeric variable', () => {
    process.env.CROWDFUND_CHAIN_ID = '11155111'
    process.env.CROWDFUND_CONTRACT_ADDRESS = '0xabc'
    process.env.CROWDFUND_MAX_BLOCK_RANGE = '-5'
    expect(() => loadIndexerConfig()).toThrow('CROWDFUND_MAX_BLOCK_RANGE')
  })
})

describe('getInitialCursor', () => {
  it('seeds cursors one block before deployBlock when deployBlock is set', () => {
    process.env.CROWDFUND_DEPLOY_BLOCK = '500'
    const cursor = getInitialCursor()
    expect(cursor).toMatchObject({
      deployBlock: 500,
      chainHead: 500,
      confirmedHead: 500,
      ingestedCursor: 499,
      verifiedCursor: 499,
    })
  })

  it('keeps cursors at 0 when deployBlock is unset', () => {
    const cursor = getInitialCursor()
    expect(cursor.ingestedCursor).toBe(0)
    expect(cursor.verifiedCursor).toBe(0)
  })
})
