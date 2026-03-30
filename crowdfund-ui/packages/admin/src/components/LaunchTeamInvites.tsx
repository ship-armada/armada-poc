// ABOUTME: Launch team invite panel with budget display and hop toggle.
// ABOUTME: Sends launchTeamInvite() transactions within the week-1 window.

import { useState, useCallback } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer } from 'ethers'
import {
  CROWDFUND_ABI_FRAGMENTS,
  formatCountdown,
} from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface LaunchTeamInvitesProps {
  signer: Signer | null
  crowdfundAddress: string
  hop1Remaining: number
  hop2Remaining: number
  blockTimestamp: number
  launchTeamInviteEnd: number
}

export function LaunchTeamInvites(props: LaunchTeamInvitesProps) {
  const { signer, crowdfundAddress, hop1Remaining, hop2Remaining, blockTimestamp, launchTeamInviteEnd } = props
  const [inviteeAddress, setInviteeAddress] = useState('')
  const [selectedHop, setSelectedHop] = useState<0 | 1>(0)
  const tx = useTransactionFlow(signer)

  const remaining = selectedHop === 0 ? hop1Remaining : hop2Remaining
  const timeLeft = launchTeamInviteEnd - blockTimestamp
  const valid = isAddress(inviteeAddress) && remaining > 0

  const handleInvite = useCallback(async () => {
    if (!valid) return

    const success = await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      // fromHop parameter: 0 = invite to hop-1, 1 = invite to hop-2
      return crowdfund.launchTeamInvite(inviteeAddress, selectedHop)
    })

    if (success) setInviteeAddress('')
  }, [valid, inviteeAddress, selectedHop, crowdfundAddress, tx])

  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Launch Team Invites</div>
        <div className="text-xs text-muted-foreground">
          {timeLeft > 0 ? formatCountdown(timeLeft) : 'expired'}
        </div>
      </div>

      {/* Budget display */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border border-border p-2">
          <span className="text-muted-foreground">Hop-1: </span>
          <span className="font-medium">{hop1Remaining} remaining</span>
        </div>
        <div className="rounded border border-border p-2">
          <span className="text-muted-foreground">Hop-2: </span>
          <span className="font-medium">{hop2Remaining} remaining</span>
        </div>
      </div>

      {/* Hop toggle */}
      <div className="flex gap-1">
        <button
          className={`flex-1 px-3 py-1 rounded text-xs ${
            selectedHop === 0
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setSelectedHop(0)}
        >
          Invite to Hop-1 ({hop1Remaining})
        </button>
        <button
          className={`flex-1 px-3 py-1 rounded text-xs ${
            selectedHop === 1
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setSelectedHop(1)}
        >
          Invite to Hop-2 ({hop2Remaining})
        </button>
      </div>

      {/* Address input */}
      <input
        type="text"
        placeholder="0x... invitee address"
        value={inviteeAddress}
        onChange={(e) => setInviteeAddress(e.target.value)}
        className="w-full rounded border border-input bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />

      <button
        className="w-full rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={!valid || tx.state.status === 'pending' || tx.state.status === 'submitted'}
        onClick={handleInvite}
      >
        Send LT Invite
      </button>

      <TransactionFlow state={tx.state} onReset={tx.reset} successMessage="Invite sent!" />
    </div>
  )
}
