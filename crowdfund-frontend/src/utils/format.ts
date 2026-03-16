// ABOUTME: Formatting utilities for displaying USDC, ARM, addresses, and time.
// ABOUTME: All functions handle bigint values from contract calls.
import { Phase } from '@/types/crowdfund'

/** Format USDC (6 decimals) as a dollar string, e.g. "$15,000.00" */
export function formatUsdc(amount: bigint): string {
  const num = Number(amount) / 1e6
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Format USDC as a plain number string without dollar sign, for input fields */
export function formatUsdcPlain(amount: bigint): string {
  return (Number(amount) / 1e6).toString()
}

/** Parse a USDC amount string (e.g. "15000" or "15000.50") to 6-decimal bigint */
export function parseUsdcInput(input: string): bigint {
  const num = parseFloat(input)
  if (isNaN(num) || num < 0) return 0n
  return BigInt(Math.floor(num * 1e6))
}

/** Format ARM (18 decimals) as a token string, e.g. "15,000 ARM" */
export function formatArm(amount: bigint): string {
  const num = Number(amount) / 1e18
  return `${num.toLocaleString('en-US', { maximumFractionDigits: 2 })} ARM`
}

/** Truncate an address to "0xf39F...2266" */
export function truncateAddress(address: string): string {
  if (address.length < 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/** Format seconds as a human-readable countdown: "2d 14h 30m" */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'expired'

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`)
  return parts.join(' ')
}

/** Get human-readable phase name */
export function phaseName(phase: Phase): string {
  switch (phase) {
    case Phase.Setup: return 'Setup'
    case Phase.Active: return 'Active'
    case Phase.Finalized: return 'Finalized'
    case Phase.Canceled: return 'Canceled'
    default: return 'Unknown'
  }
}

/** Get Tailwind color classes for a phase badge */
export function phaseColor(phase: Phase): string {
  switch (phase) {
    case Phase.Setup: return 'bg-muted text-muted-foreground'
    case Phase.Active: return 'bg-info/20 text-info'
    case Phase.Finalized: return 'bg-success/20 text-success'
    case Phase.Canceled: return 'bg-destructive/20 text-destructive'
    default: return 'bg-muted text-muted-foreground'
  }
}

/** Get hop label for display */
export function hopLabel(hop: number): string {
  switch (hop) {
    case 0: return 'Seed (hop-0)'
    case 1: return 'Hop-1'
    case 2: return 'Hop-2'
    default: return `Hop-${hop}`
  }
}
