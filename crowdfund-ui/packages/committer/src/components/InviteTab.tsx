// ABOUTME: Direct invite UI (Path B) — invite by address, inviter pays gas.
// ABOUTME: Shows invite slots per hop, address input, validation, and self-invite shortcut.

import { useState, useMemo, useCallback, useEffect } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer, JsonRpcProvider } from 'ethers'
import {
  Button,
  Input,
  hopLabel,
  formatUsdc,
  CROWDFUND_ABI_FRAGMENTS,
  HOP_CONFIGS,
  type GraphNode,
} from '@armada/crowdfund-shared'
import type { HopPosition } from '@/hooks/useEligibility'
import type { UseInviteLinksResult } from '@/hooks/useInviteLinks'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { getExplorerUrl } from '@/config/network'
import { InviteLinkSection } from './InviteLinkSection'

export interface InviteTabProps {
  positions: HopPosition[]
  signer: Signer | null
  address: string | null
  crowdfundAddress: string
  phase: number
  windowOpen: boolean
  inviteLinks: UseInviteLinksResult
  blockTimestamp: number
  nodes: Map<string, GraphNode>
  provider: JsonRpcProvider | null
}

export function InviteTab(props: InviteTabProps) {
  const {
    positions,
    signer,
    address,
    crowdfundAddress,
    phase,
    windowOpen,
    inviteLinks,
    blockTimestamp,
    nodes,
    provider,
  } = props

  const [inviteeAddress, setInviteeAddress] = useState('')
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [selectedHop, setSelectedHop] = useState<number | null>(null)
  const tx = useTransactionFlow(signer, { explorerUrl: getExplorerUrl() })

  // Positions with available invite slots
  const invitePositions = useMemo(
    () => positions.filter((p) => p.invitesAvailable > 0),
    [positions],
  )

  // Auto-select first available hop
  useEffect(() => {
    if (selectedHop === null && invitePositions.length > 0) {
      setSelectedHop(invitePositions[0].hop)
    }
  }, [invitePositions, selectedHop])

  // ENS resolution — resolve names containing '.'
  useEffect(() => {
    if (!provider || !inviteeAddress.includes('.')) {
      setResolvedAddress(null)
      return
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      setResolving(true)
      try {
        const addr = await provider.resolveName(inviteeAddress)
        if (!cancelled) setResolvedAddress(addr)
      } catch {
        if (!cancelled) setResolvedAddress(null)
      } finally {
        if (!cancelled) setResolving(false)
      }
    }, 500) // debounce

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [provider, inviteeAddress])

  // The effective address to invite (resolved ENS or direct input)
  const effectiveAddress = resolvedAddress ?? inviteeAddress
  const targetHop = selectedHop !== null ? selectedHop + 1 : 0

  // Duplicate invite warning
  const duplicateWarning = useMemo(() => {
    if (!effectiveAddress || !isAddress(effectiveAddress) || selectedHop === null) return null
    const nodeKey = `${effectiveAddress.toLowerCase()}-${targetHop}`
    const existing = nodes.get(nodeKey)
    if (!existing || existing.invitesReceived === 0) return null
    const capUsdc = targetHop < HOP_CONFIGS.length ? HOP_CONFIGS[targetHop].capUsdc : 0n
    return `This address already has ${existing.invitesReceived} slot${existing.invitesReceived > 1 ? 's' : ''} at ${hopLabel(targetHop)}. Your invite will add another slot, increasing their cap by ${formatUsdc(capUsdc)}.`
  }, [effectiveAddress, selectedHop, targetHop, nodes])

  // Validation
  const validationError = useMemo(() => {
    if (!inviteeAddress) return null
    if (resolvedAddress) return null // ENS resolved successfully
    if (inviteeAddress.includes('.') && !resolving) return 'ENS name not found'
    if (inviteeAddress.includes('.') && resolving) return null // Still resolving
    if (!isAddress(inviteeAddress)) return 'Invalid Ethereum address'
    return null
  }, [inviteeAddress, resolvedAddress, resolving])

  const canInvite =
    effectiveAddress &&
    isAddress(effectiveAddress) &&
    !validationError &&
    selectedHop !== null &&
    phase === 0 &&
    windowOpen

  const handleInvite = useCallback(async () => {
    if (!canInvite || selectedHop === null) return

    const success = await tx.execute(
      `Invite to ${hopLabel(selectedHop + 1)}`,
      async (s) => {
        const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
        return crowdfund.invite(effectiveAddress, selectedHop)
      },
    )

    if (success) {
      setInviteeAddress('')
      setResolvedAddress(null)
    }
  }, [canInvite, selectedHop, effectiveAddress, crowdfundAddress, tx])

  const handleSelfInvite = useCallback(async (hop: number) => {
    if (!address) return

    await tx.execute(
      `Self-invite at ${hopLabel(hop + 1)}`,
      async (s) => {
        const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
        return crowdfund.invite(address, hop)
      },
    )
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
        Invites can only be sent during the active sale window.
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
              <Button
                variant="secondary"
                size="xs"
                onClick={() => handleSelfInvite(pos.hop)}
                title={`Invite yourself at ${hopLabel(pos.hop + 1)}`}
              >
                Self
              </Button>
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
          <Input
            type="text"
            placeholder="0x... or ENS name"
            value={inviteeAddress}
            onChange={(e) => setInviteeAddress(e.target.value)}
            className="text-sm font-mono"
          />
          {/* ENS resolution display */}
          {resolving && (
            <div className="text-xs text-muted-foreground mt-1">Resolving ENS name...</div>
          )}
          {resolvedAddress && (
            <div className="text-xs text-success mt-1">
              {inviteeAddress} → <span className="font-mono">{resolvedAddress.slice(0, 6)}...{resolvedAddress.slice(-4)}</span>
            </div>
          )}
          {validationError && (
            <div className="text-xs text-destructive mt-1">{validationError}</div>
          )}
        </div>

        {/* Duplicate invite warning */}
        {duplicateWarning && (
          <div className="text-xs text-amber-500 rounded border border-amber-500/30 bg-amber-500/5 p-2">
            {duplicateWarning}
          </div>
        )}

        {/* Invite button */}
        <Button
          className="w-full"
          disabled={!canInvite}
          onClick={handleInvite}
        >
          Send Invite
        </Button>

        <div className="text-xs text-muted-foreground">
          Direct invite: you pay gas, invitee appears in the graph immediately.
          They can then commit USDC at hop-{(selectedHop ?? 0) + 1}.
        </div>
      </div>

      <InviteLinkSection
        inviteLinks={inviteLinks}
        positions={positions}
        blockTimestamp={blockTimestamp}
      />
    </div>
  )
}
