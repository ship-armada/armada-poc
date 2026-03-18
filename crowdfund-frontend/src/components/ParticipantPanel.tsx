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
import { Phase, CROWDFUND_CONSTANTS } from '@/types/crowdfund'
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
  const invitesReceived = BigInt(participant?.invitesReceived ?? 1)
  const cap = invitesReceived * (CROWDFUND_CONSTANTS.HOP_CAPS[hop] ?? CROWDFUND_CONSTANTS.HOP_CAPS[0])
  const remaining = cap - committed

  // Use chain block timestamp (not Date.now()) — EVM time diverges from wall clock in local mode
  const now = state.blockTimestamp || Math.floor(Date.now() / 1000)
  const inCommitmentWindow =
    Number(state.commitmentStart) > 0 &&
    now >= Number(state.commitmentStart) &&
    now <= Number(state.commitmentEnd)

  const inInvitationWindow =
    phase === Phase.Invitation &&
    Number(state.invitationEnd) > 0 &&
    now <= Number(state.invitationEnd)

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
            </>
          )}
        </div>

        {/* Invite Section */}
        {isWhitelisted && inInvitationWindow && state.currentInvitesRemaining > 0 && (
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
        {isWhitelisted && inCommitmentWindow && remaining > 0n && (
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

        {/* Claim Section (Finalized) */}
        {phase === Phase.Finalized && committed > 0n && (
          <>
            <Separator />
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Gift className="h-3.5 w-3.5" />
                Claim Allocation
              </Label>
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
                disabled={isSubmitting || state.currentAllocation?.claimed === true}
                className="w-full"
              >
                {state.currentAllocation?.claimed ? 'Already Claimed' : 'Claim'}
              </Button>
            </div>
          </>
        )}

        {/* Refund Section (Canceled) */}
        {phase === Phase.Canceled && committed > 0n && (
          <>
            <Separator />
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Undo2 className="h-3.5 w-3.5" />
                Refund
              </Label>
              <p className="text-sm">Full refund: <span className="font-medium">{formatUsdc(committed)}</span></p>
              <Button
                onClick={handleRefund}
                disabled={isSubmitting || participant?.claimed === true}
                className="w-full"
                variant="destructive"
              >
                {participant?.claimed ? 'Already Refunded' : 'Claim Refund'}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
