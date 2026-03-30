// ABOUTME: Formatting utilities for USDC amounts, ARM tokens, addresses, and countdowns.
// ABOUTME: Pure functions with no React or ethers dependency.

/** Format a USDC amount (6 decimals) as a dollar string, e.g. "$1,200,000" */
export function formatUsdc(amount: bigint): string {
  const dollars = Number(amount) / 1e6
  return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
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

/** Format an ARM amount (18 decimals) as a token string, e.g. "1,200,000 ARM" */
export function formatArm(amount: bigint): string {
  const tokens = Number(amount) / 1e18
  return `${tokens.toLocaleString('en-US', { maximumFractionDigits: 2 })} ARM`
}

/** Truncate an Ethereum address to "0x1234...abcd" format */
export function truncateAddress(address: string): string {
  if (address.length <= 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/** Format a duration in seconds as a human-readable countdown, e.g. "6d 14h" */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'expired'

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** Get human-readable phase name */
export function phaseName(phase: number): string {
  switch (phase) {
    case 0: return 'Active'
    case 1: return 'Finalized'
    case 2: return 'Canceled'
    default: return 'Unknown'
  }
}

/** Get Tailwind color classes for a phase badge */
export function phaseColor(phase: number): string {
  switch (phase) {
    case 0: return 'bg-info/20 text-info'
    case 1: return 'bg-success/20 text-success'
    case 2: return 'bg-destructive/20 text-destructive'
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
