// ABOUTME: Renders a warning-variant ErrorAlert when any react-query has
// ABOUTME: stale data due to paused network or failing refetch.

import { WifiOff, CloudOff } from 'lucide-react'
import { ErrorAlert } from './ErrorAlert.js'
import { useStaleDataBanner } from '../hooks/useStaleDataBanner.js'
import type { IndexerHealth } from '../lib/indexer.js'

export interface StaleDataBannerProps {
  indexerHealth?: IndexerHealth | null
}

function getIndexerMessage(health: IndexerHealth): { title: string; message: string } | null {
  if (health.status === 'healthy') return null
  if (health.status === 'stale') {
    return {
      title: 'Indexer is catching up',
      message: `Showing verified data through block ${health.verifiedCursor}. The indexer is ${health.lagBlocks} confirmed blocks behind.`,
    }
  }
  if (health.status === 'degraded') {
    return {
      title: 'Indexer is repairing a gap',
      message: 'The app is showing the latest verified snapshot while the indexer repairs missing or suspicious ranges.',
    }
  }
  if (health.status === 'unhealthy' || health.status === 'unavailable') {
    return {
      title: 'Indexer unavailable',
      message: 'The app is using the last verified data available and will continue to fall back to RPC reads where possible.',
    }
  }
  return null
}

export function StaleDataBanner({ indexerHealth }: StaleDataBannerProps = {}) {
  const { isStale, reason } = useStaleDataBanner()
  const indexerMessage = indexerHealth ? getIndexerMessage(indexerHealth) : null
  if (indexerMessage) {
    return (
      <ErrorAlert variant="warning" icon={CloudOff} title={indexerMessage.title}>
        {indexerMessage.message}
      </ErrorAlert>
    )
  }
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
