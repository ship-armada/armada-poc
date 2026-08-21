// ABOUTME: Dev-only fault injection — throws a branded TxError when a record carries meta.devForceError.
// ABOUTME: Set behind debug mode (state/debug.ts) via the Send flow; lets QA/design see each failed/cancelled outcome on demand without touching proof/chain internals.

import { asTxError } from './receipt'
import type { TxRecord, TxErrorCode } from './types'

/**
 * If `record.meta.devForceError` is set (only ever true when debug mode threaded it at submit),
 * throw a branded TxError with that code. Called at the top of a handler's `run` so the tx fails
 * immediately with the chosen outcome; `classifyHandlerError` preserves the branded code, so the
 * record lands in `failed`/`cancelled` with the exact `error.code`. No chain interaction, so there
 * is no `sourceTxHash` (the explorer link is disabled — nothing was actually sent).
 */
export function throwIfForcedError(record: TxRecord): void {
  // `meta` is a per-kind union; only MetaCommon-derived kinds carry devForceError — narrow via cast.
  const forced = (record.meta as { devForceError?: TxErrorCode }).devForceError
  if (forced) {
    throw asTxError({ code: forced, message: `Dev-forced outcome: ${forced}.` })
  }
}
