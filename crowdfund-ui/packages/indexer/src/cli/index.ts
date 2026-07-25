// ABOUTME: Process entry point for the crowdfund indexer operator CLI.
// ABOUTME: Reads the durable JSON store and runs status/repair workflow commands.

import { join } from 'node:path'
import { JsonRpcProvider } from 'ethers'
import { getInitialCursor, readBooleanEnv, readNumberEnv, readRequiredEnv, readRequiredNumberEnv } from '../config.js'
import { createIndexerStore } from '../db/createStore.js'
import type { IndexerStore } from '../db/store.js'
import type { IngestRangeRecord } from '../types.js'
import { parseCliArgs, runReadOnlyCommand } from './commands.js'
import type { ParsedCliArgs } from './commands.js'
import { createRpcChainStateReader } from '../alerts/chainState.js'
import { createFileAlertStateStore } from '../alerts/state.js'
import { createDiscordNotifierFromEnv, runAlertsOnce } from '../alerts/runner.js'
import type { CrowdfundParams } from '../alerts/types.js'
import { backfillVerifiedRanges, planBackfillRanges } from '../ingest/backfill.js'
import { sanitizeErrorMessage } from '../ingest/errors.js'
import { createJsonRpcRangeProvider, repairRanges, verifyRange } from '../ingest/rpc.js'
import { createReadableCrowdfundContract, reconcileSnapshot } from '../reconcile/contract.js'
import { buildSnapshot, withReconciliation } from '../snapshots/build.js'
import { publishSnapshot, publishSnapshotToObjectStorage } from '../snapshots/publish.js'

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
  try {
    await runCommand(args, store)
  } finally {
    // Release the Postgres pool (no-op for the file store) so the CLI exits promptly.
    await store.close()
  }
}

