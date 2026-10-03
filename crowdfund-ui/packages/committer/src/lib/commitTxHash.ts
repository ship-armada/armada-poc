// ABOUTME: Picks the commit transaction hash out of finished pipeline rows for the confirmation summary table.
// ABOUTME: Skips approve rows; returns the latest confirmed commit hash, or undefined when none is available.

import type { Step4Transaction } from '@armada/crowdfund-shared'

export function commitTxHashFromRows(
  rows: readonly Step4Transaction[],
): string | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row?.hash && row.status === 'done' && !/^approve/i.test(row.label)) {
      return row.hash
    }
  }
  return undefined
}
