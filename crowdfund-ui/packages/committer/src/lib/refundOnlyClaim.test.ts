// ABOUTME: Tests for the first-sale refund reads: the eligibility matrix and fail-closed read errors.
// ABOUTME: Uses plain reader doubles, so no chain or ethers provider is involved.

import { describe, expect, it } from 'vitest'
import { REFUND_ONLY_ABI, readRefundOnlyClaim, type RefundOnlyReader } from './refundOnlyClaim'

const WALLET = '0x1111111111111111111111111111111111111111'
const USDC = (n: number) => BigInt(n) * 1_000_000n

function reader(over: Partial<{
  phase: number
  refundMode: boolean
  claimed: boolean
  commitments: bigint[]
  fail: 'phase' | 'claimed' | 'commitment'
}> = {}): RefundOnlyReader {
  const o = { phase: 2, refundMode: false, claimed: false, commitments: [USDC(1000), 0n, USDC(500)], ...over }
  return {
    phase: async () => {
      if (o.fail === 'phase') throw new Error('rpc down')
      return BigInt(o.phase)
    },
    refundMode: async () => o.refundMode,
    claimed: async () => {
      if (o.fail === 'claimed') throw new Error('rpc down')
      return o.claimed
    },
    getCommitment: async (_addr: string, hop: number) => {
      if (o.fail === 'commitment') throw new Error('rpc down')
      return o.commitments[hop] ?? 0n
    },
  }
}

describe('readRefundOnlyClaim', () => {
  // WHY: the refund is the sum of the wallet's commitments across all three tiers, read from the
  // contract itself, so no indexer is needed.
  it('is eligible for the summed commitment on a cancelled sale', async () => {
    expect(await readRefundOnlyClaim(reader(), WALLET)).toEqual({ kind: 'eligible', amount: USDC(1500) })
  })

  // WHY: claimRefund() also pays out when the old sale finalized below its minimum (refund mode).
  it('is eligible in refund mode as well as after a cancel', async () => {
    expect(await readRefundOnlyClaim(reader({ phase: 1, refundMode: true }), WALLET)).toEqual({
      kind: 'eligible',
      amount: USDC(1500),
    })
  })

  it('reports an already-claimed refund with its amount', async () => {
    expect(await readRefundOnlyClaim(reader({ claimed: true }), WALLET)).toEqual({ kind: 'claimed', amount: USDC(1500) })
  })

  it('reports nothing to claim for a wallet that never committed', async () => {
    expect(await readRefundOnlyClaim(reader({ commitments: [0n, 0n, 0n] }), WALLET)).toEqual({ kind: 'none' })
  })

  // WHY: if the target sale is not refundable, claimRefund() would revert; never offer it.
  it('reports unavailable when the sale is neither cancelled nor in refund mode', async () => {
    expect(await readRefundOnlyClaim(reader({ phase: 1 }), WALLET)).toEqual({ kind: 'unavailable' })
    expect(await readRefundOnlyClaim(reader({ phase: 0 }), WALLET)).toEqual({ kind: 'unavailable' })
  })

  // WHY: a failed read must never show as "$0" or "nothing to claim"; the UI offers a retry instead.
  it('fails closed to an error on any read failure', async () => {
    for (const fail of ['phase', 'claimed', 'commitment'] as const) {
      expect(await readRefundOnlyClaim(reader({ fail }), WALLET)).toEqual({ kind: 'error' })
    }
  })
})

describe('REFUND_ONLY_ABI', () => {
  // WHY: the module carries its own ABI so changes to the live sale's ABI can never break claims
  // against the deployed first-sale contract.
  it('declares exactly the five functions the first-sale contract is used through', () => {
    expect(REFUND_ONLY_ABI).toEqual([
      'function phase() view returns (uint8)',
      'function refundMode() view returns (bool)',
      'function claimed(address) view returns (bool)',
      'function getCommitment(address addr, uint8 hop) view returns (uint256)',
      'function claimRefund()',
    ])
  })
})
