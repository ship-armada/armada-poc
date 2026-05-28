// ABOUTME: Path 1 invite-link flow controller — runs the designer's Step1Wallet → Step2Commit → Step3Review → Step4Approve → Step5Confirmation step machine inline within the /invite landing page, wired to real approve + commitWithInvite transactions.
// ABOUTME: Self-contained: pulls wagmi wallet state, deployment, provider, balance, allowance internally so the landing page can mount it with just `inviteData`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { JsonRpcProvider, Contract, type TransactionResponse } from 'ethers'
import { useAccount, useWalletClient } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import {
  Step1Wallet,
  Step2Commit,
  Step3Review,
  Step4Approve,
  Step5Confirmation,
  INVITE_LINK_STEPS,
  type Step4Transaction,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  formatUsdc,
  formatUsdcPlain,
  hopLabel,
  HOP_CONFIGS,
} from '@armada/crowdfund-shared'
// CSS modules are co-located rather than imported from `@armada/crowdfund-shared`
// because that package's `exports` field doesn't expose internal sub-paths.
// These files are byte-identical to the ones in shared (ported from the
// designer's mockup); promote to shared with a proper subpath export the day
// another consumer needs them.
import inlineStyles from './InviteLinkFlowInline.module.css'
import stepStyles from './InviteLinkFlowStepTransition.module.css'
import { walletClientToSigner } from '@/lib/wagmiAdapter'
import { mapRevertToMessage } from '@/lib/revertMessages'
import { getHubRpcUrl } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import type { InviteLinkData } from '@/lib/inviteLinks'

type FlowStep = 'wallet' | 'commit' | 'review' | 'approve' | 'confirmation'

const MODAL_STEPS = [...INVITE_LINK_STEPS]
const STEP_TRANSITION_MS = 240

export interface InviteLinkFlowControllerProps {
  inviteData: InviteLinkData
}

// Convert a bigint USDC amount (6 decimals) into a plain number for the
// designer's step components. Same helper as ParticipateFlowV2 — both flows
// thread USDC bigints into number-typed step props.
function usdcToNumber(amount: bigint): number {
  return Number(formatUsdcPlain(amount))
}

function numberToUsdc(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000))
}

