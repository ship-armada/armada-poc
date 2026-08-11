// ABOUTME: Unit tests for stageCopy / kindTitle / recordTitle.
// ABOUTME: Covers active/waiting executionState resolution (shield) and chain-name appending for xchain kinds.

import { describe, it, expect } from 'vitest'
import { stageCopy, kindTitle, recordTitle } from './stageCopy'
import type { TxRecord } from '@/lib/tx/types'

describe('stageCopy', () => {
  it('returns plain strings for stages without active/waiting variants', () => {
    expect(stageCopy('shield', 'build-proof')).toBe('Preparing transaction')
    expect(stageCopy('unshield-xchain', 'client-mint-confirmed')).toBe('Funds delivered')
  })

  it("returns the 'waiting' variant when executionState is waiting (shield only today)", () => {
    expect(stageCopy('shield', 'submit-relayer', 'waiting')).toBe('Confirm in your wallet')
    expect(stageCopy('shield', 'submit-relayer', 'active')).toBe('Submitting transaction')
    expect(stageCopy('shield', 'submit-relayer')).toBe('Submitting transaction')
  })

  it('falls back to the raw stage string for unknown stages', () => {
    expect(stageCopy('shield', 'made-up-stage')).toBe('made-up-stage')
  })

  it("resolves the received kind's single 'observed' stage", () => {
    // WHY: synthetic received-transfer records carry a single terminal 'observed' stage; the
    // stepper/row read its copy via stageCopy. Guards against the new kind landing with no entry.
    expect(stageCopy('transfer-shielded-received', 'observed')).toBe('Received')
  })
})

describe('kindTitle', () => {
  it('returns the short title per kind', () => {
    expect(kindTitle('shield')).toBe('Deposit')
    expect(kindTitle('unshield-local')).toBe('Withdraw')
    expect(kindTitle('unshield-xchain')).toBe('Withdraw')
    expect(kindTitle('transfer-shielded')).toBe('Private transfer')
    expect(kindTitle('transfer-shielded-received')).toBe('Received')
    expect(kindTitle('yield-deposit')).toBe('Vault deposit')
    expect(kindTitle('yield-withdraw')).toBe('Vault withdrawal')
  })
})

describe('recordTitle', () => {
  it('returns the bare kind title for non-xchain kinds', () => {
    const record: TxRecord<'shield'> = {
      id: '01J', kind: 'shield', executionState: 'pending', stage: 'build-proof',
      stagesCompleted: [], updatedSeq: 0, createdAt: 0, updatedAt: 0,
      meta: { amount: 0n, feeCacheId: '', fromChainId: 31337 },
      artifacts: {},
      walletContext: { evmAddress: undefined, shieldedWalletId: '', sourceChainId: 31337 },
    }
    expect(recordTitle(record)).toBe('Deposit')
  })

  it('appends chain name for unshield-xchain', () => {
    const record: TxRecord<'unshield-xchain'> = {
      id: '01J', kind: 'unshield-xchain', executionState: 'pending', stage: 'build-proof',
      stagesCompleted: [], updatedSeq: 0, createdAt: 0, updatedAt: 0,
      meta: {
        amount: 0n,
        feeCacheId: '',
        toChainId: 31338,
        recipient: '0x0',
        broadcasterFeeAmount: 0n,
        broadcasterShieldedAddress: '',
      },
      artifacts: {},
      walletContext: { evmAddress: undefined, shieldedWalletId: '', sourceChainId: 31337 },
    }
    expect(recordTitle(record)).toMatch(/^Withdraw to /)
  })

})
