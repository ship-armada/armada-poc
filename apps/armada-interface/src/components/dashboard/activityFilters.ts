// ABOUTME: Predicates for filtering dashboard activity items by kind chip and tx-hash search query.
// ABOUTME: Ported from the armada-app mockup's dashboardActivity utils, adapted to our DashboardActivityItem.

import type { DashboardActivityItem } from '@/components/dashboard/txActivityAdapter'
import type { ActivityKindFilter } from './RecentActivityList/ActivityKindFilters'

/** True when the item matches the selected kind chip ('all' matches everything). */
export function matchesActivityKindFilter(
  item: DashboardActivityItem,
  filter: ActivityKindFilter,
): boolean {
  return filter === 'all' || item.kind === filter
}

/** True when the query is empty/whitespace, or the item's tx hash contains the trimmed query. */
export function matchesActivityTxHashSearch(item: DashboardActivityItem, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return item.txHash?.toLowerCase().includes(normalized) ?? false
}
