// ABOUTME: Tests the NodeSphere layout geometry: shell radii and default camera distance, standard and
// ABOUTME: for profiles that hide team wallets (hop 1), where no empty shell sits between the visible tiers.

import { describe, expect, it } from 'vitest'
import { graphDefaultCameraZ, graphShellRadii } from './graphShellRadii'

describe('graphShellRadii', () => {
  // WHY: profiles that show team wallets keep the designer's layout unchanged.
  it('keeps the standard shells when team wallets are shown', () => {
    expect(graphShellRadii(false)).toEqual({
      'Hop 0': 2.4,
      'Hop 1': 3.6,
      'Hop 2': 5.1,
      'Multi-hop': 6.4,
    })
  })

  // WHY: with hop 1 hidden its shell is always empty, which left a double-width gap between
  // Backer (hop 0) and Community (hop 2). Hop 2 and multi-hop move in one shell so the visible tiers
  // keep the standard spacing, and multi-hop no longer sits past the default camera distance.
  it('moves hop 2 and multi-hop in one shell when team wallets are hidden', () => {
    const radii = graphShellRadii(true)
    expect(radii['Hop 0']).toBe(2.4)
    expect(radii['Hop 2']).toBe(3.6)
    expect(radii['Multi-hop']).toBe(5.1)
  })
})

describe('graphDefaultCameraZ', () => {
  // WHY: profiles that show team wallets start at the designer's closest zoom.
  it('starts at the closest zoom when team wallets are shown', () => {
    expect(graphDefaultCameraZ(6, false)).toBe(6)
  })

  // WHY: with hop 2 pulled in, the default view starts half a unit further out so the whole sphere
  // frames comfortably; wheel zoom can still go back in to the closest zoom.
  it('starts half a unit further out when team wallets are hidden', () => {
    expect(graphDefaultCameraZ(6, true)).toBe(6.5)
  })
})
