// ABOUTME: Shield write-path differential — rebuilds the ShieldRequest with @armada/sdk (same shieldPrivateKey + engine's random)
// ABOUTME: and telemetry-reports commitment parity vs the engine. Read-only: the SDK note is compared then discarded, never submitted.

import { buildShieldRequest, initPoseidonPromise } from '@armada/sdk'
import { track, trackError } from '@/lib/telemetry'
import type { ShieldRequestData } from './shield'

/**
 * Dev / opt-in gate. The differential is observe-only (builds a second request, compares, discards —
 * never submits), so it's safe to run on every shield in dev; opt in elsewhere via VITE_SHADOW_SDK=1.
 */
export function shieldDifferentialEnabled(): boolean {
  return import.meta.env.MODE === 'development' || import.meta.env.VITE_SHADOW_SDK === '1'
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Rebuild the shield note with `@armada/sdk` from the SAME inputs the engine used — including the
 * engine's `random` salt — and compare the deterministic **commitment** fields (`npk`, `value`,
 * `shieldKey`). The `encryptedBundle` is deliberately excluded: it uses a fresh AES-GCM IV per call,
 * so it is not byte-reproducible (its correctness property is decryptability, covered by the SDK's
 * own tests — not byte-equality). A commitment match means the SDK builds the identical on-chain
 * shield leaf as the engine.
 *
 * Read-only + never throws into the caller: a differential error is reported via telemetry, not
 * surfaced to the shield flow. Emits one `sdk.shieldDiff` line per invocation.
 */
export async function runShieldDifferential(
  engineRequest: ShieldRequestData,
  inputs: { railgunAddress: string; amount: bigint; tokenAddress: string; shieldPrivateKeyHex: string },
): Promise<void> {
  try {
    await initPoseidonPromise
    const { shieldRequest } = await buildShieldRequest(
      { railgunAddress: inputs.railgunAddress, amount: inputs.amount, tokenAddress: inputs.tokenAddress },
      hexToBytes(inputs.shieldPrivateKeyHex),
      engineRequest.random,
    )
    const npkMatch = shieldRequest.preimage.npk.toLowerCase() === engineRequest.npk.toLowerCase()
    const valueMatch = shieldRequest.preimage.value === engineRequest.value
    const shieldKeyMatch = shieldRequest.ciphertext.shieldKey.toLowerCase() === engineRequest.shieldKey.toLowerCase()
    track('sdk.shieldDiff', {
      npkMatch,
      valueMatch,
      shieldKeyMatch,
      match: npkMatch && valueMatch && shieldKeyMatch,
    })
  } catch (err) {
    trackError('sdk.shieldDiff', err, { scope: 'shielded.balance', message: 'shield differential failed' })
  }
}
