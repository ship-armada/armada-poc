// ABOUTME: Tests for useResetPipelineOnClose — clears a finished pipeline on unmount, even after an address-less mount.
// ABOUTME: Guards the /invite regression where a stale "success" re-attached the modal to a $0 confirmation.

// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { getDefaultStore } from 'jotai'
import { useResetPipelineOnClose } from './useResetPipelineOnClose'
import {
  useTxPipeline,
  pipelinesAtom,
  getPipelineState,
  clearAllPipelines,
} from './useTxPipeline'

const ADDR = '0x' + 'a'.repeat(40)
const store = getDefaultStore()

beforeEach(() => {
  clearAllPipelines()
  store.set(pipelinesAtom, {})
})

describe('useResetPipelineOnClose', () => {
  it('resets a finished pipeline on unmount even when the address was null at mount', () => {
    // Mount address-less (the /invite case: the wallet connects after page load),
    // so the mount-time `pipeline.reset` is the null-address no-op.
    const { rerender, unmount } = renderHook(
      ({ address }: { address: string | null }) => {
        const pipeline = useTxPipeline(address)
        useResetPipelineOnClose(pipeline)
        return pipeline
      },
      { initialProps: { address: null as string | null } },
    )

    // Wallet connects; a prior commit left the pipeline at success.
    store.set(pipelinesAtom, {
      [ADDR]: { rows: [{ label: 'Commit', status: 'done' }], phase: 'success' },
    })
    rerender({ address: ADDR })

    // Closing the flow must clear the *connected* address's pipeline (the ref
    // holds the live reset, not the frozen null-address one).
    unmount()
    expect(getPipelineState(store, ADDR).phase).toBe('idle')
  })

  it('leaves a running pipeline intact on unmount so it survives the close', () => {
    store.set(pipelinesAtom, {
      [ADDR]: { rows: [{ label: 'Commit', status: 'loading' }], phase: 'running' },
    })
    const { unmount } = renderHook(() => {
      const pipeline = useTxPipeline(ADDR)
      useResetPipelineOnClose(pipeline)
      return pipeline
    })

    unmount()
    expect(getPipelineState(store, ADDR).phase).toBe('running')
  })
})
