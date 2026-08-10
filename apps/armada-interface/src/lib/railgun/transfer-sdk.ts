// ABOUTME: SDK-backed shielded-transfer builder — planTransfer → prove → toTransactionData → buildTransactCalldata,
// ABOUTME: returning the raw { to, data } the handler submits. The @armada/sdk analogue of lib/railgun/transfer.ts.

import { buildTransactCalldata } from '@armada/sdk'
import { getSdkWallet } from './sdk-read'

export interface SdkTransferInputs {
  /** 0zk recipient of the transfer. */
  readonly recipient: string
  readonly amount: bigint
  /** Broadcaster (relayer) fee note, or null for direct user submission (no fee output). */
  readonly broadcasterFee: { readonly amount: bigint; readonly recipientAddress: string } | null
  readonly poolAddress: `0x${string}`
}

/**
 * Build a shielded-transfer transaction via `@armada/sdk`: the wallet plans the transfer over its
 * spendable notes, proves it (Groth16), and the proved struct is serialized into `transact(...)`
 * calldata. Returns `{ to, data }` (value is always 0 — a shielded tx carries no native value).
 *
 * Proving runs on the instance's prover (same-thread today; worker follow-on). The caller decides
 * whether to submit the result or (differential) only simulate it.
 */
export async function buildTransferSdk(
  inputs: SdkTransferInputs,
): Promise<{ to: `0x${string}`; data: `0x${string}` }> {
  const wallet = await getSdkWallet()
  // planTransfer reads only `schedule.transfer` + `broadcasterRailgunAddress`; `feesCacheId`/`expiresAt`
  // are part of the FeeQuote contract but unused here (the quote's staleness is the relayer's concern).
  const fee = inputs.broadcasterFee
    ? {
        schedule: { transfer: inputs.broadcasterFee.amount.toString() },
        broadcasterRailgunAddress: inputs.broadcasterFee.recipientAddress,
        feesCacheId: '',
        expiresAt: 0,
      }
    : { schedule: { transfer: '0' }, broadcasterRailgunAddress: '', feesCacheId: '', expiresAt: 0 }

  const plan = await wallet.planTransfer({
    outputs: [{ to0zk: inputs.recipient, amount: inputs.amount }],
    fee,
  })
  const handle = await wallet.prove(plan)
  const { to, data } = buildTransactCalldata([handle.toTransactionData()], inputs.poolAddress)
  return { to, data }
}
