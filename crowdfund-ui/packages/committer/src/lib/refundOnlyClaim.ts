// ABOUTME: Reads a wallet's refund from the cancelled first-sale (Sale 1) crowdfund, straight from the contract.
// ABOUTME: Carries its own minimal ABI so changes to the live sale's ABI can't break claims on the old contract.

import { Contract, type ContractRunner } from 'ethers'

/** The only functions the first-sale contract is used through. Deliberately not
 *  CROWDFUND_ABI_FRAGMENTS: that list follows the live sale's contract, and the deployed first-sale
 *  contract keeps these signatures whatever the live one changes to. */
export const REFUND_ONLY_ABI = [
  'function phase() view returns (uint8)',
  'function refundMode() view returns (bool)',
  'function claimed(address) view returns (bool)',
  'function getCommitment(address addr, uint8 hop) view returns (uint256)',
  'function claimRefund()',
] as const

/** Tiers in the first-sale contract (its NUM_HOPS); claimRefund() refunds all of them. */
const REFUND_ONLY_HOPS = 3

/** `Phase.Canceled` in the first-sale contract. */
const PHASE_CANCELED = 2

/** The view functions readRefundOnlyClaim needs; an ethers Contract built from REFUND_ONLY_ABI fits. */
export interface RefundOnlyReader {
  phase(): Promise<bigint | number>
  refundMode(): Promise<boolean>
  claimed(addr: string): Promise<boolean>
  getCommitment(addr: string, hop: number): Promise<bigint>
}

export type RefundOnlyClaimState =
  /** Refundable and not yet claimed. */
  | { kind: 'eligible'; amount: bigint }
  /** Already refunded. */
  | { kind: 'claimed'; amount: bigint }
  /** The wallet never committed to the first sale. */
  | { kind: 'none' }
  /** The first sale is neither cancelled nor in refund mode, so claimRefund() would revert. */
  | { kind: 'unavailable' }
  /** A read failed. Never shown as "$0" or "nothing to claim"; the UI offers a retry. */
  | { kind: 'error' }

/** A contract handle for the first-sale crowdfund, for reads (provider) or the claim (signer). */
export function refundOnlyContract(address: string, runner: ContractRunner): Contract {
  return new Contract(address, REFUND_ONLY_ABI, runner)
}

/**
 * The wallet's first-sale refund, mirroring claimRefund(): available when the sale is cancelled or in
 * refund mode, the wallet hasn't claimed, and its commitments across all tiers sum above zero (the
 * contract refunds that full sum). Any failed read gives `error`.
 */
export async function readRefundOnlyClaim(
  reader: RefundOnlyReader,
  wallet: string,
): Promise<RefundOnlyClaimState> {
  try {
    const [phase, refundMode, claimed, commitments] = await Promise.all([
      reader.phase(),
      reader.refundMode(),
      reader.claimed(wallet),
      Promise.all(
        Array.from({ length: REFUND_ONLY_HOPS }, (_, hop) => reader.getCommitment(wallet, hop)),
      ),
    ])
    if (Number(phase) !== PHASE_CANCELED && !refundMode) return { kind: 'unavailable' }
    const amount = commitments.reduce((sum, c) => sum + c, 0n)
    if (amount === 0n) return { kind: 'none' }
    return claimed ? { kind: 'claimed', amount } : { kind: 'eligible', amount }
  } catch {
    return { kind: 'error' }
  }
}
