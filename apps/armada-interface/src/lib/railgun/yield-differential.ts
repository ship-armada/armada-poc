// ABOUTME: Yield write-path differential — builds the lendAndShield/redeemAndShield calldata via @armada/sdk
// ABOUTME: and validates it by SIMULATING against the adapter (the on-chain verifier is the arbiter). Observe-only.

import { simulateOrThrow } from '@/lib/tx/simulate'
import { track, trackError } from '@/lib/telemetry'
import { buildYieldAdaptSdk, type SdkYieldInputs } from './yield-sdk'

/**
 * Opt-in gate (`VITE_SHADOW_SDK=1`) — NOT dev-default, because the differential runs a full Groth16
 * proof on top of the engine's own. You turn it on to validate, not for every dev yield op. Retired
 * once the yield cutover lands.
 */
export function yieldDifferentialEnabled(): boolean {
  return import.meta.env.VITE_SHADOW_SDK === '1'
}

/**
 * Build the yield op with `@armada/sdk` (plan unshield-to-adapter + re-shield-bundle adaptParams →
 * prove → encode lendAndShield/redeemAndShield) and validate it by `eth_call`-simulating the calldata
 * against the adapter. If the contract accepts it, the SDK produced a valid op — the proof, nullifiers,
 * merkleRoot, and the adaptParams↔re-shield-bundle binding all verify on-chain. A proof-carrying tx
 * can't be byte-compared to the engine's, so simulation is the correctness signal.
 *
 * Observe-only: never submits. Never throws into the caller; emits one `sdk.yieldDiff { mode, simulated }`.
 */
export async function runYieldDifferential(
  inputs: SdkYieldInputs & { readonly from: `0x${string}`; readonly chainId: number },
): Promise<void> {
  try {
    const { to, data } = await buildYieldAdaptSdk(inputs)
    try {
      await simulateOrThrow({ to, data, value: 0n, account: inputs.from, chainId: inputs.chainId })
      track('sdk.yieldDiff', { mode: inputs.mode, simulated: true })
    } catch (simErr) {
      // The SDK built calldata but the adapter rejected it — the load-bearing failure signal.
      // trackError computes `message` from the error itself (the decoded revert reason) and spreads
      // props AFTER it, so props must NOT carry `scope`/`message` or they clobber the real revert.
      track('sdk.yieldDiff', { mode: inputs.mode, simulated: false })
      trackError('sdk.yieldDiff.simulate', simErr, { mode: inputs.mode })
    }
  } catch (err) {
    // The SDK build itself failed (plan/prove/bundle/encode) — never surfaced to the yield flow.
    trackError('sdk.yieldDiff.build', err, { mode: inputs.mode })
  }
}
