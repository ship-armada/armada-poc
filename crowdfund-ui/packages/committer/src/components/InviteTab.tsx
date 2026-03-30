// ABOUTME: Direct invite UI (Path B) — invite by address, inviter pays gas.
// ABOUTME: Shows invite slots per hop, address input, validation, and self-invite shortcut.

import { useState, useMemo, useCallback } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer } from 'ethers'
import {
  hopLabel,
  CROWDFUND_ABI_FRAGMENTS,
} from '@armada/crowdfund-shared'
import type { HopPosition } from '@/hooks/useEligibility'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface InviteTabProps {
  positions: HopPosition[]
  signer: Signer | null
  address: string | null
  crowdfundAddress: string
  phase: number
  windowOpen: boolean
}

export function InviteTab(props: InviteTabProps) {
  const {
    positions,
    signer,
    address,
    crowdfundAddress,
    phase,
    windowOpen,
  } = props

  const [inviteeAddress, setInviteeAddress] = useState('')
  const [selectedHop, setSelectedHop] = useState<number | null>(null)
  const tx = useTransactionFlow(signer)

  // Positions with available invite slots
  const invitePositions = useMemo(
    () => positions.filter((p) => p.invitesAvailable > 0),
    [positions],
  )

  // Auto-select first available hop
  useMemo(() => {
    if (selectedHop === null && invitePositions.length > 0) {
      setSelectedHop(invitePositions[0].hop)
    }
  }, [invitePositions, selectedHop])

  // Validation
  const validationError = useMemo(() => {
    if (!inviteeAddress) return null
    if (!isAddress(inviteeAddress)) return 'Invalid Ethereum address'
    if (inviteeAddress.toLowerCase() === address?.toLowerCase()) return null // Self-invite is valid
    return null
  }, [inviteeAddress, address])

  const canInvite =
    inviteeAddress &&
    !validationError &&
    selectedHop !== null &&
    phase === 0 &&
    windowOpen

  const handleInvite = useCallback(async () => {
    if (!canInvite || selectedHop === null) return

    await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.invite(inviteeAddress, selectedHop)
    })

    if (tx.state.status !== 'error') {
      setInviteeAddress('')
    }
  }, [canInvite, selectedHop, inviteeAddress, crowdfundAddress, tx])

  const handleSelfInvite = useCallback(async (hop: number) => {
    if (!address) return

    await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.invite(address, hop)
    })
  }, [address, crowdfundAddress, tx])

  if (invitePositions.length === 0) {
    return (
      <div className="p-4 text-center space-y-2">
        <div className="text-muted-foreground">No Invite Slots Available</div>
        <div className="text-xs text-muted-foreground">
          {positions.length === 0
            ? 'You must be invited to the crowdfund before you can invite others.'
            : 'All your invite slots have been used.'}
        </div>
      </div>
    )
  }

  if (phase !== 0 || !windowOpen) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        Invites can only be sent during the active commitment window.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Invite slot summary */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Your Invite Slots</div>
        {invitePositions.map((pos) => (
          <div
            key={pos.hop}
            className="flex items-center justify-between rounded border border-border p-2"
          >
            <div>
              <span className="text-sm font-medium">{hopLabel(pos.hop)}</span>
              <span className="text-xs text-muted-foreground ml-2">
                {pos.invitesUsed} used / {pos.invitesUsed + pos.invitesAvailable} total
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {pos.invitesAvailable} remaining
              </span>
              {/* Self-invite shortcut */}
              <button
                className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:text-foreground"
                onClick={() => handleSelfInvite(pos.hop)}
                title={`Invite yourself at ${hopLabel(pos.hop + 1)}`}
              >
                Self
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Direct invite form */}
      <div className="space-y-3">
        <div className="text-xs font-medium text-muted-foreground">Send Direct Invite</div>

        {/* Hop selector */}
        <div className="flex gap-1">
          {invitePositions.map((pos) => (
            <button
              key={pos.hop}
              className={`px-3 py-1 rounded text-xs ${
                selectedHop === pos.hop
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setSelectedHop(pos.hop)}
            >
              From {hopLabel(pos.hop)} → {hopLabel(pos.hop + 1)}
            </button>
          ))}
        </div>

        {/* Address input */}
        <div>
          <input
            type="text"
            placeholder="0x... or ENS name"
            value={inviteeAddress}
            onChange={(e) => setInviteeAddress(e.target.value)}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {validationError && (
            <div className="text-xs text-destructive mt-1">{validationError}</div>
          )}
        </div>

        {/* Invite button */}
        <button
          className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={!canInvite}
          onClick={handleInvite}
        >
          Send Invite
        </button>

        <div className="text-xs text-muted-foreground">
          Direct invite: you pay gas, invitee appears in the graph immediately.
          They can then commit USDC at hop-{(selectedHop ?? 0) + 1}.
        </div>
      </div>

      <TransactionFlow
        state={tx.state}
        onReset={tx.reset}
        successMessage="Invite sent!"
      />
    </div>
  )
}
