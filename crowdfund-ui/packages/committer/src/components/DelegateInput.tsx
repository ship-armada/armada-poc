// ABOUTME: Delegate address selector for ARM claim with mandatory delegation.
// ABOUTME: Pre-filled with connected address (self-delegate), supports custom address input.

import { useState, useEffect } from 'react'
import { isAddress } from 'ethers'
import { Input, ToggleGroup, ToggleGroupItem } from '@armada/crowdfund-shared'

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
      <ToggleGroup
        type="single"
        value={useSelf ? 'self' : 'custom'}
        onValueChange={(v) => {
          if (v === 'self') setUseSelf(true)
          else if (v === 'custom') setUseSelf(false)
        }}
        className="gap-2"
      >
        <ToggleGroupItem value="self" size="sm" className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          Self
        </ToggleGroupItem>
        <ToggleGroupItem value="custom" size="sm" className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          Custom
        </ToggleGroupItem>
      </ToggleGroup>
      {!useSelf && (
        <div>
          <Input
            type="text"
            placeholder="0x..."
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="text-xs font-mono"
          />
          {value && !isValid && (
            <div className="text-xs text-destructive mt-1">Invalid address</div>
          )}
        </div>
      )}
    </div>
  )
}
