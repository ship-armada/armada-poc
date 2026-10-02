// ABOUTME: Unit tests for when an open Claim modal should close itself.
// ABOUTME: A ?view=claim deep link must survive the contract-state load, not close on the first render.
import { describe, it, expect } from 'vitest'
import { shouldDismissClaimModal } from './claimModal'

describe('shouldDismissClaimModal', () => {
  it('keeps a deep-linked modal open while contract state is still loading', () => {
    expect(shouldDismissClaimModal({ open: true, ready: false, stateLoading: true })).toBe(false)
  })

  it('closes once loaded state says claim is not available', () => {
    expect(shouldDismissClaimModal({ open: true, ready: false, stateLoading: false })).toBe(true)
  })

  it('keeps the modal open when claim is available', () => {
    expect(shouldDismissClaimModal({ open: true, ready: true, stateLoading: false })).toBe(false)
  })

  it('does nothing when the modal is closed', () => {
    expect(shouldDismissClaimModal({ open: false, ready: false, stateLoading: false })).toBe(false)
  })
})
