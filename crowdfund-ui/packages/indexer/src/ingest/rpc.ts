// ABOUTME: RPC-backed range ingestion and verification for crowdfund logs.
// ABOUTME: Stages raw logs, verifies ranges, and promotes the verified cursor without skipping gaps.

import { JsonRpcProvider } from 'ethers'
import type { IndexerStore } from '../db/store.js'
import { createRangeDigest, getContiguousVerifiedCursor } from './ranges.js'
import type { BlockRange, IndexedRawLog, IndexerStoreData, IngestRangeRecord } from '../types.js'

export interface RpcLog {
  blockNumber: number
  blockHash: string
  transactionHash: string
  index?: number
  logIndex?: number
  topics: readonly string[]
  data: string
}

export interface RangeLogProvider {
  getBlockNumber(): Promise<number>
  getLogs(filter: { address: string; fromBlock: number; toBlock: number }): Promise<readonly RpcLog[]>
}

export interface RangePipelineConfig {
  chainId: number
  contractAddress: string
  providerName: string
}

export interface StageRangeInput extends RangePipelineConfig {
  store: IndexerStore
  provider: RangeLogProvider
  range: BlockRange
}

export interface VerifyRangeInput extends StageRangeInput {
  auditProvider?: RangeLogProvider
  auditProviderName?: string
}

