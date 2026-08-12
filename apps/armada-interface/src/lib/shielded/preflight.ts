// ABOUTME: Pre-proof spend gate — runs wallet.preflight(plan) and throws the matching ArmadaError on a
// ABOUTME: failed finding, so a stale root / already-spent note fails in <1s instead of after a 30s proof+revert.

import {
  FeeQuoteExpiredError,
  InsufficientBalanceError,
  InvalidRequestError,
  NoteAlreadySpentError,
  RootMismatchError,
  type Plan,
  type PreflightFinding,
  type PreflightResult,
} from '@armada/sdk'

/**
 * Map a failed preflight finding to the `@armada/sdk` error the tx-error classifier already understands
 * (`lib/tx/errors.ts::classifySdkError`). Preflight failures and post-proof spend failures thus get one
 * shared, tested mapping — a failed `root-freshness` reads identically whether caught here (pre-proof)
 * or thrown later by `prove`.
 */
function findingToError(f: PreflightFinding): Error {
  const detail = f.detail ?? `preflight check '${f.check}' failed`
  switch (f.check) {
    case 'root-freshness':
      return new RootMismatchError(detail)
    case 'nullifier-unspent':
      return new NoteAlreadySpentError(detail)
    case 'fee-quote-expiry':
      return new FeeQuoteExpiredError(detail)
    case 'balance-sufficiency':
      return new InsufficientBalanceError(detail)
    case 'cctp-liveness':
    case 'shield-pause':
    default:
      // No dedicated error class for these; INVALID_REQUEST maps to PRE_FLIGHT_REVERT (nothing sent).
      return new InvalidRequestError(detail)
  }
}

/**
 * Run `wallet.preflight` over a planned spend BEFORE proving. On any failed finding, throw the matching
 * ArmadaError so the handler's `classifyHandlerError` renders a typed, category-appropriate failure
 * (PRE_FLIGHT_REVERT / FEE_EXPIRED) — the user gets a fast, honest "nothing was sent" instead of waiting
 * ~30s for a proof that reverts on-chain.
 *
 * Preflight is intentionally called WITHOUT a fee quote: quote staleness is the relayer's concern (it
 * re-verifies at submit), so the interface runs only the on-chain root-freshness + nullifier-unspent
 * checks here — the ones that turn a doomed proof into a sub-second failure. A transient RPC failure in
 * preflight itself surfaces as OTHER via the classifier and is retryable, same as it would be at submit.
 */
export async function assertSpendPreflight(
  wallet: { preflight(plan: Plan): Promise<PreflightResult> },
  plan: Plan,
): Promise<void> {
  const result = await wallet.preflight(plan)
  if (result.ok) return
  const failed = result.findings.find((f) => !f.ok)
  // `ok` is false ⇒ at least one finding failed; the guard is for the type-narrowing (and defense).
  if (failed) throw findingToError(failed)
}
