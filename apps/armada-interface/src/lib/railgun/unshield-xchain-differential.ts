// ABOUTME: Cross-chain unshield write-path differential — builds the atomicCrossChainUnshield calldata via
// ABOUTME: @armada/sdk and validates it by SIMULATING against the pool (the on-chain verifier is the arbiter). Observe-only.

import { simulateOrThrow } from '@/lib/tx/simulate'
import { track, trackError } from '@/lib/telemetry'
import { buildXchainUnshieldSdk, type SdkXchainUnshieldInputs } from './unshield-xchain-sdk'

/**
 * Opt-in gate (`VITE_SHADOW_SDK=1`) — NOT dev-default, because the differential runs a full Groth16
 * proof on top of the engine's own. You turn it on to validate, not for every dev unshield. Retired
 * once the cross-chain unshield cutover lands.
 */
export function xchainUnshieldDifferentialEnabled(): boolean {
  return import.meta.env.VITE_SHADOW_SDK === '1'
}

/**
 * Build the cross-chain unshield with `@armada/sdk` (plan with CCTP-binding adaptParams → prove →
 * encode `atomicCrossChainUnshield`) and validate it by `eth_call`-simulating the calldata against the
 * PrivacyPool on the hub. If the contract accepts it, the SDK produced a valid, submittable exit — the
 * proof, nullifiers, merkleRoot, and the adaptParams↔args binding (#399) all verify on-chain. A
 * proof-carrying tx can't be byte-compared to the engine's, so simulation is the correctness signal.
 *
 * Observe-only: never submits — the engine's build/submit runs unchanged alongside this. Never throws
 * into the caller; emits one `sdk.xchainUnshieldDiff { simulated }` line per invocation.
 */
export async function runXchainUnshieldDifferential(
  inputs: SdkXchainUnshieldInputs & { readonly from: `0x${string}`; readonly chainId: number },
): Promise<void> {
  try {
    const { to, data } = await buildXchainUnshieldSdk(inputs)
    try {
      await simulateOrThrow({ to, data, value: 0n, account: inputs.from, chainId: inputs.chainId })
      track('sdk.xchainUnshieldDiff', { simulated: true })
    } catch (simErr) {
      // The SDK built calldata but the contract rejected it — the load-bearing failure signal.
      track('sdk.xchainUnshieldDiff', { simulated: false })
      trackError('sdk.xchainUnshieldDiff.simulate', simErr, { scope: 'shielded.unshield', message: 'sdk xchain unshield failed on-chain simulation' })
    }
  } catch (err) {
    // The SDK build itself failed (plan/prove/encode) — never surfaced to the unshield flow.
    trackError('sdk.xchainUnshieldDiff.build', err, { scope: 'shielded.unshield', message: 'sdk xchain unshield build failed' })
  }
}
