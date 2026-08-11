// ABOUTME: Tests for the in-memory ZK-circuit artifact registry — keyed by padded circuit shape (NNxMM).
// ABOUTME: The registry is populated by the origin preload and read by the @armada/sdk ArtifactSource.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  type ArmadaArtifact,
  setArmadaArtifact,
  getArmadaArtifact,
  clearArmadaArtifacts,
  hasArmadaArtifact,
  armadaVariantKey,
} from './artifactGetter'

function fakeArtifact(tag: string): ArmadaArtifact {
  return {
    wasm: new Uint8Array([1, 2, 3]),
    zkey: new Uint8Array([4, 5, 6]),
    vkey: { tag },
  }
}

describe('artifact registry', () => {
  beforeEach(() => {
    clearArmadaArtifacts()
  })

  it('armadaVariantKey pads to NNxMM', () => {
    // WHY: the registry key must match the padded shape string the SDK's ArtifactSource looks up,
    // or proof generation can't resolve a circuit even when it was preloaded.
    expect(armadaVariantKey(1, 2)).toBe('01x02')
    expect(armadaVariantKey(8, 4)).toBe('08x04')
    expect(armadaVariantKey(10, 3)).toBe('10x03')
  })

  it('getArmadaArtifact returns the artifact registered for a shape key', () => {
    // WHY: the ArtifactSource resolves circuits solely through this lookup; a registered artifact
    // must round-trip by its exact key.
    const artifact = fakeArtifact('2x2')
    setArmadaArtifact('02x02', artifact)
    expect(getArmadaArtifact('02x02')).toBe(artifact)
  })

  it('getArmadaArtifact returns undefined for a shape that was never registered', () => {
    // WHY: an unserved shape must be distinguishable (undefined) so sdk-prover fails loudly rather
    // than proving against a stale artifact.
    expect(getArmadaArtifact('05x01')).toBeUndefined()
  })

  it('hasArmadaArtifact / clearArmadaArtifacts track the registry', () => {
    expect(hasArmadaArtifact('01x02')).toBe(false)
    setArmadaArtifact('01x02', fakeArtifact('1x2'))
    expect(hasArmadaArtifact('01x02')).toBe(true)
    clearArmadaArtifacts()
    expect(hasArmadaArtifact('01x02')).toBe(false)
  })
})
