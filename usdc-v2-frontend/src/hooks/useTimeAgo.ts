import { useState, useEffect, useRef } from 'react'
import { formatTimeAgo } from '@/services/tx/transactionStatusService'

/**
 * Hook to manage time-ago text display with periodic updates
 * 
 * @param timestamp - Timestamp in milliseconds (or undefined if not available)
 * @param updateIntervalMs - Interval for periodic updates in milliseconds (default: 15000)
 * @returns The formatted time-ago text string
 */
export function useTimeAgo(
  timestamp: number | undefined,
  updateIntervalMs: number = 15000,
): string {
  const [timeAgoText, setTimeAgoText] = useState<string>('')
  const lastUpdatedTimestampRef = useRef<number | undefined>(undefined)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Update time ago text when timestamp changes
  useEffect(() => {
    if (timestamp) {
      setTimeAgoText(formatTimeAgo(timestamp))
    } else {
      setTimeAgoText('')
    }
  }, [timestamp])

  // Update time ago display periodically
  useEffect(() => {
    // Only update interval if timestamp value actually changed
    const timestampChanged = timestamp !== lastUpdatedTimestampRef.current

    if (!timestamp) {
      // Clear interval if timestamp is removed
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      lastUpdatedTimestampRef.current = undefined
      return
    }

    // Create/recreate interval if timestamp changed OR interval doesn't exist
    if (timestampChanged || !intervalRef.current) {
      // Clear existing interval if it exists
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }

      // Update ref to track current timestamp
      lastUpdatedTimestampRef.current = timestamp

      // Create new interval to update time ago text periodically
      // Use the ref value so the callback always has the latest timestamp
      intervalRef.current = setInterval(() => {
        const latestTimestamp = lastUpdatedTimestampRef.current
        if (latestTimestamp) {
          setTimeAgoText(formatTimeAgo(latestTimestamp))
        }
      }, updateIntervalMs)
    }

    return () => {
      // Only cleanup on unmount - don't cleanup on every re-render
      // The interval should persist across re-renders unless timestamp changes
      // We handle interval recreation in the effect body above
    }
    // Only restart interval if timestamp value actually changed, not on every balance state update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timestamp, updateIntervalMs])

  return timeAgoText
}
