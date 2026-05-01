// ABOUTME: Process entry point for the crowdfund indexer operator CLI.
// ABOUTME: Reads the durable JSON store and runs status/repair workflow commands.

import { join } from 'node:path'
import { JsonRpcProvider } from 'ethers'
import { createIndexerStore } from '../db/createStore.js'
import { parseCliArgs, runReadOnlyCommand } from './commands.js'
import { backfillVerifiedRanges } from '../ingest/backfill.js'
import { createJsonRpcRangeProvider, repairRanges, verifyRange } from '../ingest/rpc.js'
import { createReadableCrowdfundContract, reconcileSnapshot } from '../reconcile/contract.js'
import { buildSnapshot } from '../snapshots/build.js'
import { publishSnapshot, publishSnapshotToObjectStorage } from '../snapshots/publish.js'
import type { CursorState, ReconciliationResult } from '../types.js'

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`)
  }
  return parsed
}

function getInitialCursor(): CursorState {
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

function readRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (!value) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Invalid boolean environment variable: ${name}`)
}

async function resolveToBlock(
  toBlock: number | 'latest' | null,
  provider: { getBlockNumber(): Promise<number> },
  confirmationDepth: number,
): Promise<number> {
  if (typeof toBlock === 'number') return toBlock
  const head = await provider.getBlockNumber()
  return Math.max(0, head - confirmationDepth)
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))
  const store = createIndexerStore({
    defaultFilePath: join(process.cwd(), 'data/crowdfund-indexer/store.json'),
    initialCursor: getInitialCursor(),
  })
  const data = await store.read()

  if (args.command === 'verify' || args.command === 'repair' || args.command === 'backfill') {
    const provider = createJsonRpcRangeProvider(readRequiredEnv('CROWDFUND_PRIMARY_RPC_URL'))
    const auditRpcUrl = process.env.CROWDFUND_AUDIT_RPC_URL
    const auditProvider = auditRpcUrl ? createJsonRpcRangeProvider(auditRpcUrl) : undefined
    const config = {
      chainId: readNumberEnv('CROWDFUND_CHAIN_ID', 11155111),
      contractAddress: readRequiredEnv('CROWDFUND_CONTRACT_ADDRESS'),
      providerName: 'primary',
    }

    // `repair` with no --from/--to means "repair everything currently failed or
    // suspicious". This bypasses auto-reconcile's backoff/attempt limits — the
    // operator is explicitly asking for an immediate retry of every gap.
    if (args.command === 'repair' && args.fromBlock === null && args.toBlock === null) {
      const records = await repairRanges({
        ...config,
        store,
        provider,
        auditProvider,
        auditProviderName: auditProvider ? 'audit' : undefined,
      })
      if (records.length === 0) {
        process.stdout.write('No failed or suspicious ranges to repair.\n')
        return
      }
      process.stdout.write(
        records.map((record) => `${record.status}: ${record.fromBlock}-${record.toBlock} (${record.logCount} logs)`).join('\n') + '\n',
      )
      return
    }

    const toBlock = await resolveToBlock(args.toBlock, provider, data.cursor.confirmationDepth)
    const fromBlock = args.fromBlock ?? data.cursor.verifiedCursor + 1
    if (fromBlock > toBlock) {
      process.stdout.write(`No confirmed range to ${args.command}: ${fromBlock}-${toBlock}\n`)
      return
    }

    if (args.command === 'backfill') {
      const result = await backfillVerifiedRanges({
        ...config,
        store,
        provider,
        auditProvider,
        auditProviderName: auditProvider ? 'audit' : undefined,
        maxBlockRange: readNumberEnv('CROWDFUND_MAX_BLOCK_RANGE', 500),
        toBlock,
      })
      process.stdout.write(
        [
          `backfill ${result.fromBlock}-${result.toBlock}`,
          `chunks: ${result.ranges.length}`,
          `stoppedEarly: ${result.stoppedEarly ? 'yes' : 'no'}`,
          ...result.ranges.map((record) => `${record.status}: ${record.fromBlock}-${record.toBlock} (${record.logCount} logs)`),
        ].join('\n') + '\n',
      )
      return
    }

    const range = { fromBlock, toBlock }
    const records = args.command === 'verify'
      ? [await verifyRange({
          ...config,
          store,
          provider,
          auditProvider,
          auditProviderName: auditProvider ? 'audit' : undefined,
          range,
        })]
      : await repairRanges({
          ...config,
          store,
          provider,
          auditProvider,
          auditProviderName: auditProvider ? 'audit' : undefined,
          ranges: [range],
        })

    process.stdout.write(
      records.map((record) => `${record.status}: ${record.fromBlock}-${record.toBlock} (${record.logCount} logs)`).join('\n') + '\n',
    )
    return
  }

  if (args.command === 'rebuild-snapshot' || args.command === 'publish-snapshot') {
    const chainId = readNumberEnv('CROWDFUND_CHAIN_ID', 11155111)
    const contractAddress = readRequiredEnv('CROWDFUND_CONTRACT_ADDRESS')
    let reconciliation: ReconciliationResult | undefined

    const pendingSnapshot = buildSnapshot({ data, chainId, contractAddress })
    const rpcUrl = process.env.CROWDFUND_PRIMARY_RPC_URL
    if (rpcUrl) {
      const provider = new JsonRpcProvider(rpcUrl)
      const contract = createReadableCrowdfundContract(provider, contractAddress)
      reconciliation = await reconcileSnapshot({
        graph: pendingSnapshot.graph,
        contract,
        checkedBlock: data.cursor.verifiedCursor,
        providerName: 'primary',
      })
    }

    const snapshot = buildSnapshot({ data, chainId, contractAddress, reconciliation })
    if (args.command === 'rebuild-snapshot') {
      await store.update((current) => ({
        ...current,
        latestSnapshotHash: snapshot.metadata.snapshotHash,
        lastReconciledAt: snapshot.metadata.reconciliation.checkedAt ?? current.lastReconciledAt,
        lastError: snapshot.metadata.reconciliation.status === 'failed'
          ? snapshot.metadata.reconciliation.mismatches.join('; ')
          : current.lastError,
      }))
      process.stdout.write(`rebuilt snapshot ${snapshot.metadata.snapshotHash} at block ${snapshot.metadata.verifiedBlock}\n`)
      return
    }

    if (snapshot.metadata.reconciliation.status === 'failed') {
      process.stdout.write(`refusing to publish failed reconciliation: ${snapshot.metadata.reconciliation.mismatches.join('; ')}\n`)
      process.exitCode = 1
      return
    }

    const publisher = process.env.CROWDFUND_SNAPSHOT_PUBLISHER ?? 'file'
    if (publisher !== 'file' && publisher !== 's3') throw new Error('CROWDFUND_SNAPSHOT_PUBLISHER must be "file" or "s3"')
    const result = publisher === 's3'
      ? await publishSnapshotToObjectStorage(snapshot, {
          bucket: readRequiredEnv('CROWDFUND_SNAPSHOT_BUCKET'),
          prefix: process.env.CROWDFUND_SNAPSHOT_PREFIX,
          region: process.env.CROWDFUND_SNAPSHOT_REGION ?? process.env.AWS_REGION,
          endpoint: process.env.CROWDFUND_SNAPSHOT_ENDPOINT,
          publicBaseUrl: process.env.CROWDFUND_SNAPSHOT_PUBLIC_BASE_URL,
          forcePathStyle: readBooleanEnv('CROWDFUND_SNAPSHOT_FORCE_PATH_STYLE', false),
        })
      : await publishSnapshot(
          snapshot,
          process.env.CROWDFUND_SNAPSHOT_DIR ?? join(process.cwd(), 'data/crowdfund-indexer/snapshots'),
        )
    await store.update((current) => ({
      ...current,
      latestSnapshotHash: snapshot.metadata.snapshotHash,
      latestStaticSnapshotUrl: result.latestUrl ?? result.latestPath,
      lastReconciledAt: snapshot.metadata.reconciliation.checkedAt ?? current.lastReconciledAt,
      lastError: null,
    }))
    process.stdout.write(`published ${result.snapshotFileName}\nlatest ${result.latestUrl ?? result.latestPath}\n`)
    return
  }

  const result = runReadOnlyCommand(args, data)
  process.stdout.write(`${result.output}\n`)
  process.exitCode = result.exitCode
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown indexer CLI error'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
