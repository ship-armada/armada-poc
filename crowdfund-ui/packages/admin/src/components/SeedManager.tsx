// ABOUTME: Batch seed management panel for the launch team.
// ABOUTME: Textarea for pasting addresses, validation, dedup, and batch addSeeds() call.

import { useState, useMemo } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS, CROWDFUND_CONSTANTS } from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface SeedManagerProps {
  signer: Signer | null
  crowdfundAddress: string
  seedCount: number
}

export function SeedManager({ signer, crowdfundAddress, seedCount }: SeedManagerProps) {
  const [input, setInput] = useState('')
  const tx = useTransactionFlow(signer)

  const parsed = useMemo(() => {
    const lines = input.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)
    const valid: string[] = []
    const invalid: string[] = []
    const seen = new Set<string>()

    for (const line of lines) {
      const lower = line.toLowerCase()
      if (!isAddress(line)) {
        invalid.push(line)
      } else if (seen.has(lower)) {
        // skip duplicate
      } else {
        seen.add(lower)
        valid.push(line)
      }
    }

    return { valid, invalid }
  }, [input])

  const remaining = CROWDFUND_CONSTANTS.MAX_SEEDS - seedCount
  const wouldExceed = parsed.valid.length > remaining

  const handleAddSeeds = async () => {
    if (parsed.valid.length === 0 || wouldExceed) return

    const success = await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.addSeeds(parsed.valid)
    })

    if (success) setInput('')
  }

  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Seed Management</div>
        <div className="text-xs text-muted-foreground">
          {seedCount} / {CROWDFUND_CONSTANTS.MAX_SEEDS}
        </div>
      </div>
      <textarea
        placeholder="Paste addresses (one per line, comma, or semicolon separated)"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="w-full h-24 rounded border border-input bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
      />
      <div className="flex items-center justify-between text-xs">
        <div>
          <span className="text-muted-foreground">{parsed.valid.length} valid</span>
          {parsed.invalid.length > 0 && (
            <span className="text-destructive ml-2">{parsed.invalid.length} invalid</span>
          )}
        </div>
        {wouldExceed && (
          <span className="text-destructive">Exceeds remaining slots ({remaining})</span>
        )}
      </div>
      <button
        className="w-full rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={parsed.valid.length === 0 || wouldExceed || tx.state.status === 'pending' || tx.state.status === 'submitted'}
        onClick={handleAddSeeds}
      >
        Add {parsed.valid.length} Seed{parsed.valid.length !== 1 ? 's' : ''}
      </button>
      <TransactionFlow state={tx.state} onReset={tx.reset} successMessage="Seeds added!" />
    </div>
  )
}
