// ABOUTME: "All activity" panel — SidePanel (desktop) / BottomSheet (mobile) with search + kind-filter toolbar.
// ABOUTME: Renders a full RecentActivityList filtered by tx-hash query and kind chip, with a no-matches empty state.

import { useEffect, useMemo, useState } from 'react'
import { SidePanel, BottomSheet } from '@/design'
import type { DashboardActivityItem } from '@/components/dashboard/txActivityAdapter'
import { useMobileLayout } from '@/hooks/useMobileLayout'
import { matchesActivityKindFilter, matchesActivityTxHashSearch } from '@/components/dashboard/activityFilters'
import { ActivityKindFilters, type ActivityKindFilter } from '../ActivityKindFilters'
import { ActivityTxHashSearch } from '../ActivityTxHashSearch'
import searchStyles from '../ActivityTxHashSearch/ActivityTxHashSearch.module.css'
import { RecentActivityList } from '../RecentActivityList'
import panelStyles from './ActivityAllPanel.module.css'

export interface ActivityAllPanelProps {
  open: boolean
  onClose: () => void
  items: readonly DashboardActivityItem[]
  /** When set, the list was capped to this many rows — surfaces a "showing latest N" note. */
  truncatedCount?: number
  balanceRevealed?: boolean
  onItemClick?: (item: DashboardActivityItem) => void
}

export function ActivityAllPanel({
  open,
  onClose,
  items,
  truncatedCount,
  balanceRevealed = true,
  onItemClick,
}: ActivityAllPanelProps) {
  const isMobile = useMobileLayout()
  const [hashQuery, setHashQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<ActivityKindFilter>('all')

  useEffect(() => {
    if (!open) {
      setHashQuery('')
      setKindFilter('all')
    }
  }, [open])

  const filteredItems = useMemo(
    () =>
      items.filter(
        (item) => matchesActivityTxHashSearch(item, hashQuery) && matchesActivityKindFilter(item, kindFilter),
      ),
    [items, hashQuery, kindFilter],
  )

  const hasActiveFilters = hashQuery.trim().length > 0 || kindFilter !== 'all'
  const showFilterEmpty = hasActiveFilters && filteredItems.length === 0

  function handleItemClick(item: DashboardActivityItem) {
    onItemClick?.(item)
    onClose()
  }

  const list = (
    <>
      <div className={panelStyles.toolbar}>
        <ActivityTxHashSearch value={hashQuery} onChange={setHashQuery} />
        <ActivityKindFilters value={kindFilter} onChange={setKindFilter} />
      </div>
      {showFilterEmpty ? (
        <p className={searchStyles.searchEmpty}>No transactions match your filters.</p>
      ) : (
        <RecentActivityList
          variant="full"
          items={filteredItems}
          balanceRevealed={balanceRevealed}
          onItemClick={handleItemClick}
        />
      )}
      {truncatedCount != null ? (
        <p className={panelStyles.truncationNote}>
          Showing your {truncatedCount} most recent transactions.
        </p>
      ) : null}
    </>
  )

  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose} title="Recent activity">
        {list}
      </BottomSheet>
    )
  }

  return (
    <SidePanel open={open} onClose={onClose} title="Recent activity" panelClassName={panelStyles.panel}>
      {list}
    </SidePanel>
  )
}
