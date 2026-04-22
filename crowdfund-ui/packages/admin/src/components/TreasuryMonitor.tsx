// ABOUTME: Treasury balance display for USDC and ARM tokens with address copy.
// ABOUTME: Shows balances at both the contract and treasury addresses.

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { formatUsdc, formatArm, truncateAddress } from '@armada/crowdfund-shared'
import type { TreasuryBalances } from '@/hooks/useTreasuryBalances'

export interface TreasuryMonitorProps {
  treasury: TreasuryBalances
  treasuryAddress: string | null
}

export function TreasuryMonitor({ treasury, treasuryAddress }: TreasuryMonitorProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!treasuryAddress) return
    navigator.clipboard.writeText(treasuryAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Treasury Monitor</div>
        {treasuryAddress && (
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-muted-foreground font-mono">{truncateAddress(treasuryAddress)}</span>
            <button
              className="text-muted-foreground hover:text-foreground relative inline-block min-w-[32px] text-left"
              onClick={handleCopy}
            >
              <AnimatePresence mode="wait" initial={false}>
                {copied ? (
                  <motion.span
                    key="copied"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="inline-block"
                  >
                    copied
                  </motion.span>
                ) : (
                  <motion.span
                    key="copy"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.1 }}
                    className="inline-block"
                  >
                    copy
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          </div>
        )}
      </div>
      {treasury.loading ? (
        <div className="text-xs text-muted-foreground">Loading balances...</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="space-y-1">
            <div className="text-muted-foreground font-medium">Contract</div>
            <div>USDC: {formatUsdc(treasury.contractUsdcBalance)}</div>
            <div>ARM: {formatArm(treasury.contractArmBalance)}</div>
          </div>
          <div className="space-y-1">
            <div className="text-muted-foreground font-medium">Treasury</div>
            <div>USDC: {formatUsdc(treasury.treasuryUsdcBalance)}</div>
            <div>ARM: {formatArm(treasury.treasuryArmBalance)}</div>
          </div>
        </div>
      )}
    </div>
  )
}
