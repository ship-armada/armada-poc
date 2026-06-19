// ABOUTME: Orchestrator — runs all alert rules, dispatches new alerts, persists fired-key state.
// ABOUTME: Pure of side effects other than the injected notifier and state store.

import { evaluateAllRules } from './rules.js'
import type { Notifier } from './notifier.js'
import type { AlertStateStore } from './state.js'
import type { AlertContext, AlertEvent } from './types.js'

export interface EvaluatorResult {
  total: number
  delivered: AlertEvent[]
  skipped: AlertEvent[]
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

  for (const event of candidates) {
    if (fired.has(event.dedupeKey)) {
      skipped.push(event)
      continue
    }
    await input.notifier.send(event)
    fired.add(event.dedupeKey)
    delivered.push(event)
  }

  if (delivered.length > 0) {
    await input.stateStore.write({ firedKeys: fired })
  }

  return { total: candidates.length, delivered, skipped }
}
