// ABOUTME: Admin control panel for managing crowdfund lifecycle.
// ABOUTME: Phase-conditional actions: add seeds, start sale, finalize, withdraw.
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { ShieldCheck, Play, Flag, Banknote, Coins, Zap } from 'lucide-react'
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
}

export function AdminPanel({ state, crowdfund }: AdminPanelProps) {
  const [seedInput, setSeedInput] = useState('')
  const [treasuryInput, setTreasuryInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

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

  const handleStartSale = async () => {
    setIsSubmitting(true)
    await crowdfund.startSale()
    setIsSubmitting(false)
  }

  const handleFinalize = async () => {
    setIsSubmitting(true)
    await crowdfund.finalize()
    setIsSubmitting(false)
  }

  const handleWithdrawProceeds = async () => {
    setIsSubmitting(true)
    await crowdfund.withdrawProceeds()
    setIsSubmitting(false)
  }

  const handleWithdrawArm = async () => {
    setIsSubmitting(true)
    await crowdfund.withdrawUnallocatedArm()
    setIsSubmitting(false)
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
        {/* Setup Phase: Add Seeds */}
        {phase === Phase.Setup && (
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

            <Button
              onClick={handleStartSale}
              disabled={isSubmitting || !state.hopStats || state.hopStats[0].whitelistCount === 0}
              className="w-full gap-2"
            >
              <Play className="h-4 w-4" />
              Start Sale
            </Button>
            {state.hopStats && state.hopStats[0].whitelistCount === 0 && (
              <p className="text-xs text-muted-foreground">Add at least one seed first</p>
            )}
          </>
        )}

        {/* After sale window: Finalize */}
        {phase === Phase.Active && (
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
              Only works after the sale window has ended.
            </p>
          </div>
        )}

        {/* Finalized: Withdrawals */}
        {phase === Phase.Finalized && (
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
                onClick={handleWithdrawProceeds}
                disabled={isSubmitting}
                size="sm"
                className="flex-1 gap-1.5"
              >
                <Banknote className="h-3.5 w-3.5" />
                Withdraw Proceeds
              </Button>
              <Button
                onClick={handleWithdrawArm}
                disabled={isSubmitting}
                size="sm"
                variant="outline"
                className="flex-1 gap-1.5"
              >
                <Coins className="h-3.5 w-3.5" />
                Withdraw ARM
              </Button>
            </div>
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
