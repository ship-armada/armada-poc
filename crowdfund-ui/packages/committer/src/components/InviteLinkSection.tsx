// ABOUTME: Invite link management UI — create, copy, and revoke EIP-712 signed invite links.
// ABOUTME: Renders below the direct invite form in the Invite tab.

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { formatCountdown, hopLabel } from '@armada/crowdfund-shared'
import type { UseInviteLinksResult } from '@/hooks/useInviteLinks'
import type { HopPosition } from '@/hooks/useEligibility'
import { TransactionFlow } from './TransactionFlow'
import { getExplorerUrl } from '@/config/network'

export interface InviteLinkSectionProps {
  inviteLinks: UseInviteLinksResult
  positions: HopPosition[]
  blockTimestamp: number
}

export function InviteLinkSection({ inviteLinks, positions, blockTimestamp }: InviteLinkSectionProps) {
  const { links, createLink, revokeLink, revokeTx } = inviteLinks
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

          <div className="flex gap-2">
            <button
              className="flex-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={creating || selectedHop === null}
              onClick={handleCreateLink}
            >
              {creating ? 'Creating...' : 'Create Invite Link'}
            </button>
            {totalSlots > 1 && (
              <button
                className="rounded border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                disabled={creating}
                onClick={handleCreateAll}
              >
                Create All ({totalSlots})
              </button>
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
              const statusColors: Record<string, string> = {
                pending: 'bg-info/20 text-info',
                redeemed: 'bg-success/20 text-success',
                revoked: 'bg-muted text-muted-foreground',
                expired: 'bg-muted text-muted-foreground',
              }

              return (
                <div
                  key={`${link.inviter}-${link.nonce}`}
                  className="flex items-center gap-2 text-xs rounded border border-border/50 p-2"
                >
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusColors[link.status]}`}>
                    {link.status}
                  </span>
                  <span className="text-muted-foreground">{hopLabel(link.fromHop)}</span>
                  <span className="text-muted-foreground">
                    {link.status === 'pending' && timeLeft > 0 ? formatCountdown(timeLeft) : ''}
                  </span>
                  <span className="flex-1" />
                  {link.status === 'pending' && (
                    <>
                      <button
                        className="text-primary hover:underline text-[10px]"
                        onClick={() => handleCopy(link)}
                      >
                        Copy
                      </button>
                      <button
                        className="text-destructive hover:underline text-[10px]"
                        onClick={() => handleRevoke(link.nonce)}
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <TransactionFlow
        state={revokeTx.state}
        onReset={revokeTx.reset}
        successMessage="Link revoked!"
        explorerUrl={getExplorerUrl()}
      />
    </div>
  )
}
