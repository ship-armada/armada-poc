// ABOUTME: Unit tests for stageCopy / kindTitle / recordTitle.
// ABOUTME: Covers active/waiting executionState resolution (shield) and the mockup activity copy (deposit source chain, sent-to-recipient, vault ops).

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
  it('names the source chain for a deposit (shield)', () => {
    const record: TxRecord<'shield'> = {
      id: '01J', kind: 'shield', executionState: 'pending', stage: 'build-proof',
      stagesCompleted: [], updatedSeq: 0, createdAt: 0, updatedAt: 0,
      meta: { amount: 0n, feeCacheId: '', fromChainId: 31337 },
      artifacts: {},
      walletContext: { evmAddress: undefined, shieldedWalletId: '', sourceChainId: 31337 },
    }
    expect(recordTitle(record)).toMatch(/^Deposit from /)
  })

  it('names the 0x recipient for a public unshield (external send / withdraw)', () => {
    const record: TxRecord<'unshield-xchain'> = {
      id: '01J', kind: 'unshield-xchain', executionState: 'pending', stage: 'build-proof',
      stagesCompleted: [], updatedSeq: 0, createdAt: 0, updatedAt: 0,
      meta: {
        amount: 0n,
        feeCacheId: '',
        toChainId: 31338,
        recipient: '0x1234567890abcdef1234567890abcdef12345678',
        broadcasterFeeAmount: 0n,
        broadcasterShieldedAddress: '',
      },
      artifacts: {},
      walletContext: { evmAddress: undefined, shieldedWalletId: '', sourceChainId: 31337 },
    }
    expect(recordTitle(record)).toMatch(/^Sent to 0x/)
  })

  it('reads "Sent to private address" for a private (0zk) transfer', () => {
    const record: TxRecord<'transfer-shielded'> = {
      id: '01J', kind: 'transfer-shielded', executionState: 'pending', stage: 'build-proof',
      stagesCompleted: [], updatedSeq: 0, createdAt: 0, updatedAt: 0,
      meta: {
        amount: 0n,
        feeCacheId: '',
        recipient: '0zkaaaa',
        broadcasterFeeAmount: 0n,
        broadcasterShieldedAddress: '',
      },
      artifacts: {},
      walletContext: { evmAddress: undefined, shieldedWalletId: '', sourceChainId: 31337 },
    }
    expect(recordTitle(record)).toBe('Sent to private address')
  })

  it('reads "Received payment" for an incoming private transfer', () => {
    const record: TxRecord<'transfer-shielded-received'> = {
      id: '01J', kind: 'transfer-shielded-received', executionState: 'completed', stage: 'observed',
      stagesCompleted: ['observed'], updatedSeq: 0, createdAt: 0, updatedAt: 0,
      meta: { amount: 0n },
      artifacts: {},
      walletContext: { evmAddress: undefined, shieldedWalletId: '', sourceChainId: 31337 },
    }
    expect(recordTitle(record)).toBe('Received payment')
  })

  it('reads the earn-vault copy for yield ops', () => {
    const base = {
      id: '01J', executionState: 'pending' as const, stage: 'build-proof',
      stagesCompleted: [], updatedSeq: 0, createdAt: 0, updatedAt: 0,
      artifacts: {},
      walletContext: { evmAddress: undefined, shieldedWalletId: '', sourceChainId: 31337 },
    }
    const deposit: TxRecord<'yield-deposit'> = {
      ...base, kind: 'yield-deposit',
      meta: { amount: 0n, feeCacheId: '', broadcasterFeeAmount: 0n, broadcasterShieldedAddress: '' },
    }
    const withdraw: TxRecord<'yield-withdraw'> = {
      ...base, kind: 'yield-withdraw',
      meta: { amount: 0n, feeCacheId: '', shares: 0n, broadcasterFeeAmount: 0n, broadcasterShieldedAddress: '' },
    }
    expect(recordTitle(deposit)).toBe('Added to earn vault')
    expect(recordTitle(withdraw)).toBe('Withdrawn from earn vault')
  })
})