export function InviteLinkFlowController({ inviteData }: InviteLinkFlowControllerProps) {
  const navigate = useNavigate()
  const { address: rawAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { openConnectModal } = useConnectModal()

  const walletConnected = Boolean(rawAddress)
  const signer = useMemo(() => {
    if (!walletClient) return null
    try { return walletClientToSigner(walletClient) } catch { return null }
  }, [walletClient])

  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)
  const [balance, setBalance] = useState<bigint>(0n)
  const [allowance, setAllowance] = useState<bigint>(0n)

  // Step machine + transition state (mirrors the designer's
  // ParticipateFlowInviteLink — fading wraps each step swap).
  const [step, setStep] = useState<FlowStep>(walletConnected ? 'commit' : 'wallet')
  const [renderStep, setRenderStep] = useState<FlowStep>(step)
  const [fading, setFading] = useState(false)
  const [amount, setAmount] = useState(0)
  const [txs, setTxs] = useState<Step4Transaction[] | null>(null)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const targetHop = inviteData.fromHop + 1
  const hopCap = targetHop <= 2 ? HOP_CONFIGS[targetHop as 0 | 1 | 2].capUsdc : 0n

  // Load deployment + JSON-RPC provider for balance/allowance + tx submission.
  useEffect(() => {
    loadDeployment()
      .then((d) => {
        setDeployment(d)
        setProvider(new JsonRpcProvider(getHubRpcUrl()))
      })
      .catch(() => {})
  }, [])

  // Refresh balance + allowance whenever the wallet, provider, or deployment
  // resolve. The committer's main `useAllowance` is keyed off App-level state
  // we don't import here; doing the read inline keeps this component
  // self-contained while preserving the same behavior as the legacy
  // InviteLinkRedemption page.
  useEffect(() => {
    if (!provider || !rawAddress || !deployment) return
    let cancelled = false
    const refresh = async () => {
      try {
        const usdc = new Contract(deployment.contracts.usdc, ERC20_ABI_FRAGMENTS, provider)
        const [bal, allow] = await Promise.all([
          usdc.balanceOf(rawAddress) as Promise<bigint>,
          usdc.allowance(rawAddress, deployment.contracts.crowdfund) as Promise<bigint>,
        ])
        if (cancelled) return
        setBalance(bal)
        setAllowance(allow)
      } catch {
        // Non-fatal — the tx itself will surface errors.
      }
    }
    refresh()
    return () => { cancelled = true }
  }, [provider, rawAddress, deployment])

  // Auto-advance past the wallet step once the user connects (matches the
  // ParticipateFlowV2 pattern). Going back to disconnected drops to wallet.
  useEffect(() => {
    if (walletConnected && step === 'wallet') transitionTo('commit')
    if (!walletConnected && step !== 'wallet') transitionTo('wallet')
    // `transitionTo` is stable across renders — see useCallback below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletConnected, step])

  const clearTransitionTimer = () => {
    if (transitionTimer.current) {
      clearTimeout(transitionTimer.current)
      transitionTimer.current = null
    }
  }

  const transitionTo = useCallback((next: FlowStep) => {
    clearTransitionTimer()
    setFading(true)
    transitionTimer.current = setTimeout(() => {
      setStep(next)
      setRenderStep(next)
      setFading(false)
      transitionTimer.current = null
    }, STEP_TRANSITION_MS)
  }, [])

  useEffect(() => () => clearTransitionTimer(), [])

  // Tx pipeline — runs `approve` (if needed) then `commitWithInvite`. Updates
  // `txs` so Step4Approve renders the controlled animation while the wallet
  // confirms each transaction. Mirrors the Path 2 pipeline in
  // ParticipateFlowV2 but with the inviter signature args on the commit call.
  const runPipeline = async () => {
    if (!signer || !deployment || amount <= 0) return
    const amountBig = numberToUsdc(amount)
    const approveLabel = `Approve ${formatUsdc(amountBig)} USDC`
    const commitLabel = `Join & commit ${formatUsdc(amountBig)} at ${hopLabel(targetHop)}`

    const skipApproval = amountBig <= allowance
    const initial: Step4Transaction[] = skipApproval
      ? [{ label: commitLabel, status: 'loading' }]
      : [
          { label: approveLabel, status: 'loading' },
          { label: commitLabel, status: 'pending' },
        ]
    setTxs(initial)

    const setRowStatus = (index: number, patch: Partial<Step4Transaction>) => {
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

    let cursor = 0
    if (!skipApproval) {
      const ok = await sendAndWait(cursor, approveLabel, async () => {
        const usdc = new Contract(deployment.contracts.usdc, ERC20_ABI_FRAGMENTS, signer)
        return usdc.approve(deployment.contracts.crowdfund, amountBig)
      })
      if (!ok) return
      setAllowance(amountBig)
      cursor += 1
    }

    const commitOk = await sendAndWait(cursor, commitLabel, async () => {
      const crowdfund = new Contract(deployment.contracts.crowdfund, CROWDFUND_ABI_FRAGMENTS, signer)
      return crowdfund.commitWithInvite(
        inviteData.inviter,
        inviteData.fromHop,
        inviteData.nonce,
        inviteData.deadline,
        inviteData.signature,
        amountBig,
      )
    })
    if (!commitOk) return

    setTimeout(() => transitionTo('confirmation'), 600)
  }

  // ── Step renderers ─────────────────────────────────────────────────────

  const renderCurrentStep = () => {
    switch (renderStep) {
      case 'wallet':
        return (
          <Step1Wallet
            showSteps
            onNext={() => openConnectModal?.()}
          />
        )

      case 'commit': {
        const maxAmount = usdcToNumber(hopCap)
        const availableBalance = usdcToNumber(balance)
        return (
          <Step2Commit
            steps={MODAL_STEPS}
            stepIndex={2}
            onNext={(nextAmount) => {
              setAmount(nextAmount)
              transitionTo('review')
            }}
            onBack={() => transitionTo('wallet')}
            maxAmount={maxAmount}
            availableBalance={availableBalance}
            maxArm={maxAmount}
          />
        )
      }

      case 'review': {
        const estimatedArm = Math.round(amount)
        return (
          <Step3Review
            steps={MODAL_STEPS}
            stepIndex={3}
            hopLevel={hopLabel(targetHop)}
            amount={amount}
            estimatedArm={estimatedArm}
            onBack={() => transitionTo('commit')}
            onNext={() => {
              setTxs(null)
              transitionTo('approve')
              void runPipeline()
            }}
          />
        )
      }

      case 'approve':
        return (
          <Step4Approve
            steps={MODAL_STEPS}
            stepIndex={4}
            amount={amount}
            txs={txs ?? undefined}
            onDone={() => transitionTo('confirmation')}
          />
        )

      case 'confirmation': {
        const estimatedArm = Math.round(amount)
        return (
          <Step5Confirmation
            steps={MODAL_STEPS}
            stepIndex={4}
            stepsStatus="confirmed"
            amount={amount}
            estimatedArm={estimatedArm}
            showViewPositionButton
            onViewPosition={() => navigate('/?view=myposition')}
            onInvite={() => navigate('/?view=myposition')}
          />
        )
      }

      default:
        return null
    }
  }

  return (
    <div className={inlineStyles.slot}>
      <div className={inlineStyles.step}>
        <div
          key={renderStep}
          className={[
            stepStyles.frame,
            fading ? stepStyles.frameExit : stepStyles.frameEnter,
          ].join(' ')}
        >
          {renderCurrentStep()}
        </div>
      </div>
    </div>
  )
}
