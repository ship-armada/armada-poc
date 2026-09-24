// ABOUTME: Unit tests for converting the chain-time commit-window end onto the local clock.
// ABOUTME: A skewed device clock must not change the remaining time the countdown shows.
import { describe, it, expect } from 'vitest'
import { localWindowEndUnix } from './windowClock'

const WINDOW_END = 1_750_100_000
const BLOCK_TS = 1_750_000_000 // chain says 100_000s remain

describe('localWindowEndUnix', () => {
  it('keeps the chain remaining time when the device clock matches the chain', () => {
    const observedAtMs = BLOCK_TS * 1000
    expect(localWindowEndUnix(WINDOW_END, BLOCK_TS, observedAtMs)).toBe(WINDOW_END)
  })

  it('shifts the end later when the device clock runs fast', () => {
    const observedAtMs = (BLOCK_TS + 600) * 1000 // device 10 min ahead
    const localEnd = localWindowEndUnix(WINDOW_END, BLOCK_TS, observedAtMs)
    expect(localEnd - observedAtMs / 1000).toBe(WINDOW_END - BLOCK_TS)
  })

  it('shifts the end earlier when the chain is ahead (e.g. Anvil time warp)', () => {
    const observedAtMs = (BLOCK_TS - 86_400) * 1000 // chain warped 1 day ahead
    const localEnd = localWindowEndUnix(WINDOW_END, BLOCK_TS, observedAtMs)
    expect(localEnd - observedAtMs / 1000).toBe(WINDOW_END - BLOCK_TS)
  })

  it('rounds the local observation time to whole seconds', () => {
    expect(localWindowEndUnix(WINDOW_END, BLOCK_TS, BLOCK_TS * 1000 + 400)).toBe(WINDOW_END)
  })
})
