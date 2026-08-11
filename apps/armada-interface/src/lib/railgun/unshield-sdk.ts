// ABOUTME: SDK-backed unshield builder — planTransfer(unshield) → prove → toTransactionData → buildTransactCalldata,
// ABOUTME: returning the raw { to, data } the handler submits. The @armada/sdk analogue of lib/railgun/unshield.ts.

import { buildTransactCalldata } from '@armada/sdk'
import { getSdkWallet } from './sdk-read'

export interface SdkUnshieldInputs {
  /** EVM recipient of the unshielded USDC — funds leave the pool to this address. */
  readonly recipient: `0x${string}`
  readonly amount: bigint
  /** Broadcaster (relayer) fee note, or null for direct user submission (no fee output). */
  readonly broadcasterFee: { readonly amount: bigint; readonly recipientAddress: string } | null
  readonly poolAddress: `0x${string}`
  /** ZK-proof progress (0–1); the worker prover emits coarse start/end phases. */
  readonly onProgress?: (fraction: number) => void
}

/**
 * Build an unshield transaction via `@armada/sdk`: the wallet plans a transfer whose only public
 * output is the unshield (recipient EVM address, no shielded outputs), proves it (Groth16), and the
 * proved struct is serialized into `transact(...)` calldata. Returns `{ to, data }` (value is always
 * 0 — a shielded tx carries no native value; the USDC is paid out from the pool).
 *
 * The unshield is modelled inside `planTransfer` as `{ recipient, amount }` — the last output
 * commitment (a public `UnshieldNoteERC20`, npk = recipient), which the contract pays out on. No
 * shielded recipients, so `outputs` is empty; the broadcaster fee (when present) is the only shielded
 * output. Proving runs on the instance's worker prover.
 */
export async function buildUnshieldSdk(
  inputs: SdkUnshieldInputs,
): Promise<{ to: `0x${string}`; data: `0x${string}` }> {
  const wallet = await getSdkWallet()
  // planTransfer reads only `schedule.transfer` + `broadcasterShieldedAddress`; `feesCacheId`/`expiresAt`
  // are part of the FeeQuote contract but unused here (the quote's staleness is the relayer's concern).
  const fee = inputs.broadcasterFee
    ? {
        schedule: { transfer: inputs.broadcasterFee.amount.toString() },
        broadcasterShieldedAddress: inputs.broadcasterFee.recipientAddress,
        feesCacheId: '',
        expiresAt: 0,
      }
    : { schedule: { transfer: '0' }, broadcasterShieldedAddress: '', feesCacheId: '', expiresAt: 0 }

  const plan = await wallet.planTransfer({
    outputs: [],
    unshield: { recipient: inputs.recipient, amount: inputs.amount },
    fee,
  })
  const handle = await wallet.prove(
    plan,
    inputs.onProgress ? { onProgress: (p) => inputs.onProgress?.(p.fraction) } : undefined,
  )
  const { to, data } = buildTransactCalldata([handle.toTransactionData()], inputs.poolAddress)
  return { to, data }
}
