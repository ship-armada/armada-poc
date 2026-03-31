// ABOUTME: Launch team invite panel with budget display, hop toggle, ENS resolution, and whitelist check.
// ABOUTME: Sends launchTeamInvite() transactions within the week-1 window.

import { useState, useCallback, useEffect } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer, JsonRpcProvider } from 'ethers'
import {
  CROWDFUND_ABI_FRAGMENTS,
  HOP_CONFIGS,
  formatCountdown,
  formatUsdc,
} from '@armada/crowdfund-shared'
import { isLocalMode } from '@/config/network'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface LaunchTeamInvitesProps {
  signer: Signer | null
  crowdfundAddress: string
  hop1Remaining: number
  hop2Remaining: number
  blockTimestamp: number
  launchTeamInviteEnd: number
  provider: JsonRpcProvider | null
}

export function LaunchTeamInvites(props: LaunchTeamInvitesProps) {
  const { signer, crowdfundAddress, hop1Remaining, hop2Remaining, blockTimestamp, launchTeamInviteEnd, provider } = props
  const [inviteeAddress, setInviteeAddress] = useState('')
  const [selectedHop, setSelectedHop] = useState<0 | 1>(0)
  const tx = useTransactionFlow(signer)

  // ENS resolution state
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)

  // Already-whitelisted notice state
  const [existingSlots, setExistingSlots] = useState<number | null>(null)

  const looksLikeEns = inviteeAddress.includes('.') && !inviteeAddress.startsWith('0x')
  const effectiveAddress = resolvedAddress ?? inviteeAddress
  const remaining = selectedHop === 0 ? hop1Remaining : hop2Remaining
  const timeLeft = launchTeamInviteEnd - blockTimestamp
  const valid = isAddress(effectiveAddress) && remaining > 0

  // ENS resolution
  const handleResolve = async () => {
    if (!provider || !looksLikeEns) return
    setResolving(true)
    setResolveError(null)
    try {
      const resolved = await provider.resolveName(inviteeAddress)
      if (resolved) {
        setResolvedAddress(resolved)
      } else {
        setResolveError('Could not resolve ENS name.')
      }
    } catch {
      setResolveError('Could not resolve ENS name.')
    } finally {
      setResolving(false)
    }
  }

  // Clear resolution when input changes
  useEffect(() => {
    setResolvedAddress(null)
    setResolveError(null)
  }, [inviteeAddress])

  // Check if address is already whitelisted at target hop
  useEffect(() => {
    setExistingSlots(null)
    if (!provider || !isAddress(effectiveAddress) || !crowdfundAddress) return

    const targetHop = selectedHop === 0 ? 1 : 2
    const contract = new Contract(crowdfundAddress, [
      'function participants(address, uint8) view returns (bool isWhitelisted, uint16 invitesReceived, uint256 committed, address invitedBy, uint16 invitesSent)',
    ], provider)

    contract.participants(effectiveAddress, targetHop)
      .then((result: { invitesReceived: number }) => {
        const received = Number(result.invitesReceived)
        setExistingSlots(received > 0 ? received : null)
      })
      .catch(() => {})
  }, [effectiveAddress, selectedHop, provider, crowdfundAddress])

  const handleInvite = useCallback(async () => {
    if (!valid) return

    const success = await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      // fromHop parameter: 0 = invite to hop-1, 1 = invite to hop-2
      return crowdfund.launchTeamInvite(effectiveAddress, selectedHop)
    })

    if (success) {
      setInviteeAddress('')
      setResolvedAddress(null)
    }
  }, [valid, effectiveAddress, selectedHop, crowdfundAddress, tx])

  const targetHop = selectedHop === 0 ? 1 : 2
  const targetCapUsdc = targetHop < HOP_CONFIGS.length ? HOP_CONFIGS[targetHop].capUsdc : 0n

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
      <div className="space-y-1">
        <input
          type="text"
          placeholder={isLocalMode() ? '0x... invitee address' : '0x... or ENS name'}
          value={inviteeAddress}
          onChange={(e) => setInviteeAddress(e.target.value)}
          className="w-full rounded border border-input bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />

        {/* ENS resolution — only on non-local networks */}
        {looksLikeEns && !isLocalMode() && (
          <div className="text-xs space-y-1">
            {resolvedAddress ? (
              <div className="text-success">
                {inviteeAddress} → <span className="font-mono">{resolvedAddress}</span>
              </div>
            ) : resolveError ? (
              <div className="text-destructive">{resolveError}</div>
            ) : (
              <button
                className="text-info hover:underline"
                onClick={handleResolve}
                disabled={resolving}
              >
                {resolving ? 'Resolving...' : 'Resolve ENS name'}
              </button>
            )}
          </div>
        )}

        {/* Already-whitelisted notice */}
        {existingSlots !== null && (
          <div className="text-xs text-info bg-info/10 rounded px-2 py-1">
            This address already has {existingSlots} slot{existingSlots !== 1 ? 's' : ''} at Hop-{targetHop}.
            This invite adds another slot, increasing their cap by {formatUsdc(targetCapUsdc)}.
          </div>
        )}
      </div>

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
