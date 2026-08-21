// ABOUTME: Tests for parseDebugParam — the ?debug URL-param → on/off/unset mapping behind debug mode.

import { describe, it, expect } from 'vitest'
import { parseDebugParam } from './useDebugSync'

describe('parseDebugParam', () => {
  it('returns null when debug is absent (leaves the stored value alone)', () => {
    expect(parseDebugParam('')).toBeNull()
    expect(parseDebugParam('?foo=1')).toBeNull()
  })

  it('treats bare ?debug and truthy values as on', () => {
    expect(parseDebugParam('?debug')).toBe(true)
    expect(parseDebugParam('?debug=1')).toBe(true)
    expect(parseDebugParam('?debug=true')).toBe(true)
    expect(parseDebugParam('?debug=on')).toBe(true)
  })

  it('treats explicit falsy values as off', () => {
    expect(parseDebugParam('?debug=0')).toBe(false)
    expect(parseDebugParam('?debug=false')).toBe(false)
    expect(parseDebugParam('?debug=off')).toBe(false)
  })
})
