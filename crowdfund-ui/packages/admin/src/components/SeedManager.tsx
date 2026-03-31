// ABOUTME: Batch seed management panel for the launch team.
// ABOUTME: Textarea for pasting addresses, validation, dedup, and batch addSeeds() call.

import { useState, useMemo } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS, CROWDFUND_CONSTANTS } from '@armada/crowdfund-shared'
import { isLocalMode } from '@/config/network'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

// Anvil default accounts (indices 2-19) from mnemonic "test test test test test test test test test test test junk"
// Indices 0-1 are deployer/LT and security council — excluded from seeds
const ANVIL_SEED_ADDRESSES = [
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  '0x14dC79964da2C08dda4c1086fB713d60497AF2E6',
  '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f',
  '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
  '0xBcd4042DE499D14e55001CcbB24a551F3b954096',
  '0x71bE63f3384f5fb98995898A86B02Fb2426c5788',
  '0xFABB0ac9d68B0B445fB7357272Ff202C5651694a',
  '0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec',
  '0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097',
  '0xcd3B766CCDd6AE721141F452C550Ca635964ce71',
  '0x2546BcD3c84621e976D8185a91A922aE77ECEc30',
  '0xbDA5747bFD65F08deb54cb465eB87D40e51B197E',
  '0xdD2FD4581271e230360230F9337D5c0430Bf44C0',
  '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199',
]

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
      {isLocalMode() && (
        <button
          className="w-full rounded border border-dashed border-muted-foreground/50 px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground hover:text-foreground"
          onClick={() => setInput(ANVIL_SEED_ADDRESSES.join('\n'))}
        >
          Fill Anvil Seeds ({ANVIL_SEED_ADDRESSES.length} accounts)
        </button>
      )}
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
