/**
 * Address utility functions
 */

/**
 * Truncates an address to show first N and last M characters
 * @param address - The address to truncate
 * @param start - Number of characters to show at the start (default: 8)
 * @param end - Number of characters to show at the end (default: 6)
 * @returns Truncated address string (e.g., "0x1234...5678")
 */
export function truncateAddress(address: string, start: number = 8, end: number = 6): string {
  if (address.length <= start + end) {
    return address
  }
  return `${address.slice(0, start)}...${address.slice(-end)}`
}

