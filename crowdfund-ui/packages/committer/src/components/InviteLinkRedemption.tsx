// ABOUTME: Standalone invite link redemption page — parses URL params, validates, and commits.
// ABOUTME: Handles wallet connection, USDC approval, and commitWithInvite() atomically.

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { JsonRpcProvider, Contract, BrowserProvider } from 'ethers'
import type { JsonRpcSigner } from 'ethers'
import {
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
import { TransactionFlow } from './TransactionFlow'

export function InviteLinkRedemption() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [blockTimestamp, setBlockTimestamp] = useState(0)
  const [amountInput, setAmountInput] = useState('')
  const [balance, setBalance] = useState<bigint>(0n)
  const [allowance, setAllowance] = useState<bigint>(0n)

  const approvalTx = useTransactionFlow(signer)
  const commitTx = useTransactionFlow(signer)

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

  const connect = useCallback(async () => {
    const ethereum = (window as any).ethereum
    if (!ethereum) return

    setConnecting(true)
    try {
      const bp = new BrowserProvider(ethereum)
      await bp.send('eth_requestAccounts', [])
      const s = await bp.getSigner()
      const addr = await s.getAddress()
      setSigner(s)
      setAddress(addr.toLowerCase())
    } catch {
      // User rejected
    } finally {
      setConnecting(false)
    }
  }, [])

  const parsedAmount = useMemo(() => parseUsdcInput(amountInput), [amountInput])
  const targetHop = inviteData ? inviteData.fromHop + 1 : 0
  const hopCap = targetHop <= 2 ? HOP_CONFIGS[targetHop as 0 | 1 | 2].capUsdc : 0n
  const expired = inviteData ? inviteData.deadline < blockTimestamp : true
  const needsApproval = parsedAmount > allowance

  const handleMax = useCallback(() => {
    if (hopCap === 0n) return
    // Cap is in 6-decimal USDC units, convert to display string
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
    if (parsedAmount > balance) errs.push('Insufficient USDC balance')
    return errs
  }, [parsedAmount, balance, hopCap, targetHop])

  const handleSubmit = useCallback(async () => {
    if (!inviteData || !deployment || parsedAmount === 0n) return

    // Step 1: Approve if needed
    if (needsApproval) {
      const success = await approvalTx.execute(async (s) => {
        const usdc = new Contract(deployment.contracts.usdc, ERC20_ABI_FRAGMENTS, s)
        return usdc.approve(deployment.contracts.crowdfund, parsedAmount)
      })
      if (!success) return
      setAllowance(parsedAmount)
    }

    // Step 2: commitWithInvite
    const success = await commitTx.execute(async (s) => {
      const crowdfund = new Contract(deployment.contracts.crowdfund, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.commitWithInvite(
        inviteData.inviter,
        inviteData.fromHop,
        inviteData.nonce,
        inviteData.deadline,
        inviteData.signature,
        parsedAmount,
      )
    })

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

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 space-y-4">
        <h1 className="text-xl font-bold">Armada Crowdfund Invite</h1>

        {/* Invite details */}
        <div className="rounded border border-border p-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">From</span>
            <span className="font-mono text-xs">{inviteData.inviter.slice(0, 6)}...{inviteData.inviter.slice(-4)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Target Hop</span>
            <span>{hopLabel(targetHop)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Expires</span>
            <span className={expired ? 'text-destructive' : ''}>
              {expired ? 'Expired' : formatCountdown(timeLeft)}
            </span>
          </div>
        </div>

        {expired && (
          <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            This invite link has expired.
          </div>
        )}

        {!expired && !address && (
          <button
            className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            onClick={connect}
            disabled={connecting}
          >
            {connecting ? 'Connecting...' : 'Connect Wallet'}
          </button>
        )}

        {!expired && address && (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Connected: <span className="font-mono">{address.slice(0, 6)}...{address.slice(-4)}</span>
              {' '} Balance: {formatUsdc(balance)}
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Commitment Amount (USDC)</label>
                {hopCap > 0n && (
                  <button
                    className="text-xs text-primary hover:underline"
                    onClick={handleMax}
                  >
                    MAX: {formatUsdc(hopCap)}
                  </button>
                )}
              </div>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm mt-1 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {hopCap > 0n && (
                <div className="text-xs text-muted-foreground mt-1">
                  {hopLabel(targetHop)} cap: {formatUsdc(hopCap)} per invite slot
                </div>
              )}
            </div>

            {errors.length > 0 && (
              <div className="text-xs text-destructive space-y-1">
                {errors.map((err, i) => <div key={i}>{err}</div>)}
              </div>
            )}

            <button
              className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={parsedAmount === 0n || errors.length > 0 || commitTx.state.status === 'pending' || commitTx.state.status === 'submitted'}
              onClick={handleSubmit}
            >
              {needsApproval ? 'Approve & Join' : 'Join & Commit'}
            </button>

            <TransactionFlow
              state={approvalTx.state.status !== 'idle' ? approvalTx.state : commitTx.state}
              onReset={() => { approvalTx.reset(); commitTx.reset() }}
              successMessage="Welcome to the Armada crowdfund! Redirecting..."
              explorerUrl={getExplorerUrl()}
            />
          </div>
        )}
      </div>
    </div>
  )
}
