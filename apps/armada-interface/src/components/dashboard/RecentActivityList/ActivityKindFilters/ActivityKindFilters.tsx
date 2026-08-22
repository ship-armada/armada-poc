// ABOUTME: Segmented kind-filter chips for the activity panel — All / Shield / Unshield / Sent / Requests / Received / Earn.
// ABOUTME: Renders a scroll-layout SegmentedControl; the chip id equals the activity kind so the predicate is a direct match.

import { SegmentedControl } from '@/components/ui'

export type ActivityKindFilter =
  | 'all'
  | 'deposit'
  | 'withdraw'
  | 'send'
  | 'requestLink'
  | 'receive'
  | 'earn'

const FILTERS: Array<{ id: ActivityKindFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'deposit', label: 'Shield' },
  { id: 'withdraw', label: 'Unshield' },
  { id: 'send', label: 'Sent' },
  { id: 'requestLink', label: 'Requests' },
  { id: 'receive', label: 'Received' },
  { id: 'earn', label: 'Earn' },
]

export interface ActivityKindFiltersProps {
  value: ActivityKindFilter
  onChange: (value: ActivityKindFilter) => void
}

export function ActivityKindFilters({ value, onChange }: ActivityKindFiltersProps) {
  return (
    <SegmentedControl
      options={FILTERS}
      value={value}
      onChange={onChange}
      size="sm"
      layout="scroll"
      surface="raised"
      aria-label="Filter by transaction type"
    />
  )
}
