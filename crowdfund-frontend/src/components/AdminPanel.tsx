// ABOUTME: Admin control panel for managing crowdfund lifecycle.
// ABOUTME: Phase-conditional actions: add seeds, start window, finalize, withdraw.
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { ShieldCheck, ShieldAlert, Flag, Coins, Zap, Users } from 'lucide-react'
import { Phase } from '@/types/crowdfund'
import type { CrowdfundState } from '@/atoms/crowdfund'
import type { useCrowdfund } from '@/hooks/useCrowdfund'
import { ANVIL_ACCOUNTS } from '@/config/accounts'
import { isLocalMode } from '@/config/network'
import { isAddress, JsonRpcProvider, Contract } from 'ethers'
import { ERC20_ABI } from '@/config/abi'
import { getHubRpcUrl } from '@/config/network'
import { formatUsdc, formatArm } from '@/utils/format'

interface AdminPanelProps {
  state: CrowdfundState
  crowdfund: ReturnType<typeof useCrowdfund>
  currentAddress: string | null
}

export function AdminPanel({ state, crowdfund, currentAddress }: AdminPanelProps) {
  const [seedInput, setSeedInput] = useState('')
  const [treasuryInput, setTreasuryInput] = useState('')
  const [ltInviteAddr, setLtInviteAddr] = useState('')
  const [ltInviteHop, setLtInviteHop] = useState<0 | 1>(0)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const isAdmin = currentAddress && state.adminAddress
    ? currentAddress.toLowerCase() === state.adminAddress.toLowerCase()
    : false
  const isLaunchTeam = currentAddress && state.launchTeamAddress
    ? currentAddress.toLowerCase() === state.launchTeamAddress.toLowerCase()
    : false

  // Pre-fill treasury address from deployment manifest (falls back to admin address)
  useEffect(() => {
    if (treasuryInput) return
    const treasuryAddr = crowdfund.deployment?.contracts.treasury
    if (treasuryAddr) {
      setTreasuryInput(treasuryAddr)
    } else if (state.adminAddress) {
      setTreasuryInput(state.adminAddress)
    }
  }, [crowdfund.deployment, state.adminAddress]) // eslint-disable-line react-hooks/exhaustive-deps
  const [treasuryUsdc, setTreasuryUsdc] = useState<bigint | null>(null)
  const [treasuryArm, setTreasuryArm] = useState<bigint | null>(null)

  const phase = state.phase
  const deployment = crowdfund.deployment

  // Fetch treasury balances when address is valid and sale is finalized
  useEffect(() => {
    if (!deployment || phase !== Phase.Finalized || !isAddress(treasuryInput)) {
      setTreasuryUsdc(null)
      setTreasuryArm(null)
      return
    }

    let cancelled = false
    const fetchBalances = async () => {
      try {
        const rpc = new JsonRpcProvider(getHubRpcUrl())
        const usdc = new Contract(deployment.contracts.usdc, ERC20_ABI, rpc)
        const arm = new Contract(deployment.contracts.armToken, ERC20_ABI, rpc)
        const [usdcBal, armBal] = await Promise.all([
          usdc.balanceOf(treasuryInput),
          arm.balanceOf(treasuryInput),
        ])
        if (!cancelled) {
          setTreasuryUsdc(BigInt(usdcBal))
          setTreasuryArm(BigInt(armBal))
        }
      } catch {
        if (!cancelled) {
          setTreasuryUsdc(null)
          setTreasuryArm(null)
        }
      }
    }

    fetchBalances()
    // Re-fetch after state updates (e.g. after withdrawals)
    return () => { cancelled = true }
  }, [deployment, phase, treasuryInput, state.lastUpdated])

  const handleAddSeeds = async () => {
    const addresses = seedInput
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    const invalid = addresses.filter((a) => !isAddress(a))
    if (invalid.length > 0) {
      return // Could show error, but the toast from the hook will handle it
    }

    setIsSubmitting(true)
    await crowdfund.addSeeds(addresses)
    setIsSubmitting(false)
    setSeedInput('')
  }

  const handleLoadArm = async () => {
    setIsSubmitting(true)
    await crowdfund.loadArm()
    setIsSubmitting(false)
  }

  const handleFinalize = async () => {
    setIsSubmitting(true)
    await crowdfund.finalize()
    setIsSubmitting(false)
  }

  const handleCancelSale = async () => {
    setIsSubmitting(true)
    await crowdfund.cancelSale()
    setIsSubmitting(false)
  }

  const handleWithdrawArm = async () => {
    setIsSubmitting(true)
    await crowdfund.withdrawUnallocatedArm()
    setIsSubmitting(false)
  }

  const handleLaunchTeamInvite = async () => {
    if (!isAddress(ltInviteAddr)) return
    setIsSubmitting(true)
    await crowdfund.launchTeamInvite(ltInviteAddr, ltInviteHop)
    setIsSubmitting(false)
    setLtInviteAddr('')
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          Admin Panel
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Active Phase: Add Seeds + ARM Pre-Load (admin only, before window opens) */}
        {phase === Phase.Active && isAdmin && Number(state.windowStart) > 0 && state.blockTimestamp < Number(state.windowStart) && (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Add Seed Addresses</Label>
                {isLocalMode() && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs gap-1"
                    onClick={() => {
                      const seedAddrs = ANVIL_ACCOUNTS
                        .filter((a) => a.role === 'seed')
                        .map((a) => a.address)
                        .join('\n')
                      setSeedInput(seedAddrs)
                    }}
                  >
                    <Zap className="h-3 w-3" />
                    Fill Anvil Seeds
                  </Button>
                )}
              </div>
              <Textarea
                placeholder="Enter addresses, one per line or comma-separated"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                rows={4}
                className="font-mono text-xs"
              />
              <Button
                onClick={handleAddSeeds}
                disabled={isSubmitting || seedInput.trim().length === 0}
                size="sm"
                className="w-full"
              >
                Add Seeds
              </Button>
            </div>

            <Separator />

            {/* ARM Pre-Load Status */}
            <div className="space-y-2">
              <div className="rounded-md px-3 py-2 text-sm flex items-center justify-between"
                style={{ backgroundColor: state.armLoaded ? 'var(--color-green-50)' : 'var(--color-amber-50)' }}
              >
                <span className={state.armLoaded ? 'text-green-700' : 'text-amber-700'}>
                  {state.armLoaded ? 'ARM loaded (1.8M verified)' : 'ARM not loaded'}
                </span>
                {!state.armLoaded && (
                  <Button
                    onClick={handleLoadArm}
                    disabled={isSubmitting}
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                  >
                    Verify ARM
                  </Button>
                )}
              </div>
            </div>

            <Separator />

            <Button
              onClick={handleCancelSale}
              disabled={isSubmitting}
              size="sm"
              variant="destructive"
              className="w-full gap-2"
            >
              <ShieldAlert className="h-4 w-4" />
              Cancel Sale (Security Council)
            </Button>
          </>
        )}

        {/* Active Phase: Launch Team Invites */}
        {phase === Phase.Active && isLaunchTeam && (() => {
          const budget = state.launchTeamBudget
          const inviteWindowOpen = state.blockTimestamp > 0 && state.blockTimestamp < Number(state.launchTeamInviteEnd)
          const selectedBudget = ltInviteHop === 0 ? budget?.hop1Remaining : budget?.hop2Remaining
          return (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Users className="h-4 w-4" />
                Launch Team Invites
              </div>

              {/* Budget display */}
              {budget && (
                <div className="rounded-md bg-muted/50 px-3 py-2 text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Hop-1 budget:</span>
                    <span className="font-medium">{budget.hop1Remaining}/60 remaining</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Hop-2 budget:</span>
                    <span className="font-medium">{budget.hop2Remaining}/60 remaining</span>
                  </div>
                </div>
              )}

              {/* Deadline indicator */}
              {inviteWindowOpen ? (
                <p className="text-xs text-muted-foreground">
                  Invite window closes at block time {new Date(Number(state.launchTeamInviteEnd) * 1000).toLocaleString()}
                </p>
              ) : (
                <div className="rounded-md px-3 py-2 text-sm text-amber-700"
                  style={{ backgroundColor: 'var(--color-amber-50)' }}
                >
                  Launch team invite window has closed
                </div>
              )}

              {/* Invite form (only when window is open) */}
              {inviteWindowOpen && (
                <>
                  <div className="space-y-2">
                    <Label>Invitee Address</Label>
                    <Input
                      placeholder="0x..."
                      value={ltInviteAddr}
                      onChange={(e) => setLtInviteAddr(e.target.value)}
                      className="font-mono text-xs"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Hop</Label>
                    <div className="flex gap-2">
                      <Button
                        variant={ltInviteHop === 0 ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setLtInviteHop(0)}
                        className="flex-1"
                      >
                        Hop 1 ({budget?.hop1Remaining ?? '?'} left)
                      </Button>
                      <Button
                        variant={ltInviteHop === 1 ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setLtInviteHop(1)}
                        className="flex-1"
                      >
                        Hop 2 ({budget?.hop2Remaining ?? '?'} left)
                      </Button>
                    </div>
                  </div>

                  <Button
                    onClick={handleLaunchTeamInvite}
                    disabled={isSubmitting || !isAddress(ltInviteAddr) || (selectedBudget ?? 0) === 0}
                    size="sm"
                    className="w-full"
                  >
                    Send Invite
                  </Button>
                </>
              )}

              <Separator />
            </div>
          )
        })()}

        {/* After window ends: Finalize (admin or anyone) */}
        {phase === Phase.Active && isAdmin && (
          <div className="space-y-2">
            <Button
              onClick={handleFinalize}
              disabled={isSubmitting}
              className="w-full gap-2"
              variant="default"
            >
              <Flag className="h-4 w-4" />
              Finalize Sale
            </Button>
            <p className="text-xs text-muted-foreground">
              Only works after the 3-week window has ended.
            </p>

            <Separator />

            <Button
              onClick={handleCancelSale}
              disabled={isSubmitting}
              size="sm"
              variant="destructive"
              className="w-full gap-2"
            >
              <ShieldAlert className="h-4 w-4" />
              Cancel Sale (Security Council)
            </Button>
          </div>
        )}

        {/* Finalized: Withdrawals (admin only) */}
        {phase === Phase.Finalized && isAdmin && (
          <>
            <div className="space-y-2">
              <Label>Treasury Address</Label>
              <Input
                placeholder="0x..."
                value={treasuryInput}
                onChange={(e) => setTreasuryInput(e.target.value)}
                className="font-mono text-xs"
              />
            </div>

            {treasuryUsdc !== null && treasuryArm !== null && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Treasury USDC:</span>
                  <span className="font-medium">{formatUsdc(treasuryUsdc)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Treasury ARM:</span>
                  <span className="font-medium">{formatArm(treasuryArm)}</span>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleWithdrawArm}
                disabled={isSubmitting}
                size="sm"
                className="flex-1 gap-1.5"
              >
                <Coins className="h-3.5 w-3.5" />
                Sweep Unallocated ARM
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Proceeds are pushed to treasury at finalization.
            </p>
          </>
        )}

        {/* Canceled: Info only */}
        {phase === Phase.Canceled && (
          <p className="text-sm text-muted-foreground">
            Sale was canceled. Participants can claim refunds.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
