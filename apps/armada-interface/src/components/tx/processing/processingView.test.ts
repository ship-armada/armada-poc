// ABOUTME: Tests for buildProcessingView — maps a live TxRecord to the processing view model.
// ABOUTME: Covers stage mapping from the real lifecycle, active-index tracking, completion, and xchain granularity.

import { describe, it, expect } from 'vitest'
import { buildProcessingView } from './processingView'
import type { TxKind, TxRecord, TxExecutionState } from '@/lib/tx/types'

// buildProcessingView only reads kind/stage/executionState/artifacts; a partial cast is sufficient.
function rec(
  kind: TxKind,
  stage: string,
  executionState: TxExecutionState,
  artifacts: Record<string, unknown> = {},
): TxRecord {
  return { kind, stage, executionState, artifacts } as unknown as TxRecord
}

describe('buildProcessingView', () => {
  it('maps a shield record to its real lifecycle stages + active index', () => {
    const view = buildProcessingView(rec('shield', 'submit-relayer', 'active'))
    expect(view.stages.map((s) => s.id)).toEqual([
      'build-proof',
      'submit-relayer',
      'hub-confirmed',
    ])
    expect(view.activeStageIndex).toBe(1)
    expect(view.completed).toBe(false)
    expect(view.cardCopy.title).toBe('Your USDC is being shielded')
  })

  it('picks the send-flow title from the variant for the shared unshield-* kinds', () => {
    const send = buildProcessingView(rec('unshield-local', 'build-proof', 'active'), {
      sendVariant: 'send',
    })
    expect(send.cardCopy.title).toBe('Unshielding and sending your USDC')
    expect(send.cardCopy.titleLines).toEqual(['Unshielding and sending', 'your USDC'])

    const withdraw = buildProcessingView(rec('unshield-local', 'build-proof', 'active'), {
      sendVariant: 'withdraw',
    })
    expect(withdraw.cardCopy.title).toBe('Unshielding your USDC')
    expect(withdraw.cardCopy.titleLines).toEqual(['Unshielding your', 'USDC'])
  })

  it('snaps to the final stage and exposes the completedLabel when completed', () => {
    const view = buildProcessingView(rec('shield', 'hub-confirmed', 'completed'))
    expect(view.completed).toBe(true)
    expect(view.activeStageIndex).toBe(view.stages.length - 1)
    expect(view.stages.find((s) => s.id === 'hub-confirmed')?.completedLabel).toBe('Shielded')
  })

  it('renders the real (granular) xchain stages, not a fixed 3', () => {
    const view = buildProcessingView(rec('unshield-xchain', 'iris-attestation-pending', 'active'))
    expect(view.stages.length).toBeGreaterThan(3)
    expect(view.stages.some((s) => s.id === 'iris-attestation-pending')).toBe(true)
    expect(view.activeStageIndex).toBe(
      view.stages.findIndex((s) => s.id === 'iris-attestation-pending'),
    )
  })

  it('falls back to index 0 for an unknown stage', () => {
    const view = buildProcessingView(rec('transfer-shielded', 'not-a-stage', 'pending'))
    expect(view.activeStageIndex).toBe(0)
  })

  it('shows the safe-to-close reassurance only once the tx has broadcast', () => {
    // Pre-broadcast: generic "Preparing…" subtitle, no "you can close" promise.
    const pre = buildProcessingView(rec('shield', 'build-proof', 'active'))
    expect(pre.cardCopy.subtitleLines).toBeUndefined()
    expect(pre.cardCopy.subtitle).toBe('Preparing your transaction…')

    // Broadcast (sourceTxHash present): the reassurance appears.
    const post = buildProcessingView(
      rec('shield', 'hub-confirmed', 'active', { sourceTxHash: '0xabc' }),
    )
    expect(post.cardCopy.subtitleLines).toEqual([
      'You can now close this window.',
      "We'll keep processing in the background.",
    ])
  })
})
