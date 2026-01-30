import { useState, useEffect, useMemo } from 'react'
import { Clock, Loader2 } from 'lucide-react'
import type { EvmChainsFile } from '@/config/chains'
import { fetchEvmChainsConfig } from '@/services/config/chainConfigService'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface ChainSelectProps {
  value: string
  onChange: (chainKey: string) => void
  disabled?: boolean
  showEstimatedTime?: boolean
  timeType?: 'send' | 'deposit'
}

export function ChainSelect({
  value,
  onChange,
  disabled = false,
  showEstimatedTime = true,
  timeType = 'send',
}: ChainSelectProps) {
  const [chainsConfig, setChainsConfig] = useState<EvmChainsFile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load chains config on mount
  useEffect(() => {
    let mounted = true

    async function loadChains() {
      try {
        setLoading(true)
        setError(null)
        const config = await fetchEvmChainsConfig()
        if (mounted) {
          setChainsConfig(config)
        }
      } catch (err) {
        if (mounted) {
          const message = err instanceof Error ? err.message : 'Failed to load chains'
          setError(message)
          console.error('[ChainSelect] Failed to load chains:', err)
        }
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    void loadChains()

    return () => {
      mounted = false
    }
  }, [])

  // Get chain options from config
  const chainOptions = useMemo(() => {
    if (!chainsConfig) return []
    return chainsConfig.chains.map((chain) => ({
      key: chain.key,
      name: chain.name,
      logo: chain.logo,
      estimatedTime: chain.estimatedTimes?.[timeType] ?? chain.estimatedTimes?.send ?? '—',
    }))
  }, [chainsConfig, timeType])

  // Get selected chain config
  const selectedChain = useMemo(() => {
    if (!chainsConfig) return null
    return chainsConfig.chains.find((chain) => chain.key === value) ?? null
  }, [chainsConfig, value])

  // Get selected chain estimated time
  const selectedEstimatedTime = useMemo(() => {
    if (!selectedChain) return null
    return selectedChain.estimatedTimes?.[timeType] ?? selectedChain.estimatedTimes?.send ?? null
  }, [selectedChain, timeType])

  // Handle select change
  function handleValueChange(newValue: string) {
    if (newValue && newValue !== value) {
      onChange(newValue)
    }
  }

  // If loading, show loading state
  if (loading) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-input bg-muted/40 px-4 py-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading chains...</span>
      </div>
    )
  }

  // If error, show error state
  if (error || !chainsConfig) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3">
        <span className="text-sm text-destructive">
          {error ?? 'Failed to load chains'}
        </span>
      </div>
    )
  }

  // If no chains available
  if (chainOptions.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-input bg-muted/40 px-4 py-3">
        <span className="text-sm text-muted-foreground">No chains available</span>
      </div>
    )
  }

  // Render select with chain info
  return (
    <Select value={value} onValueChange={handleValueChange} disabled={disabled}>
      <SelectTrigger className="flex flex-1 h-auto px-4 pl-3 py-3 shadow-sm border">
        <div className="w-full flex items-center gap-3">
          {/* Chain logo */}
          {selectedChain?.logo && (
            <img
              src={selectedChain.logo}
              alt={selectedChain.name}
              className="h-6 w-6 rounded-full flex-shrink-0"
              onError={(e) => {
                // Hide image if it fails to load
                e.currentTarget.style.display = 'none'
              }}
            />
          )}
          <div className="flex-1 min-w-0">
            {selectedChain ? (
              <div className="w-full flex items-center justify-between">
                <span className="text-sm font-medium">{selectedChain.name}</span>
                {showEstimatedTime && selectedEstimatedTime && selectedEstimatedTime !== '—' && (
                  <span className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap pr-2">
                    <Clock className="h-4 w-4" />
                    {selectedEstimatedTime}
                  </span>
                )}
              </div>
            ) : (
              <SelectValue placeholder="Select a chain" />
            )}
          </div>
        </div>
      </SelectTrigger>
      <SelectContent className="z-50">
        <SelectGroup>
          {chainOptions.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              <div className="min-w-84 w-full flex items-center justify-between">
                {option.logo && (
                  <img
                    src={option.logo}
                    alt={option.name}
                    className="h-4 w-4 mr-2 rounded-full flex-shrink-0"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none'
                    }}
                  />
                )}
                <span className="flex flex-1 justify-start text-foreground font-medium">{option.name}</span>
                {showEstimatedTime && option.estimatedTime && option.estimatedTime !== '—' && (
                  <span className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap pr-2">
                    <Clock className="h-4 w-4" />
                    {option.estimatedTime}
                  </span>
                )}
              </div>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
