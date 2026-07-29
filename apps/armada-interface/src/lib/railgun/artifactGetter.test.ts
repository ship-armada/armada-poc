// ABOUTME: Tests for the app-owned ArtifactGetter — the engine arg-3 getter we supply to initForWallet.
// ABOUTME: Because the wallet SDK's download-just-in-time getter isn't exported, we serve Armada circuits from our own map.

import { describe, it, expect, beforeEach } from 'vitest'
import type { Artifact } from '@railgun-community/shared-models'
import {
  armadaArtifactGetter,
  setArmadaArtifact,
  clearArmadaArtifacts,
  hasArmadaArtifact,
  armadaVariantKey,
} from './artifactGetter'

function fakeArtifact(tag: string): Artifact {
  return {
    wasm: new Uint8Array([1, 2, 3]),
    zkey: new Uint8Array([4, 5, 6]),
    vkey: { tag },
    dat: undefined,
  } as unknown as Artifact
}

/** Minimal PublicInputsRailgun-shaped object — the getter only reads array lengths. */
function inputs(nullifiers: number, commitmentsOut: number) {
  return {
    nullifiers: new Array<bigint>(nullifiers).fill(0n),
    commitmentsOut: new Array<bigint>(commitmentsOut).fill(0n),
    merkleRoot: 0n,
    boundParamsHash: 0n,
  }
}

describe('armadaArtifactGetter', () => {
  beforeEach(() => {
    clearArmadaArtifacts()
  })

  it('armadaVariantKey pads to NNxMM', () => {
    expect(armadaVariantKey(1, 2)).toBe('01x02')
    expect(armadaVariantKey(8, 4)).toBe('08x04')
    expect(armadaVariantKey(10, 3)).toBe('10x03')
  })

  it('getArtifacts returns the artifact registered for the input shape', async () => {
    const artifact = fakeArtifact('2x2')
    setArmadaArtifact('02x02', artifact)

    const got = await armadaArtifactGetter.getArtifacts(inputs(2, 2))
    expect(got).toBe(artifact)
  })

  it('getArtifacts throws for a shape that was never registered', async () => {
    await expect(armadaArtifactGetter.getArtifacts(inputs(5, 1))).rejects.toThrow(/05x01/)
  })

  it('assertArtifactExists is a no-op for a registered shape and throws for an unregistered one', () => {
    setArmadaArtifact('02x03', fakeArtifact('2x3'))
    expect(() => armadaArtifactGetter.assertArtifactExists(2, 3)).not.toThrow()
    expect(() => armadaArtifactGetter.assertArtifactExists(7, 1)).toThrow(/07x01/)
  })

  it('getArtifactsPOI always rejects (POI disabled in this deployment)', async () => {
    await expect(armadaArtifactGetter.getArtifactsPOI(3, 3)).rejects.toThrow(/POI/)
  })

  it('hasArmadaArtifact / clearArmadaArtifacts track the registry', () => {
    expect(hasArmadaArtifact('01x02')).toBe(false)
    setArmadaArtifact('01x02', fakeArtifact('1x2'))
    expect(hasArmadaArtifact('01x02')).toBe(true)
    clearArmadaArtifacts()
    expect(hasArmadaArtifact('01x02')).toBe(false)
  })
})
