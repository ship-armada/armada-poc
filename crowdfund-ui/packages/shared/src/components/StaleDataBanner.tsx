// ABOUTME: Renders a warning-variant ErrorAlert when any react-query has
// ABOUTME: stale data due to paused network or failing refetch.

import { WifiOff, CloudOff } from 'lucide-react'
import { ErrorAlert } from './ErrorAlert.js'
import { useStaleDataBanner } from '../hooks/useStaleDataBanner.js'

export function StaleDataBanner() {
  const { isStale, reason } = useStaleDataBanner()
  if (!isStale) return null

  const title =
    reason === 'paused'
      ? 'Connection interrupted'
      : 'Live updates paused'
  const message =
    reason === 'paused'
      ? 'You appear to be offline. Data shown may be out of date until the connection is restored.'
      : 'A recent refetch failed. Data shown may be out of date — retrying automatically.'

  return (
    <ErrorAlert
      variant="warning"
      icon={reason === 'paused' ? WifiOff : CloudOff}
      title={title}
    >
      {message}
    </ErrorAlert>
  )
}
