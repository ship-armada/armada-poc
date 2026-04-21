// ABOUTME: Invite link management UI — create, copy, and revoke EIP-712 signed invite links.
// ABOUTME: Renders below the direct invite form in the Invite tab.

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Badge, Button, formatCountdown, hopLabel, formatUsdc, HOP_CONFIGS } from '@armada/crowdfund-shared'
import type { UseInviteLinksResult } from '@/hooks/useInviteLinks'
import type { HopPosition } from '@/hooks/useEligibility'

type InviteLinkBadgeVariant = 'status-submitted' | 'status-confirmed' | 'outline'
const statusBadgeVariant: Record<string, InviteLinkBadgeVariant> = {
  pending: 'status-submitted',
  redeemed: 'status-confirmed',
  revoked: 'outline',
  expired: 'outline',
}

export interface InviteLinkSectionProps {
  inviteLinks: UseInviteLinksResult
  positions: HopPosition[]
  blockTimestamp: number
}

export function InviteLinkSection({ inviteLinks, positions, blockTimestamp }: InviteLinkSectionProps) {
  const { links, createLink, revokeLink } = inviteLinks
  const [selectedHop, setSelectedHop] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  // Positions with available invite slots
  const invitePositions = positions.filter((p) => p.invitesAvailable > 0)

  // Auto-select first available hop
  useEffect(() => {
    if (selectedHop === null && invitePositions.length > 0) {
      setSelectedHop(invitePositions[0].hop)
    }
  }, [selectedHop, invitePositions])

  const handleCreateLink = useCallback(async () => {
    if (selectedHop === null) return
    setCreating(true)
    const url = await createLink(selectedHop)
    setCreating(false)
    if (url) {
      const fullUrl = `${window.location.origin}${url}`
      await navigator.clipboard.writeText(fullUrl)
      toast.success('Invite link copied to clipboard!')
    } else {
      toast.error('Failed to create invite link')
    }
  }, [selectedHop, createLink])

  const handleCreateAll = useCallback(async () => {
    setCreating(true)
    for (const pos of invitePositions) {
      for (let i = 0; i < pos.invitesAvailable; i++) {
        await createLink(pos.hop)
      }
    }
    setCreating(false)
    toast.success('All invite links created!')
  }, [invitePositions, createLink])

  const handleCopy = useCallback(async (link: { inviter: string; fromHop: number; nonce: number; deadline: number; signature: string }) => {
    const params = new URLSearchParams({
      inviter: link.inviter,
      fromHop: String(link.fromHop),
      nonce: String(link.nonce),
      deadline: String(link.deadline),
      sig: link.signature,
    })
    const url = `${window.location.origin}/invite?${params.toString()}`
    await navigator.clipboard.writeText(url)
    toast.success('Link copied!')
  }, [])

  const handleRevoke = useCallback(async (nonce: number) => {
    await revokeLink(nonce)
  }, [revokeLink])

  // Outstanding pending links warning
  const pendingCount = links.filter((l) => l.status === 'pending').length
  const totalSlots = invitePositions.reduce((sum, p) => sum + p.invitesAvailable, 0)

  return (
    <div className="space-y-3 border-t border-border pt-4 mt-4">
      <div className="text-xs font-medium text-muted-foreground">Invite Links (EIP-712)</div>

      {invitePositions.length === 0 ? (
        <div className="text-xs text-muted-foreground">No invite slots available for link creation.</div>
      ) : (
        <>
          {/* Hop selector + Create button */}
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
                {hopLabel(pos.hop)} ({pos.invitesAvailable})
              </button>
            ))}
          </div>

          {/* Creation prompt with contextual details */}
          {selectedHop !== null && (() => {
            const targetHop = selectedHop + 1
            const targetConfig = targetHop < HOP_CONFIGS.length ? HOP_CONFIGS[targetHop] : null
            const selectedPos = invitePositions.find((p) => p.hop === selectedHop)
            return (
              <div className="rounded border border-border p-2 space-y-1 text-xs text-muted-foreground">
                <div>From: your {hopLabel(selectedHop)} position</div>
                <div>
                  Inviting to: {hopLabel(targetHop)}
                  {targetConfig && <span> ({formatUsdc(targetConfig.capUsdc)} cap, {targetConfig.maxInvites} invite slots)</span>}
                </div>
                {selectedPos && (
                  <div>Available slots: {selectedPos.invitesAvailable} of {selectedPos.invitesUsed + selectedPos.invitesAvailable} remaining</div>
                )}
                <div className="mt-1">
                  This creates a one-time link. The first person to use it joins the network at {hopLabel(targetHop)} and commits USDC in one step.
                </div>
                <div>Link expires: 5 days from now</div>
                <div className="text-amber-500 mt-1">
                  This is a bearer link — anyone with it can use it. Share it privately.
                </div>
              </div>
            )
          })()}

          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 text-xs"
              disabled={creating || selectedHop === null}
              onClick={handleCreateLink}
            >
              {creating ? 'Creating...' : 'Create Invite Link'}
            </Button>
            {totalSlots > 1 && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={creating}
                onClick={handleCreateAll}
              >
                Create All ({totalSlots})
              </Button>
            )}
          </div>

          {pendingCount > totalSlots && (
            <div className="text-xs text-amber-500">
              Warning: {pendingCount} outstanding links exceed {totalSlots} remaining invite slots.
            </div>
          )}
        </>
      )}

      {/* Link management table */}
      {links.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">{links.length} link{links.length !== 1 ? 's' : ''}</div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {links.map((link) => {
              const timeLeft = link.deadline - blockTimestamp

              return (
                <div
                  key={`${link.inviter}-${link.nonce}`}
                  className="flex items-center gap-2 text-xs rounded border border-border/50 p-2"
                >
                  <Badge variant={statusBadgeVariant[link.status]} className="text-[10px] font-medium">
                    {link.status}
                  </Badge>
                  <span className="text-muted-foreground">{hopLabel(link.fromHop)}</span>
                  <span className="text-muted-foreground">
                    {link.status === 'pending' && timeLeft > 0 ? formatCountdown(timeLeft) : ''}
                  </span>
                  <span className="flex-1" />
                  {link.status === 'pending' && (
                    <>
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-[10px]"
                        onClick={() => handleCopy(link)}
                      >
                        Copy
                      </Button>
                      <Button
                        variant="linkDestructive"
                        size="sm"
                        className="h-auto p-0 text-[10px]"
                        onClick={() => handleRevoke(link.nonce)}
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

    </div>
  )
}
