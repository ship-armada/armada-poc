// ABOUTME: ARM pre-load verification panel with contract address and ARM balance display.
// ABOUTME: Permissionless — anyone can call loadArm() to verify ARM token balance.

import { useState, useEffect } from 'react'
import { Contract } from 'ethers'
import type { Signer, JsonRpcProvider } from 'ethers'
import {
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  formatArm,
  truncateAddress,
} from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface ArmLoadPanelProps {
  signer: Signer | null
  crowdfundAddress: string
  provider: JsonRpcProvider | null
  armTokenAddress: string | null
}

export function ArmLoadPanel({ signer, crowdfundAddress, provider, armTokenAddress }: ArmLoadPanelProps) {
  const tx = useTransactionFlow(signer)
  const [armBalance, setArmBalance] = useState<bigint | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!provider || !armTokenAddress || !crowdfundAddress) return
    const arm = new Contract(armTokenAddress, ERC20_ABI_FRAGMENTS, provider)
    arm.balanceOf(crowdfundAddress).then((bal: bigint) => setArmBalance(bal)).catch(() => {})
  }, [provider, armTokenAddress, crowdfundAddress])

  const handleCopy = () => {
    navigator.clipboard.writeText(crowdfundAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleLoad = async () => {
    await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.loadArm()
    })
  }

  return (
    <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
      <div className="text-sm font-medium text-amber-500">ARM Not Loaded</div>
      <div className="text-xs space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Contract:</span>
          <span className="font-mono">{truncateAddress(crowdfundAddress)}</span>
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground"
            onClick={handleCopy}
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
        {armBalance !== null && (
          <div>
            <span className="text-muted-foreground">ARM balance: </span>
            <span className="font-medium">{formatArm(armBalance)}</span>
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        ARM tokens must be deposited and verified before the commitment window opens.
      </div>
      <button
        className="rounded bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
        onClick={handleLoad}
        disabled={tx.state.status === 'pending' || tx.state.status === 'submitted'}
      >
        Verify ARM Load
      </button>
      <TransactionFlow state={tx.state} onReset={tx.reset} successMessage="ARM loaded!" />
    </div>
  )
}
