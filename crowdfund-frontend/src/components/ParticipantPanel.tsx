// ABOUTME: Participant actions panel for invite, commit, claim, and refund.
// ABOUTME: Shows current participant status and available actions based on phase.
import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { UserPlus, DollarSign, Gift, Undo2 } from 'lucide-react'
import { Phase } from '@/types/crowdfund'
import { formatUsdc, formatArm, hopLabel, parseUsdcInput } from '@/utils/format'
import type { CrowdfundState } from '@/atoms/crowdfund'
import type { useCrowdfund } from '@/hooks/useCrowdfund'
import { isAddress } from 'ethers'

interface ParticipantPanelProps {
  state: CrowdfundState
  crowdfund: ReturnType<typeof useCrowdfund>
}

export function ParticipantPanel({ state, crowdfund }: ParticipantPanelProps) {
  const [inviteInput, setInviteInput] = useState('')
  const [commitInput, setCommitInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const participant = state.currentParticipant
  const phase = state.phase

  const isWhitelisted = participant?.isWhitelisted ?? false
  const hop = state.currentHop
  const committed = participant?.committed ?? 0n

  // Use effectiveCap from contract (handles invite stacking correctly)
  const hopData = state.userHops.find((h) => h.hop === hop)
  const cap = hopData?.effectiveCap ?? 0n
  const remaining = cap - committed

  // Aggregate committed across all hops (for refund display)
  const totalUserCommitted = state.userHops.reduce(
    (sum, h) => sum + h.participant.committed,
    0n,
  )

  // Check if ARM or refund has been claimed (claim/claimRefund are independent)
  const anyArmClaimed = state.userHops.some((h) => h.participant.armClaimed)
  const anyRefundClaimed = state.userHops.some((h) => h.participant.refundClaimed)

  // Use chain block timestamp (not Date.now()) — EVM time diverges from wall clock in local mode
  const now = state.blockTimestamp || Math.floor(Date.now() / 1000)

  // Both invites and commits are permitted while the active window is open
  const inActiveWindow =
    phase === Phase.Active &&
    Number(state.windowStart) > 0 &&
    now <= Number(state.windowEnd)

  const handleInvite = async () => {
    if (!isAddress(inviteInput)) return
    setIsSubmitting(true)
    await crowdfund.invite(inviteInput, hop)
    setIsSubmitting(false)
    setInviteInput('')
  }

  const handleCommit = async () => {
    const amount = parseUsdcInput(commitInput)
    if (amount <= 0n) return
    setIsSubmitting(true)
    await crowdfund.approveAndCommit(amount, hop)
    setIsSubmitting(false)
    setCommitInput('')
  }

  const handleMaxCommit = () => {
    const maxAmount = remaining < state.usdcBalance ? remaining : state.usdcBalance
    setCommitInput((Number(maxAmount) / 1e6).toString())
  }

  const handleClaim = async () => {
    setIsSubmitting(true)
    await crowdfund.claim()
    setIsSubmitting(false)
  }

  const handleRefund = async () => {
    setIsSubmitting(true)
    await crowdfund.refund()
    setIsSubmitting(false)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Participant</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Hop Selector — only shown when whitelisted at multiple hops */}
        {state.userHops.length > 1 && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Active Hop</Label>
            <div className="flex gap-1">
              {state.userHops.map((h) => (
                <Button
                  key={h.hop}
                  variant={h.hop === hop ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => crowdfund.setSelectedHop(h.hop)}
                  className="text-xs"
                >
                  {hopLabel(h.hop)}
                  {h.participant.committed > 0n && (
                    <span className="ml-1 opacity-70">
                      ({formatUsdc(h.participant.committed)})
                    </span>
                  )}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* My Status */}
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-muted-foreground">Status</div>
          <div>
            {isWhitelisted ? (
              <Badge variant="outline" className="border-success text-success">
                {hopLabel(hop)}
              </Badge>
            ) : (
              <span className="text-muted-foreground">Not whitelisted</span>
            )}
          </div>
          {isWhitelisted && (
            <>
              <div className="text-muted-foreground">Committed</div>
              <div className="font-medium">{formatUsdc(committed)}</div>
              <div className="text-muted-foreground">Cap Remaining</div>
              <div>{formatUsdc(remaining)}</div>
              <div className="text-muted-foreground">Invites Left</div>
              <div>{state.currentInvitesRemaining}</div>
              {state.userHops.length > 1 && (
                <>
                  <div className="text-muted-foreground">Total (all hops)</div>
                  <div className="font-medium">{formatUsdc(totalUserCommitted)}</div>
                </>
              )}
            </>
          )}
        </div>

        {/* Invite Section */}
        {isWhitelisted && inActiveWindow && state.currentInvitesRemaining > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <UserPlus className="h-3.5 w-3.5" />
                Invite to Hop-{hop + 1}
              </Label>
              <div className="flex gap-2">
                <Input
                  placeholder="0x..."
                  value={inviteInput}
                  onChange={(e) => setInviteInput(e.target.value)}
                  className="font-mono text-xs"
                />
                <Button
                  onClick={handleInvite}
                  disabled={isSubmitting || !isAddress(inviteInput)}
                  size="sm"
                >
                  Invite
                </Button>
              </div>
            </div>
          </>
        )}

        {/* Commit Section */}
        {isWhitelisted && inActiveWindow && remaining > 0n && (
          <>
            <Separator />
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5" />
                Commit USDC
              </Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type="number"
                    placeholder="Amount (USDC)"
                    value={commitInput}
                    onChange={(e) => setCommitInput(e.target.value)}
                    min="0"
                    step="0.01"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-6 text-xs"
                    onClick={handleMaxCommit}
                  >
                    Max
                  </Button>
                </div>
                <Button
                  onClick={handleCommit}
                  disabled={isSubmitting || parseUsdcInput(commitInput) <= 0n}
                  size="sm"
                >
                  Commit
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Balance: {formatUsdc(state.usdcBalance)} | Allowance: {formatUsdc(state.usdcAllowance)}
              </p>
            </div>
          </>
        )}

        {/* Claim Section (Finalized, normal — not refundMode) */}
        {phase === Phase.Finalized && !state.refundMode && totalUserCommitted > 0n && (
          <>
            <Separator />
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Gift className="h-3.5 w-3.5" />
                Claim Allocation
              </Label>
              {/* Per-hop breakdown (only if multiple hops have allocations) */}
              {state.userHopAllocations.length > 1 && (
                <div className="text-xs space-y-1 bg-muted/30 rounded-md p-2">
                  {state.userHopAllocations.map((a) => (
                    <div key={a.hop} className="flex justify-between">
                      <span className="text-muted-foreground">{hopLabel(a.hop)}:</span>
                      <span>{formatArm(a.allocation)} ARM / {formatUsdc(a.refund)} refund</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Aggregate totals */}
              {state.currentAllocation && (
                <div className="grid grid-cols-2 gap-1 text-sm bg-muted/50 rounded-md p-2">
                  <span className="text-muted-foreground">ARM tokens:</span>
                  <span className="font-medium">{formatArm(state.currentAllocation.allocation)}</span>
                  <span className="text-muted-foreground">USDC refund:</span>
                  <span className="font-medium">{formatUsdc(state.currentAllocation.refund)}</span>
                </div>
              )}
              <Button
                onClick={handleClaim}
                disabled={isSubmitting || anyArmClaimed}
                className="w-full"
              >
                {anyArmClaimed ? 'Already Claimed' : 'Claim ARM'}
              </Button>
              {/* Claim deadline */}
              {state.claimDeadline > 0n && !anyArmClaimed && (
                <p className="text-xs text-muted-foreground">
                  Claim by: {new Date(Number(state.claimDeadline) * 1000).toLocaleDateString()}
                </p>
              )}
            </div>
          </>
        )}

        {/* Refund Section (Finalized + refundMode) */}
        {phase === Phase.Finalized && state.refundMode && totalUserCommitted > 0n && (
          <>
            <Separator />
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Undo2 className="h-3.5 w-3.5" />
                Refund (Sale Below Minimum)
              </Label>
              <p className="text-sm">
                Sale did not reach minimum. Full refund available:{' '}
                <span className="font-medium">{formatUsdc(totalUserCommitted)}</span>
              </p>
              <Button
                onClick={handleRefund}
                disabled={isSubmitting || anyRefundClaimed}
                className="w-full"
                variant="destructive"
              >
                {anyRefundClaimed ? 'Already Refunded' : 'Claim Refund'}
              </Button>
            </div>
          </>
        )}

        {/* Refund Section (Canceled) */}
        {phase === Phase.Canceled && totalUserCommitted > 0n && (
          <>
            <Separator />
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Undo2 className="h-3.5 w-3.5" />
                Refund
              </Label>
              <p className="text-sm">Full refund: <span className="font-medium">{formatUsdc(totalUserCommitted)}</span></p>
              <Button
                onClick={handleRefund}
                disabled={isSubmitting || anyRefundClaimed}
                className="w-full"
                variant="destructive"
              >
                {anyRefundClaimed ? 'Already Refunded' : 'Claim Refund'}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
