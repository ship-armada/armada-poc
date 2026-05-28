// ABOUTME: v2 Participate flow page-level controller — wires the designer's Step1–Step5 screens to the committer's eligibility/balance/tx hooks.
// ABOUTME: Single-hop only (multi-hop deferred); invite-link generation deferred. Uses real approve + commit transactions through the controlled Step4Approve.

import { useEffect, useMemo, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Contract, type Signer, type TransactionResponse } from 'ethers'
import {
  Step1Wallet,
  Step1WalletNotWhitelisted,
  Step2Commit,
  Step3Review,
  Step4Approve,
  Step5Confirmation,
  type Step4Transaction,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  formatUsdc,
  formatUsdcPlain,
  estimateUserArmAllocation,
  type UserHopPosition,
  type HopStatsData,
} from '@armada/crowdfund-shared'
import { mapRevertToMessage } from '@/lib/revertMessages'
import type { HopPosition } from '@/hooks/useEligibility'

type FlowStep = 'wallet' | 'commit' | 'review' | 'approve' | 'confirmation'

export interface ParticipateFlowV2Props {
  walletConnected: boolean
  walletAddress: string | null
  signer: Signer | null
  positions: HopPosition[]
  balance: bigint
  needsApproval: (amount: bigint) => boolean
  refreshAllowance: () => Promise<void>
  crowdfundAddress: string | null
  usdcAddress: string | null
  hopStats: HopStatsData[]
  saleSize: bigint
  cappedDemand: bigint
  windowOpen: boolean
  onGoToMyPosition: () => void
  onGoToNetwork: () => void
}

// Convert a bigint USDC amount (6 decimals) into a plain number for the
// designer's step components (which take amounts as numbers). Loses precision
// past 2 decimals — acceptable for display + range checks, not for tx params.
function usdcToNumber(amount: bigint): number {
  return Number(formatUsdcPlain(amount))
}

// Convert a number USD amount back into a bigint USDC (6 decimals) for tx params.
function numberToUsdc(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000))
}

// Convert a bigint ARM amount (18 decimals) into a plain number for display.
// ARM uses standard ERC20 18-decimal precision, distinct from USDC's 6.
function armToNumber(amount: bigint): number {
  // Split into integer + fractional to avoid precision loss past Number.MAX_SAFE_INTEGER.
  const whole = amount / 10n ** 18n
  const frac = amount % 10n ** 18n
  return Number(whole) + Number(frac) / 1e18
}

