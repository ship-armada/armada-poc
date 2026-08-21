// ABOUTME: Debug-mode flag (persisted, toggled via ?debug) + the dev "force tx outcome" selection.
// ABOUTME: Gated dev tooling — when debug mode is off nothing here has any effect on a real transaction.

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { TxErrorCode } from '@/lib/tx/types'

/**
 * Debug mode. Persisted in localStorage and toggled via the `?debug` URL param (see
 * `useDebugSync`), so a designer/QA can enable it once (`?debug` / `?debug=1`) and it sticks across
 * navigations, or turn it off (`?debug=0`). Read by dev-only affordances; has no effect on
 * production behaviour when false.
 */
export const debugModeAtom = atomWithStorage<boolean>('armada-interface.debug', false)

/**
 * Dev "force tx outcome" — when set (via the debug Send control), the next Send submit threads this
 * code into the record's `meta.devForceError`; the handler throws the matching typed error at the
 * start of its run so the transaction fails with that exact outcome (no chain interaction). `null`
 * = normal submission. Session-only (not persisted) so it doesn't silently linger.
 */
export const devForceOutcomeAtom = atom<TxErrorCode | null>(null)
