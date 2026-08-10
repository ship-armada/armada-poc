// ABOUTME: Unit test for runShieldDifferential — feeds the SDK builder the engine's random and asserts
// ABOUTME: the sdk.shieldDiff telemetry reflects commitment (npk/value/shieldKey) parity, match + mismatch.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the SDK builder + poseidon init so the helper runs without wasm; stub telemetry to spy.
const hoisted = vi.hoisted(() => ({ buildShieldRequest: vi.fn() }))
vi.mock('@armada/sdk', () => ({
  buildShieldRequest: hoisted.buildShieldRequest,
  initPoseidonPromise: Promise.resolve(),
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), trackError: vi.fn() }))

import { runShieldDifferential } from './shield-differential'
import { track, trackError } from '@/lib/telemetry'
import type { ShieldRequestData } from './shield'

const NPK = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const SHIELD_KEY = ('0x' + 'cd'.repeat(32)) as `0x${string}`
const BUNDLE = ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64), '0x' + '3'.repeat(64)] as unknown as readonly [
  `0x${string}`, `0x${string}`, `0x${string}`,
]

const engineRequest: ShieldRequestData = {
  npk: NPK,
  value: 5_000_000n,
  encryptedBundle: BUNDLE,
  shieldKey: SHIELD_KEY,
  random: 'ef'.repeat(16),
}

const inputs = {
  railgunAddress: '0zk1qy' + 'a'.repeat(60),
  amount: 5_000_000n,
  tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  shieldPrivateKeyHex: '11'.repeat(32),
}

// A matching SDK build (differs only in the non-reproducible bundle, which the diff ignores).
const sdkResult = (over?: { npk?: string; value?: bigint; shieldKey?: string }) => ({
  shieldRequest: {
    preimage: {
      npk: over?.npk ?? NPK,
      token: { tokenType: 0, tokenAddress: inputs.tokenAddress, tokenSubID: 0n },
      value: over?.value ?? 5_000_000n,
    },
    ciphertext: {
      encryptedBundle: ['0x' + '9'.repeat(64), '0x' + '8'.repeat(64), '0x' + '7'.repeat(64)],
      shieldKey: over?.shieldKey ?? SHIELD_KEY,
    },
  },
  random: engineRequest.random,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runShieldDifferential', () => {
  it('feeds the SDK builder the engine random + key, and reports match when commitments agree', async () => {
    // WHY: the differential rests on injecting the SAME random — otherwise the commitment can never
    // match. Assert both the injection and the all-true telemetry.
    hoisted.buildShieldRequest.mockResolvedValue(sdkResult())
    await runShieldDifferential(engineRequest, inputs)

    expect(hoisted.buildShieldRequest).toHaveBeenCalledWith(
      { railgunAddress: inputs.railgunAddress, amount: inputs.amount, tokenAddress: inputs.tokenAddress },
      expect.any(Uint8Array),
      engineRequest.random,
    )
    expect(track).toHaveBeenCalledWith('sdk.shieldDiff', {
      npkMatch: true, valueMatch: true, shieldKeyMatch: true, match: true,
    })
  })

  it('reports match:false when the SDK npk diverges from the engine', async () => {
    // WHY: npk IS the on-chain commitment leaf — a divergence there means a different note. It must
    // surface as a failed differential, not pass silently.
    hoisted.buildShieldRequest.mockResolvedValue(sdkResult({ npk: '0x' + '00'.repeat(32) }))
    await runShieldDifferential(engineRequest, inputs)
    expect(track).toHaveBeenCalledWith('sdk.shieldDiff', {
      npkMatch: false, valueMatch: true, shieldKeyMatch: true, match: false,
    })
  })

  it('never throws into the caller — a builder error is reported via telemetry', async () => {
    // WHY: the differential is observe-only and must not fail the shield flow.
    hoisted.buildShieldRequest.mockRejectedValue(new Error('poseidon boom'))
    await expect(runShieldDifferential(engineRequest, inputs)).resolves.toBeUndefined()
    expect(trackError).toHaveBeenCalledWith('sdk.shieldDiff', expect.any(Error), expect.any(Object))
    expect(track).not.toHaveBeenCalled()
  })
})
