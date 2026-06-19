// ABOUTME: Optional contract reads used by A13 (treasury balance) and the time-based
// ABOUTME: rules (A18/A19/A20). Wrapped behind an interface so tests can pass a fake.

import { Contract, JsonRpcProvider } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS, ERC20_ABI_FRAGMENTS } from '../../../shared/src/lib/constants.js'

export interface ChainStateReader {
  /** Unix seconds when finalize() was called; 0 if not finalized yet. */
  readFinalizedAt(): Promise<number>
  /** Treasury USDC balance in 6-decimal units. */
  readTreasuryUsdcBalance(): Promise<bigint>
}

export interface ChainStateOptions {
  rpcUrl: string
  crowdfundAddress: string
  usdcAddress: string
  treasuryAddress: string
}

export function createRpcChainStateReader(options: ChainStateOptions): ChainStateReader {
  const provider = new JsonRpcProvider(options.rpcUrl)
  const crowdfund = new Contract(options.crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, provider) as unknown as {
    finalizedAt(): Promise<bigint>
  }
  const usdc = new Contract(options.usdcAddress, ERC20_ABI_FRAGMENTS, provider) as unknown as {
    balanceOf(addr: string): Promise<bigint>
  }
  return {
    async readFinalizedAt() {
      const raw = await crowdfund.finalizedAt()
      return Number(raw)
    },
    async readTreasuryUsdcBalance() {
      return await usdc.balanceOf(options.treasuryAddress)
    },
  }
}
