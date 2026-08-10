// ABOUTME: Unit test for the write-capable SDK wiring — the ArtifactSource resolves loaded circuits from
// ABOUTME: the artifactGetter registry to the SDK's {wasm,zkey,vkey} shape, and fails loudly when unloaded.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Artifact } from '@railgun-community/shared-models'

// Stub the worker prover so importing this module doesn't pull the proving stack (or a Worker) into
// the test. createInterfaceProver is lazy, so createWorkerProver isn't invoked until first prove().
vi.mock('@armada/sdk', () => ({
  createWorkerProver: () => ({ prove: async () => ({}), verify: async () => false, close: async () => {} }),
}))

import { createInterfaceArtifactSource, createInterfaceProver } from './sdk-prover'
import { setArmadaArtifact, clearArmadaArtifacts } from './artifactGetter'

const artifact = (wasm: Uint8Array | undefined): Artifact =>
  ({ zkey: new Uint8Array([2]), wasm, vkey: { protocol: 'groth16' }, dat: undefined }) as Artifact

describe('createInterfaceArtifactSource', () => {
  beforeEach(() => {
    clearArmadaArtifacts()
  })

  it('resolves a loaded circuit (by padded NNxMM shape) to { wasm, zkey, vkey }', async () => {
    const wasm = new Uint8Array([1, 2, 3])
    setArmadaArtifact('01x02', artifact(wasm))
    const source = createInterfaceArtifactSource()
    const set = await source.resolve({ nullifiers: 1, commitments: 2 })
    expect(set.wasm).toBe(wasm)
    expect(set.zkey).toEqual(new Uint8Array([2]))
    expect(set.vkey).toEqual({ protocol: 'groth16' })
  })

  it('throws for a shape whose circuit has not been loaded', async () => {
    // WHY: a missing circuit must fail loudly at resolve time, not hang the prover or prove garbage.
    const source = createInterfaceArtifactSource()
    await expect(source.resolve({ nullifiers: 2, commitments: 3 })).rejects.toThrow(/circuit 02x03 not loaded/)
  })

  it('throws when the registered artifact has no wasm (dat-only circuit)', async () => {
    setArmadaArtifact('01x02', artifact(undefined))
    const source = createInterfaceArtifactSource()
    await expect(source.resolve({ nullifiers: 1, commitments: 2 })).rejects.toThrow(/not loaded/)
  })
})

describe('createInterfaceProver', () => {
  it('returns a ProverAdapter (snarkjs backend)', () => {
    const prover = createInterfaceProver()
    expect(typeof prover.prove).toBe('function')
    expect(typeof prover.close).toBe('function')
  })
})
