// ABOUTME: Top-level "run once" entry: assemble AlertContext from store + RPC, dispatch.
// ABOUTME: Used by the `evaluate-alerts` CLI subcommand (and a future scheduled cron).

import { buildHealth } from '../api/health.js'
import { buildSnapshot } from '../snapshots/build.js'
import { getExhaustedRepairRanges } from '../ingest/reconcile.js'
import { getRepairRanges } from '../ingest/ranges.js'
import type { IndexerStore } from '../db/store.js'
import type { ChainStateReader } from './chainState.js'
import { evaluateAndDispatch, type EvaluatorResult } from './evaluator.js'
import { createDiscordNotifier, type Notifier } from './notifier.js'
import type { AlertStateStore } from './state.js'
import { readThresholdsFromEnv } from './thresholds.js'
import type { AlertContext, CrowdfundParams, Severity } from './types.js'

export interface RunAlertsOnceInput {
  store: IndexerStore
  stateStore: AlertStateStore
  params: CrowdfundParams
  repairMaxAttempts: number
  /** Used to read finalizedAt and treasury USDC balance. Optional — null when offline. */
  chainState: ChainStateReader | null
  notifier: Notifier
  /** Test seam — defaults to `() => Math.floor(Date.now() / 1000)`. */
  nowSeconds?: () => number
}

export async function runAlertsOnce(input: RunAlertsOnceInput): Promise<EvaluatorResult> {
  const data = await input.store.read()
  const now = input.nowSeconds ? input.nowSeconds() : Math.floor(Date.now() / 1000)

  const snapshot = buildSnapshot({
    data,
    chainId: input.params.chainId,
    contractAddress: input.params.contractAddress,
  })

  const health = buildHealth({
    cursor: data.cursor,
    gapRanges: getRepairRanges(data.ranges),
    gapsRequiringIntervention: getExhaustedRepairRanges(data.ranges, input.repairMaxAttempts),
    lastIngestedAt: data.lastIngestedAt,
    lastVerifiedAt: data.lastVerifiedAt,
    lastReconciledAt: data.lastReconciledAt,
    lastError: data.lastError,
    latestSnapshotHash: data.latestSnapshotHash,
    latestStaticSnapshotUrl: data.latestStaticSnapshotUrl,
  })

  let finalizedAt: number | null = null
  let treasuryUsdcBalance: bigint | null = null
  if (input.chainState) {
    const [finalizedRaw, balance] = await Promise.all([
      input.chainState.readFinalizedAt(),
      input.chainState.readTreasuryUsdcBalance(),
    ])
    finalizedAt = finalizedRaw > 0 ? finalizedRaw : null
    treasuryUsdcBalance = balance
  }

  const context: AlertContext = {
    now,
    params: input.params,
    snapshot,
    health,
    thresholds: readThresholdsFromEnv(),
    treasuryUsdcBalance,
    finalizedAt,
  }

  return await evaluateAndDispatch({
    context,
    notifier: input.notifier,
    stateStore: input.stateStore,
  })
}

/** Build a Discord notifier from environment variables (one webhook per severity). */
export function createDiscordNotifierFromEnv(): Notifier {
  const webhooks: Partial<Record<Severity, string>> = {}
  const mentions: Partial<Record<Severity, string>> = {}
  for (const sev of ['P0', 'P1', 'P2', 'P3'] as const) {
    const url = process.env[`CROWDFUND_ALERT_WEBHOOK_${sev}`]
    if (url) webhooks[sev] = url
    const mention = process.env[`CROWDFUND_ALERT_MENTION_${sev}`]
    if (mention) mentions[sev] = mention
  }
  return createDiscordNotifier({ webhooks, mentions })
}
