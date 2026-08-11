// ABOUTME: Tests for TxActions — follower-tab guard (T-H3) hides Retry/Cancel; leader shows them.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { TxRecord } from '@/lib/tx/types'

const hoisted = vi.hoisted(() => ({ isLeader: vi.fn(() => true) }))

vi.mock('@/lib/tx/executor', () => ({
  getIsLeader: hoisted.isLeader,
  canRetryTx: () => false,
  cancelTx: vi.fn(),
  dismissTx: vi.fn(),
  retryTx: vi.fn(),
}))

import { TxActions } from './TxActions'

function inFlightRecord(): TxRecord {
  return {
    id: 'ulid-1',
    kind: 'shield',
    executionState: 'active',
    stage: 'submit-relayer',
    stagesCompleted: ['build-proof'],
    updatedSeq: 2,
    createdAt: 1,
    updatedAt: 1,
    meta: { amount: 1_000_000n, feeCacheId: 'c', fromChainId: 31337 },
    artifacts: {}, // no sourceTxHash → pre-broadcast → "Cancel"
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rw-1', sourceChainId: 31337 },
  } as TxRecord
}

beforeEach(() => {
  hoisted.isLeader.mockReturnValue(true)
})

describe('<TxActions> follower-tab guard (T-H3)', () => {
  it('shows the Cancel action for an in-flight record on the leader tab', () => {
    render(<TxActions record={inFlightRecord()} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('renders nothing on a follower tab — the user cannot drive the executor here', () => {
    // WHY (T-H3): handlers run only on the leader. A follower Retry would wedge the record; a
    // follower Cancel races the leader's state. The follower stays a passive observer.
    hoisted.isLeader.mockReturnValue(false)
    const { container } = render(<TxActions record={inFlightRecord()} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
