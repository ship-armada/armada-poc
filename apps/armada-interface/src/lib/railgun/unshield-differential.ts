// ABOUTME: Unshield write-path differential — builds the unshield via @armada/sdk and validates it by
// ABOUTME: SIMULATING the calldata against the pool (the on-chain verifier is the arbiter). Observe-only: never submits.

import { simulateOrThrow } from '@/lib/tx/simulate'
import { track, trackError } from '@/lib/telemetry'
import { buildUnshieldSdk, type SdkUnshieldInputs } from './unshield-sdk'

/**
 * Opt-in gate (`VITE_SHADOW_SDK=1`) — NOT dev-default, because the differential runs a full Groth16
 * proof on top of the engine's own. You turn it on to validate, not for every dev unshield. Retired
 * once the unshield cutover lands.
 */
export function unshieldDifferentialEnabled(): boolean {
  return import.meta.env.VITE_SHADOW_SDK === '1'
}

/**
 * Build the unshield with `@armada/sdk` (plan → prove → calldata) and validate it by `eth_call`-simulating
 * the calldata against the PrivacyPool — if the contract accepts it, the SDK produced a valid, submittable
 * unshield (proof + nullifiers + merkleRoot + boundParams + unshield preimage all verify on-chain). A
 * proof-carrying tx can't be byte-compared to the engine (random salts + non-deterministic proof +
 * independent note selection), so simulation is the correctness signal.
 *
 * Observe-only: never submits — the engine's build/submit runs unchanged alongside this. Never throws into
 * the caller; emits one `sdk.unshieldDiff { simulated }` line per invocation.
 */
export async function runUnshieldDifferential(
  inputs: SdkUnshieldInputs & { readonly from: `0x${string}`; readonly chainId: number },
): Promise<void> {
  try {
    const { to, data } = await buildUnshieldSdk(inputs)
    try {
      await simulateOrThrow({ to, data, value: 0n, account: inputs.from, chainId: inputs.chainId })
      track('sdk.unshieldDiff', { simulated: true })
    } catch (simErr) {
      // The SDK built calldata but the contract rejected it — the load-bearing failure signal.
      track('sdk.unshieldDiff', { simulated: false })
      trackError('sdk.unshieldDiff.simulate', simErr, { scope: 'shielded.unshield', message: 'sdk unshield failed on-chain simulation' })
    }
  } catch (err) {
    // The SDK build itself failed (plan/prove/artifacts) — never surfaced to the unshield flow.
    trackError('sdk.unshieldDiff.build', err, { scope: 'shielded.unshield', message: 'sdk unshield build failed' })
  }
}