export interface RepairRangesInput extends RangePipelineConfig {
  store: IndexerStore
  provider: RangeLogProvider
  auditProvider?: RangeLogProvider
  auditProviderName?: string
  ranges?: readonly BlockRange[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function getLogIndex(log: RpcLog): number {
  return log.logIndex ?? log.index ?? 0
}

function isHexString(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
}

function validateRpcLogs(value: unknown, range: BlockRange): readonly RpcLog[] {
  if (!Array.isArray(value)) {
    throw new Error(`Malformed RPC log response for ${range.fromBlock}-${range.toBlock}: expected array`)
  }

  for (const [idx, log] of value.entries()) {
    if (!log || typeof log !== 'object') {
      throw new Error(`Malformed RPC log at index ${idx}: expected object`)
    }
    const candidate = log as Partial<RpcLog>
    const logIndex = candidate.logIndex ?? candidate.index
    if (!Number.isSafeInteger(candidate.blockNumber)) throw new Error(`Malformed RPC log at index ${idx}: missing blockNumber`)
    if (!isHexString(candidate.blockHash)) throw new Error(`Malformed RPC log at index ${idx}: missing blockHash`)
    if (!isHexString(candidate.transactionHash)) throw new Error(`Malformed RPC log at index ${idx}: missing transactionHash`)
    if (!Number.isSafeInteger(logIndex)) throw new Error(`Malformed RPC log at index ${idx}: missing log index`)
    if (!Array.isArray(candidate.topics) || !candidate.topics.every(isHexString)) {
      throw new Error(`Malformed RPC log at index ${idx}: invalid topics`)
    }
    if (!isHexString(candidate.data)) throw new Error(`Malformed RPC log at index ${idx}: missing data`)
  }

  return value as readonly RpcLog[]
}

function toIndexedRawLog(
  log: RpcLog,
  chainId: number,
  contractAddress: string,
): IndexedRawLog {
  return {
    chainId,
    contractAddress: contractAddress.toLowerCase(),
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: getLogIndex(log),
    topics: [...log.topics],
    data: log.data,
  }
}

function getExistingAttempts(data: IndexerStoreData, range: BlockRange): number {
  return data.ranges.find((record) => record.fromBlock === range.fromBlock && record.toBlock === range.toBlock)?.attempts ?? 0
}

function createRecord(
  range: BlockRange,
  status: IngestRangeRecord['status'],
  provider: string,
  attempts: number,
  logs: readonly IndexedRawLog[],
  timestamp: string,
  lastError: string | null,
): IngestRangeRecord {
  return {
    ...range,
    status,
    provider,
    attempts,
    logCount: logs.length,
    digest: createRangeDigest(logs),
    fetchedAt: timestamp,
    verifiedAt: status === 'verified' ? timestamp : null,
    lastError,
  }
}

function promoteVerifiedCursor(data: IndexerStoreData): IndexerStoreData {
  const verifiedCursor = getContiguousVerifiedCursor(data.ranges, data.cursor.verifiedCursor)
  return {
    ...data,
    cursor: {
      ...data.cursor,
      verifiedCursor,
    },
  }
}

export function createJsonRpcRangeProvider(url: string): RangeLogProvider {
  return new JsonRpcProvider(url) as unknown as RangeLogProvider
}

export async function fetchIndexedLogs(
  provider: RangeLogProvider,
  config: RangePipelineConfig,
  range: BlockRange,
): Promise<IndexedRawLog[]> {
  const logs = validateRpcLogs(await provider.getLogs({
    address: config.contractAddress,
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
  }), range)
  return logs.map((log) => toIndexedRawLog(log, config.chainId, config.contractAddress))
}

export async function stageRange(input: StageRangeInput): Promise<IngestRangeRecord> {
  const timestamp = nowIso()
  try {
    const logs = await fetchIndexedLogs(input.provider, input, input.range)
    const current = await input.store.read()
    const attempts = getExistingAttempts(current, input.range) + 1
    const record = createRecord(input.range, 'staged', input.providerName, attempts, logs, timestamp, null)
    await input.store.upsertRawLogs(logs)
    await input.store.update((data) => ({
      ...data,
      ranges: [...data.ranges.filter((range) => range.fromBlock !== input.range.fromBlock || range.toBlock !== input.range.toBlock), record],
      cursor: {
        ...data.cursor,
        ingestedCursor: Math.max(data.cursor.ingestedCursor, input.range.toBlock),
      },
      lastIngestedAt: timestamp,
      lastError: null,
    }))
    return record
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown range staging error'
    const current = await input.store.read()
    const attempts = getExistingAttempts(current, input.range) + 1
    const record: IngestRangeRecord = {
      ...input.range,
      status: 'failed',
      provider: input.providerName,
      attempts,
      logCount: 0,
      digest: null,
      fetchedAt: timestamp,
      verifiedAt: null,
      lastError: message,
    }
    await input.store.upsertRange(record)
    await input.store.update((data) => ({
      ...data,
      lastError: message,
    }))
    return record
  }
}

export async function verifyRange(input: VerifyRangeInput): Promise<IngestRangeRecord> {
  const staged = await stageRange(input)
  if (staged.status === 'failed') return staged

  const auditProvider = input.auditProvider ?? input.provider
  const auditProviderName = input.auditProviderName ?? input.providerName
  const timestamp = nowIso()
  try {
    const auditLogs = await fetchIndexedLogs(auditProvider, input, input.range)
    const auditDigest = createRangeDigest(auditLogs)
    const status: IngestRangeRecord['status'] = auditDigest === staged.digest ? 'verified' : 'suspicious'
    const record: IngestRangeRecord = {
      ...staged,
      status,
      provider: status === 'verified' ? auditProviderName : `${staged.provider}/${auditProviderName}`,
      verifiedAt: status === 'verified' ? timestamp : null,
      lastError: status === 'verified' ? null : `Digest mismatch: staged ${staged.digest}, audit ${auditDigest}`,
    }

    await input.store.upsertRange(record)
    if (status === 'verified') {
      await input.store.update((data) => promoteVerifiedCursor({
        ...data,
        lastVerifiedAt: timestamp,
        lastError: null,
      }))
    } else {
      await input.store.update((data) => ({
        ...data,
        lastError: record.lastError,
      }))
    }
    return record
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown range verification error'
    const record: IngestRangeRecord = {
      ...staged,
      status: 'failed',
      provider: auditProviderName,
      verifiedAt: null,
      lastError: message,
    }
    await input.store.upsertRange(record)
    await input.store.update((data) => ({
      ...data,
      lastError: message,
    }))
    return record
  }
}

export async function repairRanges(input: RepairRangesInput): Promise<IngestRangeRecord[]> {
  const data = await input.store.read()
  const ranges = input.ranges ?? data.ranges
    .filter((record) => record.status === 'failed' || record.status === 'suspicious')
    .map((record) => ({ fromBlock: record.fromBlock, toBlock: record.toBlock }))

  const repaired: IngestRangeRecord[] = []
  for (const range of ranges) {
    repaired.push(await verifyRange({ ...input, range }))
  }
  return repaired
}