export function ParticipateFlowV2({
  walletConnected,
  walletAddress,
  signer,
  positions,
  balance,
  needsApproval,
  refreshAllowance,
  crowdfundAddress,
  usdcAddress,
  hopStats,
  saleSize,
  cappedDemand,
  windowOpen,
  onGoToMyPosition,
  onGoToNetwork,
}: ParticipateFlowV2Props) {
  const [step, setStep] = useState<FlowStep>('wallet')
  const [amount, setAmount] = useState<number>(0)
  const [txs, setTxs] = useState<Step4Transaction[] | null>(null)

  // TODO: multi-hop UX. Designer's Step2Commit ships with a single amount input;
  // when a user is eligible at multiple hops we silently pick the lowest hop
  // (best allocation). Until the designer specs a multi-hop flow, this matches
  // the most common case (one hop per user) but loses information for the rare
  // multi-hop participant.
  const activePosition = positions[0] ?? null
  const eligible = activePosition !== null

  // Snapshot of committed USDC at the moment the user entered the flow, in
  // plain dollars. Step2 uses this to render the existing-commitment fill on
  // the progress bar (without it the bar resets every visit); Step5 uses it
  // to decide between first-time and "Commitment updated" copy.
  const initialCommittedUsd = useMemo(() => {
    if (!activePosition) return 0
    return usdcToNumber(activePosition.committed)
    // Capture once when the controller mounts. The position can refresh from
    // chain events during the flow — we deliberately don't react to that, so
    // the "you had this much before" baseline stays stable across the steps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const isAdditionalCommit = initialCommittedUsd > 0

  // Auto-advance past the wallet step when the user lands here with a wallet
  // already connected (most common path — they came from the header
  // Participate CTA on the Hero page). When they disconnect, fall back.
  useEffect(() => {
    if (walletConnected && step === 'wallet') setStep('commit')
    if (!walletConnected && step !== 'wallet') setStep('wallet')
  }, [walletConnected, step])

  // Pro-rata estimate of ARM allocation at the proposed commit amount. Uses
  // shared `estimateUserArmAllocation` so the math stays in lockstep with the
  // observer's pro-rata banner.
  const estimatedArm = useMemo(() => {
    if (!activePosition || amount <= 0) return 0
    const committed = numberToUsdc(amount)
    const projectedPositions: UserHopPosition[] = [
      {
        hop: activePosition.hop,
        committed: activePosition.committed + committed,
        effectiveCap: activePosition.effectiveCap,
      },
    ]
    const armAllocation = estimateUserArmAllocation(
      projectedPositions,
      hopStats,
      cappedDemand + committed,
      saleSize,
    )
    // `estimateUserArmAllocation` returns ARM in 18-decimal units (ERC20
    // standard), not 6-decimal USDC units. Divide by 10^18, not 10^6.
    return armToNumber(armAllocation)
  }, [activePosition, amount, hopStats, cappedDemand, saleSize])

  // Run the real approve + commit pipeline. Updates `txs` so Step4Approve renders
  // controlled status. On full success, advance to Step 5. On error, the user
  // sees the error inline on Step 4 with a Back-to-Review affordance (handled
  // via the Step4 footer copy + an external back arrow we'll add via the
  // shared step shell in 3.2.x).
  const runPipeline = async () => {
    if (!signer || !crowdfundAddress || !usdcAddress || !activePosition || amount <= 0) {
      return
    }
    const amountBig = numberToUsdc(amount)
    const approveLabel = `Approve ${formatUsdc(amountBig)} USDC`
    const commitLabel = 'Commit participation'

    const skipApproval = !needsApproval(amountBig)
    const initial: Step4Transaction[] = skipApproval
      ? [{ label: commitLabel, status: 'loading' }]
      : [
          { label: approveLabel, status: 'loading' },
          { label: commitLabel, status: 'pending' },
        ]
    setTxs(initial)

    const setRowStatus = (
      index: number,
      patch: Partial<Step4Transaction>,
    ) => {
      setTxs((prev) => {
        if (!prev) return prev
        const next = prev.slice()
        next[index] = { ...next[index], ...patch }
        return next
      })
    }

    const sendAndWait = async (
      index: number,
      label: string,
      send: () => Promise<TransactionResponse>,
    ): Promise<boolean> => {
      setRowStatus(index, { label, status: 'loading' })
      try {
        const tx = await send()
        const receipt = await tx.wait()
        if (!receipt || receipt.status === 0) {
          setRowStatus(index, { status: 'error', errorMessage: 'Transaction reverted' })
          return false
        }
        setRowStatus(index, { status: 'done' })
        return true
      } catch (err) {
        setRowStatus(index, { status: 'error', errorMessage: mapRevertToMessage(err) })
        return false
      }
    }

    let pipelineIndex = 0
    if (!skipApproval) {
      const usdc = new Contract(usdcAddress, ERC20_ABI_FRAGMENTS, signer)
      const ok = await sendAndWait(pipelineIndex, approveLabel, () =>
        usdc.approve(crowdfundAddress, amountBig),
      )
      if (!ok) return
      await refreshAllowance()
      pipelineIndex += 1
    }

    const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
    const ok = await sendAndWait(pipelineIndex, commitLabel, () =>
      crowdfund.commit(activePosition.hop, amountBig),
    )
    if (!ok) return

    // Hold the success state briefly so the checkmark animation reads, then advance.
    setTimeout(() => setStep('confirmation'), 600)
  }

  // ── Step renderers ───────────────────────────────────────────────

  if (step === 'wallet') {
    if (!walletConnected) {
      // Bridge the designer's wallet picker to RainbowKit. Any of the three
      // wallet rows opens RainbowKit's connect modal — the auto-advance effect
      // above transitions us to 'commit' as soon as wagmi reports a connected
      // address. RainbowKit handles the actual wallet-specific UX (Metamask /
      // WalletConnect / etc.) past this point.
      //
      // `compact` + `showSteps={false}` match the Path 2 modal sizing — the
      // step bar starts at Commit once we're inside the modal.
      return (
        <div className="flex min-h-screen items-center justify-center">
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <Step1Wallet
                compact
                showSteps={false}
                onNext={() => openConnectModal()}
              />
            )}
          </ConnectButton.Custom>
        </div>
      )
    }
    // Effect will flip us to 'commit' on the next tick.
    return null
  }

  if (!eligible) {
    // Connected but no eligible hop position — show the designer's
    // Step1WalletNotWhitelisted screen. The "allowlist" framing maps onto
    // our reality: a wallet is "on the allowlist" if it has at least one
    // hop position (i.e. it accepted an invite). The "Connect a different
    // wallet" CTA routes back to the network view so the user can disconnect
    // from the header pill and try another address.
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Step1WalletNotWhitelisted
          address={walletAddress ?? '0x0000000000000000000000000000000000000000'}
          onSelectAnother={onGoToNetwork}
        />
      </div>
    )
  }

  if (step === 'commit') {
    if (!windowOpen) {
      return (
        <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 text-center">
          <div className="text-2xl">Commit window isn't open</div>
          <div className="text-muted-foreground">
            New commits aren't accepted right now. Check back when the campaign opens.
          </div>
        </div>
      )
    }
    const effectiveCapUsd = usdcToNumber(activePosition.effectiveCap)
    const availableBalance = usdcToNumber(balance)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Step2Commit
          onNext={(amt) => {
            setAmount(amt)
            setStep('review')
          }}
          onBack={onGoToNetwork}
          maxAmount={effectiveCapUsd}
          availableBalance={availableBalance}
          maxArm={effectiveCapUsd}
          existingCommittedUsdc={initialCommittedUsd}
        />
      </div>
    )
  }

  if (step === 'review') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Step3Review
          onNext={() => {
            setTxs(null)
            setStep('approve')
            void runPipeline()
          }}
          onBack={() => setStep('commit')}
          hopLevel={`Hop ${activePosition.hop}`}
          amount={amount}
          estimatedArm={estimatedArm}
        />
      </div>
    )
  }

  if (step === 'approve') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Step4Approve
          amount={amount}
          txs={txs ?? undefined}
          onDone={() => setStep('confirmation')}
        />
      </div>
    )
  }

  // step === 'confirmation'
  // For returning participants (had a non-zero commit before this flow), the
  // designer's Step5 swaps in "Commitment updated" copy + a "View your
  // position" CTA alongside Invite. First-time commits stay on the original
  // "You're in." headline with just the Invite CTA. Total committed = the
  // pre-existing snapshot plus what they just added.
  const totalCommittedUsdc = initialCommittedUsd + amount
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Step5Confirmation
        onViewPosition={onGoToMyPosition}
        onInvite={() => {
          // TODO (3.2.x): wire to a dedicated invite-slots flow. For now,
          // bounce back to the crowdfund — the user can find their slots in
          // the My Position view.
          onGoToMyPosition()
        }}
        amount={amount}
        estimatedArm={estimatedArm}
        isAdditionalCommit={isAdditionalCommit}
        totalCommittedUsdc={totalCommittedUsdc}
      />
    </div>
  )
}
