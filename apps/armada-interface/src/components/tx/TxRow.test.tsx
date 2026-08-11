// ABOUTME: Tests for TxRow — title from recordTitle, amount formatting, status chip, optional stage/progress sub-line, click handler.
// ABOUTME: Click toggles rendering between <button> and <div>; the test checks both shapes.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TxRow } from './TxRow'
import type { TxRecord } from '@/lib/tx/types'

function record(): TxRecord<'unshield-xchain'> {
  return {
    id: '01J',
    kind: 'unshield-xchain',
    executionState: 'waiting',
    stage: 'iris-attestation-pending',
    stagesCompleted: ['build-proof', 'submit-relayer', 'hub-burn-confirmed'],
    updatedSeq: 0,
    createdAt: Date.now(),
    updatedAt: Date.now() - 60_000,
    meta: { amount: 99_500_000n, feeCacheId: 'fc', toChainId: 31338, recipient: '0xdef' },
    artifacts: {},
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rg', sourceChainId: 31337 },
  } as TxRecord<'unshield-xchain'>
}

describe('<TxRow>', () => {
  it('renders the kind-derived title (with destination chain for xchain)', () => {
    render(<TxRow record={record()} />)
    expect(screen.getByText(/^Withdraw to /)).toBeInTheDocument()
  })

  it('renders the formatted amount', () => {
    render(<TxRow record={record()} />)
    expect(screen.getByText('$99.5')).toBeInTheDocument()
  })

  it('renders the status chip mapping (waiting → "Pending")', () => {
    render(<TxRow record={record()} />)
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  it('omits the sub-line by default', () => {
    render(<TxRow record={record()} />)
    expect(screen.queryByText('Waiting for cross-chain confirmation')).toBeNull()
  })

  it('renders the stage copy sub-line when showStageCopy=true', () => {
    render(<TxRow record={record()} showStageCopy />)
    expect(screen.getByText('Waiting for cross-chain confirmation')).toBeInTheDocument()
  })

  it('renders the progress strip when showProgress=true (3 of 7 stages complete)', () => {
    render(<TxRow record={record()} showProgress />)
    expect(screen.getByText('3/7')).toBeInTheDocument()
  })

  it('is a button when onClick is supplied; div otherwise', () => {
    const onClick = vi.fn()
    const { rerender, container } = render(<TxRow record={record()} />)
    expect(container.querySelector('button')).toBeNull()
    rerender(<TxRow record={record()} onClick={onClick} />)
    const btn = container.querySelector('button')
    expect(btn).not.toBeNull()
    fireEvent.click(btn!)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders a synthetic received-transfer record with the "Received" title and no status chip', () => {
    // WHY: incoming transfers are reconstructed from chain as terminal (completed) records with a
    // single 'observed' stage. They must render in the activity list like any other row — title
    // from kindTitle, no Pending chip (completed surfaces the relative time instead).
    const received: TxRecord<'transfer-shielded-received'> = {
      id: 'synth:0xabc:TransferReceiveERC20s',
      kind: 'transfer-shielded-received',
      executionState: 'completed',
      stage: 'observed',
      stagesCompleted: ['observed'],
      updatedSeq: 0,
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 120_000,
      meta: { amount: 5_000_000n },
      artifacts: {},
      walletContext: { evmAddress: undefined, shieldedWalletId: 'rg', sourceChainId: 31337 },
    }
    render(<TxRow record={received} />)
    expect(screen.getByText('Received')).toBeInTheDocument()
    expect(screen.getByText('$5')).toBeInTheDocument()
    expect(screen.queryByText('Pending')).toBeNull()
  })
})
