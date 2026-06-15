// ABOUTME: Orchestrator — runs all alert rules, dispatches new alerts, persists fired-key state.
// ABOUTME: Pure of side effects other than the injected notifier and state store.

import { sanitizeErrorMessage } from '../ingest/errors.js'
import { evaluateAllRules } from './rules.js'
import type { Notifier } from './notifier.js'
import type { AlertStateStore } from './state.js'
import type { AlertContext, AlertEvent } from './types.js'

export interface EvaluatorResult {
  total: number
  delivered: AlertEvent[]
  skipped: AlertEvent[]
  /** Candidates whose delivery threw (e.g. webhook outage); retried next tick. */
  failed: AlertEvent[]
}

export interface EvaluateInput {
  context: AlertContext
  notifier: Notifier
  stateStore: AlertStateStore
  /** Optional override of the rules pipeline (defaults to evaluateAllRules). */
  evaluate?: (ctx: AlertContext) => AlertEvent[]
}

export async function evaluateAndDispatch(input: EvaluateInput): Promise<EvaluatorResult> {
  const evaluate = input.evaluate ?? evaluateAllRules
  const candidates = evaluate(input.context)
  const state = await input.stateStore.read()
  const fired = new Set(state.firedKeys)
  const delivered: AlertEvent[] = []
  const skipped: AlertEvent[] = []
  const failed: AlertEvent[] = []

  for (const event of candidates) {
    if (fired.has(event.dedupeKey)) {
      skipped.push(event)
      continue
    }
    try {
      await input.notifier.send(event)
    } catch (err) {
      // A single webhook failure must not abandon the remaining alerts nor lose the
      // dedupe state for those already delivered this tick. Record and continue.
      const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err))
      process.stderr.write(`[alerts] delivery failed for ${event.id} (${event.dedupeKey}): ${message}\n`)
      failed.push(event)
      continue
    }
    fired.add(event.dedupeKey)
    delivered.push(event)
    // Persist after every successful send so a later failure in this loop cannot cause
    // an already-delivered alert to re-fire on the next tick.
    await input.stateStore.write({ firedKeys: fired })
  }

  return { total: candidates.length, delivered, skipped, failed }
}
