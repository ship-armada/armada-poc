// ABOUTME: Launch team panel to extend the commitment window (extendWindow) up to the contract's maximum.
// ABOUTME: Takes the new deadline in UTC, checks it against the contract rules, and warns near the deadline.

import { useState } from 'react'
import { Contract } from 'ethers'
import type { Signer, JsonRpcProvider } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS, formatCountdown, formatUtcDateTime } from '@armada/crowdfund-shared'
import { useMaxWindowDuration } from '@/hooks/useMaxWindowDuration'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { checkExtension, maxWindowEnd, parseUtcInput, toUtcInput, type WindowTiming } from '@/lib/windowExtension'
import { TransactionFlow } from './TransactionFlow'

const ONE_DAY = 86400

export interface ExtendWindowPanelProps {
  signer: Signer | null
  crowdfundAddress: string
  provider: JsonRpcProvider | null
  windowStart: number
  windowEnd: number
  blockTimestamp: number
}

export function ExtendWindowPanel(props: ExtendWindowPanelProps) {
  const maxWindowDuration = useMaxWindowDuration(props.provider, props.crowdfundAddress)
  // Loading, or a crowdfund deployed before extendWindow existed: nothing to show.
  if (maxWindowDuration === undefined || maxWindowDuration === null) return null
  return <ExtendWindowForm {...props} maxWindowDuration={maxWindowDuration} />
}

export function ExtendWindowForm({
  signer, crowdfundAddress, windowStart, windowEnd, blockTimestamp, maxWindowDuration,
}: ExtendWindowPanelProps & { maxWindowDuration: number }) {
  const [input, setInput] = useState('')
  const tx = useTransactionFlow(signer)

  const timing: WindowTiming = { windowStart, windowEnd, now: blockTimestamp, maxWindowDuration }
  const maxEnd = maxWindowEnd(timing)
  const newEnd = parseUtcInput(input)
  const check = newEnd === null ? null : checkExtension(timing, newEnd)
  const valid = newEnd !== null && check !== null && check.error === null
  const busy = tx.state.status === 'pending' || tx.state.status === 'submitted'

  const preset = (end: number) => setInput(toUtcInput(Math.min(end, maxEnd)))

  const handleExtend = async () => {
    if (!valid || newEnd === null) return
    const success = await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.extendWindow(newEnd)
    })
    if (success) setInput('')
  }

  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="">Extend Window</div>
        <div className="text-muted-foreground">
          {windowEnd > blockTimestamp ? `${formatCountdown(windowEnd - blockTimestamp)} to current end` : 'ended'}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded border border-border p-2">
          <span className="text-muted-foreground">Current end: </span>
          <span className="">{formatUtcDateTime(windowEnd)}</span>
        </div>
        <div className="rounded border border-border p-2">
          <span className="text-muted-foreground">Maximum end: </span>
          <span className="">{formatUtcDateTime(maxEnd)}</span>
        </div>
      </div>

      <label className="block space-y-1">
        <span className="text-muted-foreground">New end (UTC)</span>
        <input
          type="datetime-local"
          aria-label="New end (UTC)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="w-full rounded border border-border bg-background px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </label>

      <div className="flex gap-1">
        <button className="flex-1 px-3 py-1 rounded bg-muted text-muted-foreground hover:text-foreground" onClick={() => preset(windowEnd + ONE_DAY)}>
          +1 day
        </button>
        <button className="flex-1 px-3 py-1 rounded bg-muted text-muted-foreground hover:text-foreground" onClick={() => preset(windowEnd + 3 * ONE_DAY)}>
          +3 days
        </button>
        <button className="flex-1 px-3 py-1 rounded bg-muted text-muted-foreground hover:text-foreground" onClick={() => preset(maxEnd)}>
          Maximum
        </button>
      </div>

      {input !== '' && newEnd === null && <div className="text-destructive">Enter a date and time.</div>}
      {check?.error && <div className="text-destructive">{check.error}</div>}
      {check?.warning && <div className="text-amber-500">{check.warning}</div>}

      <div className="text-muted-foreground">
        Moves the commitment and launch-team deadlines together. It cannot be undone or shortened.
        A launch-team Safe uses <code>npx hardhat cf-safe-extend</code> instead (docs/safe-launch-batches.md).
      </div>

      <button
        className="w-full rounded bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={!valid || busy}
        onClick={handleExtend}
      >
        {valid && newEnd !== null ? `Extend to ${formatUtcDateTime(newEnd)}` : 'Extend window'}
      </button>
      <TransactionFlow state={tx.state} onReset={tx.reset} successMessage="Window extended." />
    </div>
  )
}
