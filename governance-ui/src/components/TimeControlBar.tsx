// ABOUTME: Time control bar for fast-forwarding Anvil chain time during governance testing.
// ABOUTME: Provides preset buttons (+2d, +5d, +7d) and custom time input.

import { useState } from 'react'
import { useTimeControl } from '../hooks/useTimeControl'

const PRESETS = [
  { label: '+2 days', seconds: 2 * 86400 },
  { label: '+5 days', seconds: 5 * 86400 },
  { label: '+7 days', seconds: 7 * 86400 },
]

const UNITS: { label: string; multiplier: number }[] = [
  { label: 'seconds', multiplier: 1 },
  { label: 'minutes', multiplier: 60 },
  { label: 'hours', multiplier: 3600 },
  { label: 'days', multiplier: 86400 },
]

interface TimeControlBarProps {
  onTimeChanged?: () => Promise<void>
}

export function TimeControlBar({ onTimeChanged }: TimeControlBarProps) {
  const { fastForward, isAdvancing, error, isDisabled } = useTimeControl()
  const [customValue, setCustomValue] = useState('')
  const [unitIndex, setUnitIndex] = useState(3) // default: days

  const handlePreset = async (seconds: number) => {
    await fastForward(seconds)
    if (onTimeChanged) await onTimeChanged()
  }

  const handleCustom = async () => {
    const val = parseFloat(customValue)
    if (isNaN(val) || val <= 0) return
    const unit = UNITS[unitIndex]
    if (!unit) return
    const seconds = Math.floor(val * unit.multiplier)
    await fastForward(seconds)
    setCustomValue('')
    if (onTimeChanged) await onTimeChanged()
  }

  if (isDisabled) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs text-neutral-500">
        Time control disabled (Sepolia mode — real time only)
      </div>
    )
  }

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-neutral-400">Fast Forward:</span>

        {PRESETS.map(({ label, seconds }) => (
          <button
            key={label}
            onClick={() => handlePreset(seconds)}
            disabled={isAdvancing}
            className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
          >
            {label}
          </button>
        ))}

        <div className="flex items-center gap-1">
          <input
            type="number"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            placeholder="Custom"
            className="w-20 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 placeholder-neutral-600"
          />
          <select
            value={unitIndex}
            onChange={(e) => setUnitIndex(Number(e.target.value))}
            className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300"
          >
            {UNITS.map((u, i) => (
              <option key={u.label} value={i}>{u.label}</option>
            ))}
          </select>
          <button
            onClick={handleCustom}
            disabled={isAdvancing || !customValue}
            className="rounded bg-blue-700 px-3 py-1 text-xs text-white hover:bg-blue-600 disabled:opacity-50"
          >
            Go
          </button>
        </div>

        {isAdvancing && (
          <span className="text-xs text-yellow-400">Advancing time...</span>
        )}
        {error && (
          <span className="text-xs text-red-400">{error}</span>
        )}
      </div>
    </div>
  )
}
