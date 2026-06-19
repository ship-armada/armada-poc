// ABOUTME: Resets a finished/errored tx pipeline when its host flow unmounts (modal close / navigation).
// ABOUTME: Phase + reset are read through refs so an address-less mount doesn't freeze a no-op reset.

import { useEffect, useRef } from 'react'
import type { UseTxPipelineResult } from './useTxPipeline'

/**
 * Clear a terminal (success/error/aborted) pipeline when the flow closes, so
 * reopening starts a fresh commit instead of re-attaching to a stale
 * confirmation. A running/paused pipeline is left intact so it survives the
 * close and re-attaches on reopen.
 *
 * Crucially, both the phase and the reset handle are read through refs. The
 * unmount cleanup runs from an empty-deps effect, so its closure is frozen at
 * mount — and `pipeline.reset` is a no-op while the wallet address is still null
 * (common on flows not keyed by address, e.g. the /invite page where the user
 * connects after load). Capturing the value directly would freeze that no-op and
 * never clear the connected address's pipeline; the ref always holds the current
 * reset for the live address.
 */
export function useResetPipelineOnClose(pipeline: UseTxPipelineResult): void {
  const phaseRef = useRef(pipeline.state.phase)
  phaseRef.current = pipeline.state.phase
  const resetRef = useRef(pipeline.reset)
  resetRef.current = pipeline.reset

  useEffect(() => {
    return () => {
      const phase = phaseRef.current
      if (phase !== 'running' && phase !== 'paused') {
        resetRef.current()
      }
    }
  }, [])
}
