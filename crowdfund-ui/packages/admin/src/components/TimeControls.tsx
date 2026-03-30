// ABOUTME: Local-only time manipulation and USDC minting controls.
// ABOUTME: Provides quick-skip buttons, custom time advance, and Anvil account switcher.

import { useState } from 'react'
import type { UseTimeControlsResult } from '@/hooks/useTimeControls'
import type { AdminState } from '@/hooks/useAdminState'

export interface TimeControlsProps {
  timeControls: UseTimeControlsResult
  state: AdminState
  onMintUsdc?: (recipient: string, amount: string) => Promise<void>
}

const ANVIL_ACCOUNTS = [
  { label: 'Deployer / LT', address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
  { label: 'Security Council', address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
  { label: 'Treasury', address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
  { label: 'User 1', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' },
  { label: 'User 2', address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' },
]

export function TimeControls({ timeControls, state, onMintUsdc }: TimeControlsProps) {
  const [customSeconds, setCustomSeconds] = useState('')
  const [mintRecipient, setMintRecipient] = useState(ANVIL_ACCOUNTS[3].address)
  const [mintAmount, setMintAmount] = useState('100000')

  const handleCustomAdvance = async () => {
    const seconds = parseInt(customSeconds, 10)
    if (!isNaN(seconds) && seconds > 0) {
      await timeControls.advanceTime(seconds)
      setCustomSeconds('')
    }
  }

  const handleMint = async () => {
    if (onMintUsdc && mintRecipient && mintAmount) {
      await onMintUsdc(mintRecipient, mintAmount)
    }
  }

  const handleSwitchAccount = async () => {
    const ethereum = (window as any).ethereum
    if (!ethereum) return
    try {
      await ethereum.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      })
    } catch {
      // User canceled or method not supported
    }
  }

  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-4 space-y-3">
      <div className="text-sm font-medium text-amber-500">Local Dev Controls (Anvil Only)</div>

      {/* Quick-skip buttons */}
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Time Warp</div>
        <div className="flex flex-wrap gap-1">
          <button
            className="px-2 py-1 rounded bg-muted text-xs hover:bg-muted/80"
            onClick={() => timeControls.skipToWeek1End(state.launchTeamInviteEnd, state.blockTimestamp)}
            disabled={state.blockTimestamp >= state.launchTeamInviteEnd}
          >
            Skip to Week-1 End
          </button>
          <button
            className="px-2 py-1 rounded bg-muted text-xs hover:bg-muted/80"
            onClick={() => timeControls.skipToWindowEnd(state.windowEnd, state.blockTimestamp)}
            disabled={state.blockTimestamp >= state.windowEnd}
          >
            Skip to Window End
          </button>
          <button
            className="px-2 py-1 rounded bg-muted text-xs hover:bg-muted/80"
            onClick={() => timeControls.skipToClaimDeadline(state.claimDeadline, state.blockTimestamp)}
            disabled={state.claimDeadline === 0 || state.blockTimestamp >= state.claimDeadline}
          >
            Skip to Claim Deadline
          </button>
        </div>
      </div>

      {/* Custom time advance */}
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Seconds"
          value={customSeconds}
          onChange={(e) => setCustomSeconds(e.target.value)}
          className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          className="px-3 py-1 rounded bg-muted text-xs hover:bg-muted/80"
          onClick={handleCustomAdvance}
        >
          Advance
        </button>
      </div>

      {/* USDC Mint */}
      {onMintUsdc && (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Mint USDC</div>
          <div className="flex gap-2">
            <select
              className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
              value={mintRecipient}
              onChange={(e) => setMintRecipient(e.target.value)}
            >
              {ANVIL_ACCOUNTS.map((acc) => (
                <option key={acc.address} value={acc.address}>
                  {acc.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Amount"
              value={mintAmount}
              onChange={(e) => setMintAmount(e.target.value)}
              className="w-24 rounded border border-input bg-background px-2 py-1 text-xs font-mono"
            />
            <button
              className="px-3 py-1 rounded bg-muted text-xs hover:bg-muted/80"
              onClick={handleMint}
            >
              Mint
            </button>
          </div>
        </div>
      )}

      {/* Account switcher */}
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Switch Anvil Account</div>
        <div className="flex flex-wrap gap-1">
          {ANVIL_ACCOUNTS.map((acc) => (
            <button
              key={acc.address}
              className="px-2 py-1 rounded bg-muted text-[10px] hover:bg-muted/80"
              onClick={() => handleSwitchAccount()}
              title={acc.address}
            >
              {acc.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
