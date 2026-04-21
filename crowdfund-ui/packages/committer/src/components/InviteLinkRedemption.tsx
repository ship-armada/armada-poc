// ABOUTME: Standalone invite link redemption page — parses URL params, validates, and commits.
// ABOUTME: Handles wallet connection, USDC approval, and commitWithInvite() atomically.

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { JsonRpcProvider, Contract } from 'ethers'
import { useAccount, useWalletClient } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { walletClientToSigner } from '@/lib/wagmiAdapter'
import {
  Button,
  ErrorAlert,
  InfoTooltip,
  Input,
  Label,
  TOOLTIPS,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  formatUsdc,
  parseUsdcInput,
  hopLabel,
  formatCountdown,
  CROWDFUND_CONSTANTS,
  HOP_CONFIGS,
} from '@armada/crowdfund-shared'
import { decodeInviteUrl } from '@/lib/inviteLinks'
import { getHubRpcUrl, getExplorerUrl } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'

/** Pre-submission validation error types */
type PreCheckError =
  | 'expired'
  | 'nonce_consumed'
  | 'nonce_revoked'
  | 'no_slots'
  | 'deadline_passed'
  | null

const PRE_CHECK_MESSAGES: Record<string, string> = {
  expired: 'This invite link has expired. Ask the inviter for a new link.',
  nonce_consumed: 'This invite link has already been used by someone else.',
  nonce_revoked: 'This invite link has been revoked by the inviter.',
  no_slots: 'The inviter has no remaining invite slots.',
  deadline_passed: 'The commitment deadline has passed.',
}

