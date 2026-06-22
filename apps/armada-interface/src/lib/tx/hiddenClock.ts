// ABOUTME: Tracks cumulative tab-hidden time and credits it back to each tx's wall-clock budget,
// ABOUTME: so a backgrounded tab doesn't expire / POLL_TIMEOUT a tx that merely waited while hidden (T-M5 / S-M6).

// Visibility is global (the whole tab is hidden or not), so the running total lives at module scope.
// Per-record snapshots let us credit only the hidden time that elapsed during a given record's life
// — crediting the global total outright would over-extend a record created after an unrelated
// earlier hidden span, defeating the budget's purpose of bounding genuinely stuck txs.
let totalHiddenMs = 0
let hiddenSince: number | null = null
const startSnapshot = new Map<string, number>()

/** Total ms the tab has been hidden up to `now`, including the current hidden span if any. */
function hiddenTotal(now: number): number {
  return totalHiddenMs + (hiddenSince !== null ? Math.max(0, now - hiddenSince) : 0)
}

/** Tab went hidden. Idempotent — a second call without an intervening markVisible is a no-op. */
export function markHidden(now: number): void {
  if (hiddenSince === null) hiddenSince = now
}

/** Tab became visible. Folds the just-ended hidden span into the running total. */
export function markVisible(now: number): void {
  if (hiddenSince !== null) {
    totalHiddenMs += Math.max(0, now - hiddenSince)
    hiddenSince = null
  }
}

/**
 * Begin crediting hidden time for a record — snapshots the hidden total at tracking start so only
 * hidden time AFTER this point counts toward the credit. Idempotent: resume re-attaches (a record
 * that broke at `waiting` and is re-dispatched) keep the original baseline rather than resetting it.
 */
export function beginHiddenCredit(recordId: string, now: number): void {
  if (!startSnapshot.has(recordId)) startSnapshot.set(recordId, hiddenTotal(now))
}

/** Stop tracking a record (it reached a terminal state) — frees the snapshot. */
export function endHiddenCredit(recordId: string): void {
  startSnapshot.delete(recordId)
}

/**
 * ms the tab was hidden during this record's tracked life. Returns 0 when the record was never
 * tracked (e.g. resumed after a reload, or a unit test that didn't begin tracking) — so the credit
 * gracefully degrades to "no credit" rather than guessing.
 */
export function hiddenMsForRecord(recordId: string, now: number): number {
  const snap = startSnapshot.get(recordId)
  return snap === undefined ? 0 : Math.max(0, hiddenTotal(now) - snap)
}

/** Test-only reset of all module state. */
export function __resetHiddenClock(): void {
  totalHiddenMs = 0
  hiddenSince = null
  startSnapshot.clear()
}
