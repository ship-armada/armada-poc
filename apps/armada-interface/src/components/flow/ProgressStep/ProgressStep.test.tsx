// ABOUTME: Tests for ProgressStep — pre-record placeholder vs. delegating to TxLifecycleStepper once a record exists.
// ABOUTME: We assert via well-known stage copy ("Preparing transaction") that TxLifecycleStepper rendered.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProgressStep } from './ProgressStep'
import type { TxRecord } from '@/lib/tx/types'

const sampleRecord: TxRecord<'shield'> = {
  id: '01JX',
  kind: 'shield',
  executionState: 'active',
  stage: 'build-proof',
  stagesCompleted: [],
  updatedSeq: 1,
  createdAt: 0,
  updatedAt: 0,
  meta: { amount: 1_000_000n, feeCacheId: 'fc-1', fromChainId: 31337 },
  artifacts: {},
  walletContext: {
    evmAddress: '0xabc',
    railgunWalletId: 'rg-1',
    sourceChainId: 31337,
  },
}

describe('<ProgressStep>', () => {
  it('renders preparing placeholder when no record exists', () => {
    render(<ProgressStep record={null} />)
    expect(screen.getByText('Preparing transaction')).toBeInTheDocument()
    expect(screen.getByText('Hang on a moment…')).toBeInTheDocument()
  })

  it('delegates to TxLifecycleStepper when record is present', () => {
    render(<ProgressStep record={sampleRecord} />)
    // TxLifecycleStepper renders one row per lifecycle stage; the first is "Preparing transaction"
    // which is shield's build-proof copy. (The WalletConfirmList — S-M4 — also renders status
    // labels including "Pending", so we assert the unique stepper copy rather than "Pending".)
    expect(screen.getByText('Preparing transaction')).toBeInTheDocument()
    expect(screen.getAllByText('Pending').length).toBeGreaterThanOrEqual(1)
  })

  it('renders the wallet-confirm checklist for shield kinds (S-M4)', () => {
    render(<ProgressStep record={sampleRecord} />)
    expect(screen.getByRole('list', { name: 'Wallet confirmations' })).toBeInTheDocument()
  })
})