async function runCommand(args: ParsedCliArgs, store: IndexerStore): Promise<void> {
  // Operator commands only need cursor/range/metadata state; the snapshot commands add
  // raw logs on demand below.
  const data = await store.readMeta()

  if (args.command === 'verify' || args.command === 'repair' || args.command === 'backfill') {
    const provider = createJsonRpcRangeProvider(readRequiredEnv('CROWDFUND_PRIMARY_RPC_URL'))
    const auditRpcUrl = process.env.CROWDFUND_AUDIT_RPC_URL
    const auditProvider = auditRpcUrl ? createJsonRpcRangeProvider(auditRpcUrl) : undefined
    if (!auditRpcUrl) {
      process.stderr.write(
        'Warning: CROWDFUND_AUDIT_RPC_URL is unset — ranges are verified against the same provider twice (no independent audit).\n',
      )
    }
    const config = {
      chainId: readRequiredNumberEnv('CROWDFUND_CHAIN_ID'),
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

    // Chunk an explicit span so a large --from/--to range does not hit a single oversized
    // getLogs call (which providers reject). One chunk reproduces the previous behavior.
    const chunks = planBackfillRanges({ fromBlock, toBlock, maxBlockRange: readNumberEnv('CROWDFUND_MAX_BLOCK_RANGE', 500) })
    const records: IngestRangeRecord[] = []
    if (args.command === 'verify') {
      for (const chunk of chunks) {
        records.push(await verifyRange({
          ...config,
          store,
          provider,
          auditProvider,
          auditProviderName: auditProvider ? 'audit' : undefined,
          range: chunk,
        }))
      }
    } else {
      records.push(...await repairRanges({
        ...config,
        store,
        provider,
        auditProvider,
        auditProviderName: auditProvider ? 'audit' : undefined,
        ranges: chunks,
      }))
    }

    process.stdout.write(
      records.map((record) => `${record.status}: ${record.fromBlock}-${record.toBlock} (${record.logCount} logs)`).join('\n') + '\n',
    )
    return
  }

  if (args.command === 'rebuild-snapshot' || args.command === 'publish-snapshot') {
    const chainId = readRequiredNumberEnv('CROWDFUND_CHAIN_ID')
    const contractAddress = readRequiredEnv('CROWDFUND_CONTRACT_ADDRESS')

    const snapshotData = { ...data, rawLogs: await store.readLogs(data.cursor.verifiedCursor) }
    let snapshot = buildSnapshot({ data: snapshotData, chainId, contractAddress })
    const rpcUrl = process.env.CROWDFUND_PRIMARY_RPC_URL
    if (rpcUrl) {
      const provider = new JsonRpcProvider(rpcUrl)
      try {
        const contract = createReadableCrowdfundContract(provider, contractAddress)
        const reconciliation = await reconcileSnapshot({
          graph: snapshot.graph,
          contract,
          checkedBlock: data.cursor.verifiedCursor,
          providerName: 'primary',
        })
        snapshot = withReconciliation(snapshot, reconciliation)
      } finally {
        provider.destroy()
      }
    }
    if (args.command === 'rebuild-snapshot') {
      await store.patchMeta({
        latestSnapshotHash: snapshot.metadata.snapshotHash,
        ...(snapshot.metadata.reconciliation.checkedAt
          ? { lastReconciledAt: snapshot.metadata.reconciliation.checkedAt }
          : {}),
        ...(snapshot.metadata.reconciliation.status === 'failed'
          ? { lastError: sanitizeErrorMessage(snapshot.metadata.reconciliation.mismatches.join('; ')) }
          : {}),
      })
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
    await store.patchMeta({
      latestSnapshotHash: snapshot.metadata.snapshotHash,
      latestStaticSnapshotUrl: result.latestUrl ?? result.latestPath,
      ...(snapshot.metadata.reconciliation.checkedAt
        ? { lastReconciledAt: snapshot.metadata.reconciliation.checkedAt }
        : {}),
      lastError: null,
    })
    process.stdout.write(`published ${result.snapshotFileName}\nlatest ${result.latestUrl ?? result.latestPath}\n`)
    return
  }

  if (args.command === 'evaluate-alerts') {
    const params: CrowdfundParams = {
      chainId: readRequiredNumberEnv('CROWDFUND_CHAIN_ID'),
      contractAddress: readRequiredEnv('CROWDFUND_CONTRACT_ADDRESS'),
      treasuryAddress: readRequiredEnv('CROWDFUND_TREASURY_ADDRESS'),
      openTimestamp: readNumberEnv('CROWDFUND_OPEN_TIMESTAMP', 0),
      launchTeamInviteDeadline: readNumberEnv('CROWDFUND_LAUNCH_TEAM_INVITE_DEADLINE', 0),
      commitmentDeadline: readNumberEnv('CROWDFUND_COMMITMENT_DEADLINE', 0),
    }
    const rpcUrl = process.env.CROWDFUND_PRIMARY_RPC_URL
    const usdcAddress = process.env.CROWDFUND_USDC_ADDRESS
    const chainState = rpcUrl && usdcAddress
      ? createRpcChainStateReader({
          rpcUrl,
          crowdfundAddress: params.contractAddress,
          usdcAddress,
          treasuryAddress: params.treasuryAddress,
        })
      : null
    const stateFile = process.env.CROWDFUND_ALERT_STATE_FILE
      ?? join(process.cwd(), 'data/crowdfund-indexer/alerts.json')
    let result
    try {
      result = await runAlertsOnce({
        store,
        stateStore: createFileAlertStateStore(stateFile),
        params,
        repairMaxAttempts: readNumberEnv('CROWDFUND_REPAIR_MAX_ATTEMPTS', 6),
        staleAfterMs: readNumberEnv('CROWDFUND_STALE_AFTER_MS', 300_000),
        chainState,
        notifier: createDiscordNotifierFromEnv(),
      })
    } finally {
      chainState?.close?.()
    }
    process.stdout.write(
      `evaluated ${result.total} candidates; delivered ${result.delivered.length}; skipped ${result.skipped.length}; failed ${result.failed.length}; undelivered ${result.undelivered.length}\n`,
    )
    for (const e of result.delivered) {
      process.stdout.write(`  [${e.severity} ${e.id}] ${e.title} (key=${e.dedupeKey})\n`)
    }
    for (const e of result.undelivered) {
      process.stderr.write(`  UNDELIVERED [${e.severity} ${e.id}] ${e.title} — no webhook configured for ${e.severity}\n`)
    }
    for (const e of result.failed) {
      process.stderr.write(`  FAILED [${e.severity} ${e.id}] ${e.title} (key=${e.dedupeKey})\n`)
    }
    // Non-zero exit so a scheduler surfaces delivery failures (and retries next tick).
    if (result.failed.length > 0) process.exitCode = 1
    return
  }

  const result = runReadOnlyCommand(args, data, readNumberEnv('CROWDFUND_STALE_AFTER_MS', 300_000))
  process.stdout.write(`${result.output}\n`)
  process.exitCode = result.exitCode
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown indexer CLI error'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
