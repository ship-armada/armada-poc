// ABOUTME: Tests for TxLifecycleStepper — renders one row per lifecycle stage, marks current/done/pending correctly, surfaces technical details.
// ABOUTME: Exercises three records: pending shield, in-progress xchain (waiting), and failed unshield-local.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TxLifecycleStepper, destinationChainIdFor } from './TxLifecycleStepper'
import { getNetworkConfig } from '@/config/network'
import type { TxRecord } from '@/lib/tx/types'

function shieldRecord(overrides?: Partial<TxRecord<'shield'>>): TxRecord<'shield'> {
  return {
    id: '01J-shield',
    kind: 'shield',
    executionState: 'active',
    stage: 'build-proof',
    stagesCompleted: [],
    updatedSeq: 0,
    createdAt: 0,
    updatedAt: 0,
    meta: { amount: 1_000_000n, feeCacheId: 'fc', fromChainId: 31337 },
    artifacts: {},
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rg', sourceChainId: 31337 },
    ...overrides,
  } as TxRecord<'shield'>
}

function xchainRecord(overrides?: Partial<TxRecord<'unshield-xchain'>>): TxRecord<'unshield-xchain'> {
  return {
    id: '01J-xchain',
    kind: 'unshield-xchain',
    executionState: 'waiting',
    stage: 'iris-attestation-pending',
    stagesCompleted: ['build-proof', 'submit-relayer', 'hub-burn-confirmed'],
    updatedSeq: 0,
    createdAt: 0,
    updatedAt: 0,
    meta: { amount: 1_000_000n, feeCacheId: 'fc', toChainId: 31338, recipient: '0xdef' },
    artifacts: {
      sourceTxHash: '0xaaaa' as `0x${string}`,
      messageHash: '0xbbbb' as `0x${string}`,
    },
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rg', sourceChainId: 31337 },
    ...overrides,
  } as TxRecord<'unshield-xchain'>
}

describe('<TxLifecycleStepper>', () => {
  it('renders one row per stage in the lifecycle', () => {
    const { container } = render(<TxLifecycleStepper record={shieldRecord()} />)
    // shield has 3 stages
    expect(container.querySelectorAll('li').length).toBe(3)
  })

  it('renders the TxStatusChip reflecting executionState', () => {
    render(<TxLifecycleStepper record={shieldRecord()} />)
    expect(screen.getByText('Pending')).toBeInTheDocument() // active → "Pending"
  })

  it('uses stageCopy with executionState=waiting for shield waiting on wallet', () => {
    render(
      <TxLifecycleStepper
        record={shieldRecord({ stage: 'submit-relayer', executionState: 'waiting' })}
      />,
    )
    expect(screen.getByText('Confirm in your wallet')).toBeInTheDocument()
  })

  it('marks completed stages and current stage correctly for an xchain record', () => {
    const { container } = render(<TxLifecycleStepper record={xchainRecord()} />)
    const rows = Array.from(container.querySelectorAll('li'))
    // 7 stages total for unshield-xchain
    expect(rows.length).toBe(7)
    // 3 stages completed
    const doneRows = rows.filter(r => r.className.includes('done'))
    expect(doneRows.length).toBe(3)
    // current row should have aria-current="step"
    const currentRow = rows.find(r => r.getAttribute('aria-current') === 'step')
    expect(currentRow).toBeTruthy()
    expect(currentRow?.textContent).toMatch(/Waiting for cross-chain confirmation/)
  })

  it('surfaces the categorised error code + message inside the technical details when present', () => {
    render(
      <TxLifecycleStepper
        record={shieldRecord({
          executionState: 'failed',
          artifacts: { error: { code: 'RPC_ERROR', message: 'Relayer returned 502' } },
        })}
        technicalDetailsDefaultOpen
      />,
    )
    expect(screen.getByText('RPC_ERROR')).toBeInTheDocument()
    expect(screen.getByText(/Relayer returned 502/)).toBeInTheDocument()
  })

  it('shows source tx hash inside the technical details', () => {
    render(
      <TxLifecycleStepper
        record={xchainRecord()}
        technicalDetailsDefaultOpen
      />,
    )
    expect(screen.getByText('0xaaaa')).toBeInTheDocument()
    expect(screen.getByText('0xbbbb')).toBeInTheDocument() // messageHash
  })

  it('shows the usual-duration hint + elapsed while in flight and within p90 (T-L4)', () => {
    // createdAt near "now" (nowAtom defaults to Date.now()) keeps elapsed under the kind's p90.
    render(<TxLifecycleStepper record={shieldRecord({ createdAt: Date.now() })} />)
    expect(screen.getByText(/Usually takes/)).toBeInTheDocument()
    expect(screen.getByText(/elapsed/)).toBeInTheDocument()
  })

  it('flips to "taking longer than usual" once elapsed passes p90 (T-L4)', () => {
    // createdAt = 0 is decades before nowAtom → well past p90.
    render(<TxLifecycleStepper record={shieldRecord({ createdAt: 0 })} />)
    expect(screen.getByText(/Taking longer than usual/)).toBeInTheDocument()
  })

  it('shows no live ETA for a terminal record (T-L4)', () => {
    render(<TxLifecycleStepper record={shieldRecord({ executionState: 'completed', stage: 'hub-confirmed', createdAt: 0 })} />)
    expect(screen.queryByText(/Usually takes|Taking longer|elapsed/)).toBeNull()
  })
})

describe('destinationChainIdFor (T-L5)', () => {
  it('returns the hub chain for shield-xchain (mints on the hub) — not the source chain', () => {
    const rec = { kind: 'shield-xchain', meta: {} } as unknown as TxRecord
    expect(destinationChainIdFor(rec)).toBe(getNetworkConfig().hub.chainId)
  })

  it('returns meta.toChainId for unshield-xchain', () => {
    const rec = { kind: 'unshield-xchain', meta: { toChainId: 31338 } } as unknown as TxRecord
    expect(destinationChainIdFor(rec)).toBe(31338)
  })

  it('returns undefined for same-chain kinds (link falls back to the source chain)', () => {
    expect(destinationChainIdFor({ kind: 'shield', meta: {} } as unknown as TxRecord)).toBeUndefined()
  })
})
