// ABOUTME: Transfer write-path differential — builds the transfer via @armada/sdk and validates it by
// ABOUTME: SIMULATING the calldata against the pool (the on-chain verifier is the arbiter). Observe-only: never submits.

import { simulateOrThrow } from '@/lib/tx/simulate'
import { track, trackError } from '@/lib/telemetry'
import { buildTransferSdk, type SdkTransferInputs } from './transfer-sdk'

/**
 * Opt-in gate (`VITE_SHADOW_SDK=1`) — NOT dev-default, because the differential runs a full Groth16
 * proof (a 20-30s same-thread block on top of the engine's own). You turn it on to validate, not for
 * every dev transfer. Retired once the transfer cutover lands (and made cheap by the worker prover).
 */
export function transferDifferentialEnabled(): boolean {
  return import.meta.env.VITE_SHADOW_SDK === '1'
}

/**
 * Build the transfer with `@armada/sdk` (plan → prove → calldata) and validate it by `eth_call`-simulating
 * the calldata against the PrivacyPool — if the contract accepts it, the SDK produced a valid, submittable
 * transfer (proof + nullifiers + merkleRoot + boundParams all verify on-chain). A proof-carrying tx can't
 * be byte-compared to the engine (random salts + non-deterministic proof + independent note selection), so
 * simulation is the correctness signal.
 *
 * Observe-only: never submits — the engine's build/submit runs unchanged alongside this. Never throws into
 * the caller; emits one `sdk.transferDiff { simulated }` line per invocation.
 */
export async function runTransferDifferential(
  inputs: SdkTransferInputs & { readonly from: `0x${string}`; readonly chainId: number },
): Promise<void> {
  try {
    const { to, data } = await buildTransferSdk(inputs)
    try {
      await simulateOrThrow({ to, data, value: 0n, account: inputs.from, chainId: inputs.chainId })
      track('sdk.transferDiff', { simulated: true })
    } catch (simErr) {
      // The SDK built calldata but the contract rejected it — the load-bearing failure signal.
      track('sdk.transferDiff', { simulated: false })
      trackError('sdk.transferDiff.simulate', simErr, { scope: 'shielded.transfer', message: 'sdk transfer failed on-chain simulation' })
    }
  } catch (err) {
    // The SDK build itself failed (plan/prove/artifacts) — never surfaced to the transfer flow.
    trackError('sdk.transferDiff.build', err, { scope: 'shielded.transfer', message: 'sdk transfer build failed' })
  }
}
