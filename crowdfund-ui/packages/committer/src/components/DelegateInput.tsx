// ABOUTME: Delegate address selector for ARM claim with mandatory delegation.
// ABOUTME: Pre-filled with connected address (self-delegate), supports custom address input.

import { useState, useEffect } from 'react'
import { isAddress } from 'ethers'

export interface DelegateInputProps {
  connectedAddress: string
  value: string
  onChange: (address: string) => void
}

export function DelegateInput({ connectedAddress, value, onChange }: DelegateInputProps) {
  const [useSelf, setUseSelf] = useState(true)

  useEffect(() => {
    if (useSelf) {
      onChange(connectedAddress)
    }
  }, [useSelf, connectedAddress, onChange])

  const isValid = isAddress(value)

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">Delegate Address</div>
      <div className="flex gap-2">
        <button
          className={`px-3 py-1 rounded text-xs ${
            useSelf ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setUseSelf(true)}
        >
          Self
        </button>
        <button
          className={`px-3 py-1 rounded text-xs ${
            !useSelf ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setUseSelf(false)}
        >
          Custom
        </button>
      </div>
      {!useSelf && (
        <div>
          <input
            type="text"
            placeholder="0x..."
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full rounded border border-input bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {value && !isValid && (
            <div className="text-xs text-destructive mt-1">Invalid address</div>
          )}
        </div>
      )}
    </div>
  )
}