export function InviteLinkRedemption() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const { address: rawAddress, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { openConnectModal } = useConnectModal()

  const address = rawAddress?.toLowerCase() ?? null
  const signer = useMemo(() => {
    if (!walletClient) return null
    try { return walletClientToSigner(walletClient) } catch { return null }
  }, [walletClient])

  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)
  const [blockTimestamp, setBlockTimestamp] = useState(0)
  const [amountInput, setAmountInput] = useState('')
  const [balance, setBalance] = useState<bigint>(0n)
  const [allowance, setAllowance] = useState<bigint>(0n)
  const [preCheckError, setPreCheckError] = useState<PreCheckError>(null)
  const [preCheckLoading, setPreCheckLoading] = useState(false)

  const approvalTx = useTransactionFlow(signer, { explorerUrl: getExplorerUrl() })
  const commitTx = useTransactionFlow(signer, { explorerUrl: getExplorerUrl() })

  // Parse invite data from URL
  const inviteData = useMemo(() => decodeInviteUrl(searchParams), [searchParams])

  // Load deployment + provider
  useEffect(() => {
    loadDeployment()
      .then((d) => {
        setDeployment(d)
        setProvider(new JsonRpcProvider(getHubRpcUrl()))
      })
      .catch(() => {})
  }, [])

  // Fetch block timestamp
  useEffect(() => {
    if (!provider) return
    const refresh = async () => {
      const block = await provider.getBlock('latest')
      if (block) setBlockTimestamp(block.timestamp)
    }
    refresh()
    const id = setInterval(refresh, 10_000)
    return () => clearInterval(id)
  }, [provider])

  // Pre-redemption nonce validation — checks nonce consumed/revoked, slots, and deadline
  useEffect(() => {
    if (!provider || !deployment || !inviteData) return

    const checkNonce = async () => {
      setPreCheckLoading(true)
      try {
        const contract = new Contract(deployment.contracts.crowdfund, CROWDFUND_ABI_FRAGMENTS, provider)

        // Check nonce status first — if used, link is dead
        const nonceUsed = await contract.usedNonces(inviteData.inviter, inviteData.nonce) as boolean
        if (nonceUsed) {
          // Distinguish consumed (used by someone) vs revoked (inviter cancelled)
          // Check InviteNonceRevoked events for this specific inviter+nonce
          const revokedFilter = contract.filters.InviteNonceRevoked(inviteData.inviter, inviteData.nonce)
          const revokedLogs = await contract.queryFilter(revokedFilter)
          setPreCheckError(revokedLogs.length > 0 ? 'nonce_revoked' : 'nonce_consumed')
          setPreCheckLoading(false)
          return
        }

        // Check inviter's remaining slots
        const remaining = await contract.getInvitesRemaining(
          inviteData.inviter,
          inviteData.fromHop,
        ) as number
        if (remaining === 0) {
          setPreCheckError('no_slots')
          setPreCheckLoading(false)
          return
        }

        // Check contract deadline
        const windowEnd = await contract.windowEnd() as bigint
        const block = await provider.getBlock('latest')
        if (block && BigInt(block.timestamp) > windowEnd) {
          setPreCheckError('deadline_passed')
          setPreCheckLoading(false)
          return
        }

        setPreCheckError(null)
      } catch {
        // Non-fatal — let the tx itself surface errors
        setPreCheckError(null)
      }
      setPreCheckLoading(false)
    }

    checkNonce()
  }, [provider, deployment, inviteData])

  // Fetch balance and allowance
  useEffect(() => {
    if (!provider || !address || !deployment) return
    const refresh = async () => {
      try {
        const usdc = new Contract(deployment.contracts.usdc, ERC20_ABI_FRAGMENTS, provider)
        const [bal, allow] = await Promise.all([
          usdc.balanceOf(address) as Promise<bigint>,
          usdc.allowance(address, deployment.contracts.crowdfund) as Promise<bigint>,
        ])
        setBalance(bal)
        setAllowance(allow)
      } catch {
        // Non-fatal
      }
    }
    refresh()
  }, [provider, address, deployment])

  const connect = useCallback(() => {
    openConnectModal?.()
  }, [openConnectModal])

  const parsedAmount = useMemo(() => parseUsdcInput(amountInput), [amountInput])
  const targetHop = inviteData ? inviteData.fromHop + 1 : 0
  const hopCap = targetHop <= 2 ? HOP_CONFIGS[targetHop as 0 | 1 | 2].capUsdc : 0n
  const expired = inviteData ? inviteData.deadline < blockTimestamp : true
  const needsApproval = parsedAmount > allowance

  const handleMax = useCallback(() => {
    if (hopCap === 0n) return
    const maxDisplay = Number(hopCap / (10n ** 6n))
    setAmountInput(String(maxDisplay))
  }, [hopCap])

  const errors = useMemo(() => {
    const errs: string[] = []
    if (parsedAmount > 0n && parsedAmount < CROWDFUND_CONSTANTS.MIN_COMMIT) {
      errs.push(`Minimum commitment is ${formatUsdc(CROWDFUND_CONSTANTS.MIN_COMMIT)}`)
    }
    if (parsedAmount > 0n && hopCap > 0n && parsedAmount > hopCap) {
      errs.push(`Exceeds ${hopLabel(targetHop)} cap of ${formatUsdc(hopCap)}`)
    }
    // Balance check is a warning, not a blocker
    return errs
  }, [parsedAmount, hopCap, targetHop])

  // Balance warning (non-blocking)
  const balanceInsufficient = parsedAmount > 0n && parsedAmount > balance

  const handleSubmit = useCallback(async () => {
    if (!inviteData || !deployment || parsedAmount === 0n) return

    // Step 1: Approve if needed
    if (needsApproval) {
      const success = await approvalTx.execute(
        `Approve ${formatUsdc(parsedAmount)} USDC`,
        async (s) => {
          const usdc = new Contract(deployment.contracts.usdc, ERC20_ABI_FRAGMENTS, s)
          return usdc.approve(deployment.contracts.crowdfund, parsedAmount)
        },
      )
      if (!success) return
      setAllowance(parsedAmount)
    }

    // Step 2: commitWithInvite
    const success = await commitTx.execute(
      `Join & commit ${formatUsdc(parsedAmount)} at ${hopLabel(targetHop)}`,
      async (s) => {
        const crowdfund = new Contract(deployment.contracts.crowdfund, CROWDFUND_ABI_FRAGMENTS, s)
        return crowdfund.commitWithInvite(
          inviteData.inviter,
          inviteData.fromHop,
          inviteData.nonce,
          inviteData.deadline,
          inviteData.signature,
          parsedAmount,
        )
      },
    )

    if (success) {
      setTimeout(() => navigate('/'), 2000)
    }
  }, [inviteData, deployment, parsedAmount, needsApproval, approvalTx, commitTx, navigate])

  // Invalid link
  if (!inviteData) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-center space-y-3">
          <h1 className="text-xl font-bold text-destructive">Invalid Invite Link</h1>
          <p className="text-sm text-muted-foreground">This link is missing required parameters.</p>
          <a href="/" className="text-sm text-primary hover:underline">Go to main app</a>
        </div>
      </div>
    )
  }

  const timeLeft = inviteData.deadline - blockTimestamp

  // Invite details — target hop config
  const targetConfig = targetHop < HOP_CONFIGS.length ? HOP_CONFIGS[targetHop as 0 | 1 | 2] : null

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 space-y-4">
        <h1 className="text-xl font-bold">Armada Crowdfund Invite</h1>

        {/* Invite details — target hop config */}
        <div className="rounded border border-border p-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">From</span>
            <span className="font-mono text-xs">{inviteData.inviter.slice(0, 6)}...{inviteData.inviter.slice(-4)}</span>
          </div>
          <div className="flex justify-between">
            <span className="flex items-center gap-1 text-muted-foreground">
              <span>Position</span>
              <InfoTooltip text={TOOLTIPS.hop} label="What is a hop?" />
            </span>
            <span>{hopLabel(targetHop)}</span>
          </div>
          {targetConfig && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Cap</span>
              <span>{formatUsdc(targetConfig.capUsdc)} USDC</span>
            </div>
          )}
          {targetConfig && targetConfig.maxInvites > 0 && (
            <div className="flex justify-between">
              <span className="flex items-center gap-1 text-muted-foreground">
                <span>Invite slots</span>
                <InfoTooltip text={TOOLTIPS.slot} label="What is an invite slot?" />
              </span>
              <span>{targetConfig.maxInvites} (you can invite {targetConfig.maxInvites} people to {hopLabel(targetHop + 1)})</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Expires</span>
            <span className={expired ? 'text-destructive' : ''}>
              {expired ? 'Expired' : formatCountdown(timeLeft)}
            </span>
          </div>
        </div>

        {/* Pre-check errors */}
        {preCheckLoading && (
          <div className="text-xs text-muted-foreground">Validating invite link...</div>
        )}

        {expired && <ErrorAlert>{PRE_CHECK_MESSAGES.expired}</ErrorAlert>}

        {!expired && preCheckError && (
          <ErrorAlert>{PRE_CHECK_MESSAGES[preCheckError]}</ErrorAlert>
        )}

        {!expired && !preCheckError && !address && (
          <Button className="w-full" onClick={connect}>
            Connect Wallet
          </Button>
        )}

        {!expired && !preCheckError && address && (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Connected: <span className="font-mono">{address.slice(0, 6)}...{address.slice(-4)}</span>
              {' '} Balance: {formatUsdc(balance)}
            </div>

            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="invite-redeem-amount" className="text-xs font-normal text-muted-foreground">
                  Commitment Amount (USDC)
                </Label>
                {hopCap > 0n && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={handleMax}
                  >
                    MAX: {formatUsdc(hopCap)}
                  </Button>
                )}
              </div>
              <Input
                id="invite-redeem-amount"
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="mt-1 text-sm"
              />
              {hopCap > 0n && (
                <div className="text-xs text-muted-foreground mt-1">
                  {hopLabel(targetHop)} cap: {formatUsdc(hopCap)} per invite slot
                </div>
              )}
            </div>

            {/* Balance warning (non-blocking) */}
            {balanceInsufficient && (
              <div className="text-xs text-amber-500">
                Your USDC balance is insufficient. The transaction will revert if balance is too low.
              </div>
            )}

            {errors.length > 0 && (
              <div className="text-xs text-destructive space-y-1">
                {errors.map((err, i) => <div key={i}>{err}</div>)}
              </div>
            )}

            <Button
              className="w-full"
              disabled={
                parsedAmount === 0n ||
                errors.length > 0 ||
                approvalTx.state.status === 'pending' ||
                approvalTx.state.status === 'submitted' ||
                commitTx.state.status === 'pending' ||
                commitTx.state.status === 'submitted'
              }
              onClick={handleSubmit}
            >
              {needsApproval ? 'Approve & Join' : 'Join & Commit'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
