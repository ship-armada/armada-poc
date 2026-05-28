// ABOUTME: Unshield-local stage handler — build-proof (with broadcaster fee) → submit-relayer (POST /relay) → poll status → hub-confirmed.
// ABOUTME: Phase A3 — first relayer-mediated handler. Zero EVM wallet prompts; tx broadcast + gas paid by the relayer; status tracked via /status polling.

import { loadDeployments } from '@/config/deployments'
import { getNetworkConfig } from '@/config/network'
import {
  getSdkEncryptionKey as kmGetSdkEncryptionKey,
  getWalletId as kmGetWalletId,
  isUnlocked as kmIsUnlocked,
} from '@/lib/railgun/keyManager'
import { refreshShieldedBalances } from '@/lib/railgun/sync'
import {
  generateUnshieldProofForRecipient,
  populateUnshieldTransaction,
} from '@/lib/railgun/unshield'
import { submitRelay, RelayerError } from '@/lib/relayer'
import { advance, markFailed, patchArtifacts } from '@/lib/tx/reducer'
import { poll, pollRelayStatusOnce } from '@/lib/tx/poller'
import { classifyHandlerError } from '@/lib/tx/errors'
import { createProofProgressWriter } from '@/lib/tx/progress'
import { track } from '@/lib/telemetry'
import type { StageHandler } from '@/lib/tx/executor'
import type { TxError, TxRecord } from '@/lib/tx/types'

/**
 * `unshield-local` stages (Phase A3 — relayer-mediated):
 *   1. `build-proof`    — generate the Groth16 unshield proof with broadcaster fee baked in
 *                          (~20-30s on local Anvil). The proof embeds a USDC output to the
 *                          relayer's 0zk address at the advertised fee amount.
 *   2. `submit-relayer` — populate `transact()` calldata, POST `{chainId, to, data, feesCacheId}`
 *                          to the relayer's `/relay`, get a txHash, poll `/status` until
 *                          confirmed (or failed).
 *   3. `hub-confirmed`  — terminal. Kicks a balance refresh so the UI updates immediately.
 *
 * No EVM wallet signature anywhere — proof generation uses the shielded wallet's spending key
 * (`keyManager`); the relayer broadcasts on the user's behalf and pays gas in ETH, claiming
 * reimbursement via the embedded broadcaster output.
 */
export const unshieldLocalHandler: StageHandler<'unshield-local'> = {
  kind: 'unshield-local',
  resumableFrom: ['submit-relayer'],

  async run(record, ctx) {
    try {
      if (record.stage === 'build-proof') {
        await runBuildProof(record, ctx)
        return
      }
      if (record.stage === 'submit-relayer') {
        await runSubmitAndConfirm(record, ctx)
        return
      }
      // hub-confirmed is terminal; advance() flips executionState to 'completed' so the executor
      // loop won't re-enter this handler. Defensive no-op for resume-on-load.
    } catch (err) {
      // Abort-during-handler path: if the user cancelled (or the executor dismissed) we've
      // already written the terminal cancelled/dismissed state via abortAndMark / dismissTx.
      // Returning without upserting prevents us from clobbering it with a failed record (OCC
      // would silently drop the write anyway; explicit return is clearer + avoids a misleading
      // telemetry event).
      if (ctx.signal.aborted) return
      const failed = markFailed(record, classifyHandlerError(err, 'Unshield failed.', record.artifacts.sourceTxHash))
      await ctx.upsert(failed)
    }
  },
}

async function runBuildProof(
  record: TxRecord<'unshield-local'>,
  ctx: Parameters<typeof unshieldLocalHandler.run>[1],
): Promise<void> {
  if (!kmIsUnlocked()) {
    throw new Error('Unshield requires an unlocked shielded wallet.')
  }
  const walletId = kmGetWalletId()
  const encryptionKey = kmGetSdkEncryptionKey()
  const deployments = await loadDeployments()
  const tokenAddress = deployments.hub.cctp.usdc

  if (ctx.signal.aborted) throw new Error('cancelled')

  const progress = createProofProgressWriter(record)
  await generateUnshieldProofForRecipient({
    walletId,
    encryptionKey,
    tokenAddress,
    recipient: record.meta.recipient,
    amount: record.meta.amount,
    // Broadcaster fee baked into the proof — the relayer's verifier reads it back from
    // the on-the-wire calldata at /relay time and refuses to submit if it's short.
    broadcasterFee: {
      tokenAddress,
      amount: record.meta.broadcasterFeeAmount,
      recipientAddress: record.meta.broadcasterRailgunAddress,
    },
    onProgress: progress.write,
  })

  if (ctx.signal.aborted) throw new Error('cancelled')

  // Advance from the LIVE record (progress bumps bumped updatedSeq). Using the original
  // `record` param here would hit upsertTxAtom's OCC guard and drop the transition silently.
  const next = advance(progress.latest(), 'submit-relayer')
  await ctx.upsert(next)
}

async function runSubmitAndConfirm(
  record: TxRecord<'unshield-local'>,
  ctx: Parameters<typeof unshieldLocalHandler.run>[1],
): Promise<void> {
  if (!kmIsUnlocked()) {
    throw new Error('Unshield requires an unlocked shielded wallet.')
  }
  const walletId = kmGetWalletId()
  const deployments = await loadDeployments()
  const tokenAddress = deployments.hub.cctp.usdc
  const hubChainId = getNetworkConfig().hub.chainId

  // Re-populate must use the EXACT same args as the proof (the SDK's in-memory proof cache is
  // keyed by them; mismatched broadcasterFee throws "proof not found"). Reading from meta keeps
  // the values immutable across resumes-after-crash.
  const populated = await populateUnshieldTransaction({
    walletId,
    tokenAddress,
    recipient: record.meta.recipient,
    amount: record.meta.amount,
    broadcasterFee: {
      tokenAddress,
      amount: record.meta.broadcasterFeeAmount,
      recipientAddress: record.meta.broadcasterRailgunAddress,
    },
  })
  if (ctx.signal.aborted) throw new Error('cancelled')

  // Hand the populated calldata to the relayer. The relayer's pre-submit pipeline validates the
  // selector + decrypts the embedded broadcaster output + checks the amount against its
  // advertised fee for `transact()` (PR A2). Failure modes surface as typed RelayerError:
  //   FEE_INSUFFICIENT — proof's broadcaster output below advertised (drift between modal quote
  //                       and relayer; user should re-quote and re-submit).
  //   FEE_EXPIRED       — the cacheId is no longer current (modal validates before submit, but
  //                       slow proof generation can race past the TTL).
  //   GAS_ESTIMATION_FAILED — the tx would revert on-chain; the relayer's RPC eth_estimateGas
  //                            saw the revert and refused to broadcast.
  //   SUBMISSION_FAILED — the relayer's wallet couldn't broadcast (nonce, RPC down, etc.).
  let submitResponse
  try {
    submitResponse = await submitRelay(
      {
        chainId: hubChainId,
        to: populated.to,
        data: populated.data,
        feesCacheId: record.meta.feeCacheId,
      },
      ctx.signal,
    )
  } catch (err) {
    if (err instanceof RelayerError) {
      track('tx.relayer.rejected', { id: record.id, kind: record.kind, errorCode: err.code })
    }
    throw err
  }

  track('tx.relayer.submitted', { id: record.id, kind: record.kind })

  // Persist the txHash before the polling loop so cancel/dismiss after this point carries the
  // hash forward into the dismissed-with-explorer-link UX. Threading the patched record forward
  // matters: `record` is now stale (lower updatedSeq than the atom/IDB) and a later advance from
  // it would equal-seq write that OCC silently drops, leaving the executor looping here.
  const broadcastRecord = patchArtifacts(record, { sourceTxHash: submitResponse.txHash as `0x${string}` })
  await ctx.upsert(broadcastRecord)
  if (ctx.signal.aborted) throw new Error('cancelled')

  // Poll the relayer's /status until terminal. The adapter returns null while pending (loop keeps
  // waiting) and the full StatusResponse once confirmed/failed. The generic poll loop handles
  // jittered backoff + abort propagation; we just branch on the returned status.
  const pollResult = await poll(
    (signal) => pollRelayStatusOnce(submitResponse.txHash, signal),
    { signal: ctx.signal },
  )

  if (pollResult.status === 'aborted') throw new Error('cancelled')
  if (pollResult.status === 'timeout') {
    const error: TxError = {
      code: 'POLL_TIMEOUT',
      message:
        'The relayer hasn\'t reported a final status. The transaction may still complete on chain — check the explorer.',
      txHash: submitResponse.txHash as `0x${string}`,
    }
    const failed = markFailed(broadcastRecord, error)
    await ctx.upsert(failed)
    return
  }

  const final = pollResult.value
  if (!final) {
    // poll() returns 'done' only when pollOnce returns a non-null value. Defensive guard for
    // the contract; should never fire.
    throw new Error('poll returned done without a status value')
  }

  if (final.status === 'failed') {
    track('tx.relayer.rejected', { id: record.id, kind: record.kind, errorCode: 'EXECUTION_FAILED' })
    const error: TxError = {
      code: 'TX_REVERTED',
      message: final.error ?? 'Relayer-broadcast tx reverted on chain.',
      txHash: submitResponse.txHash as `0x${string}`,
    }
    const failed = markFailed(broadcastRecord, error)
    await ctx.upsert(failed)
    return
  }

  // status === 'confirmed'
  track('tx.relayer.confirmed', { id: record.id, kind: record.kind })

  // Kick an immediate balance refresh — same fire-and-forget pattern as the shield handler.
  // The relayer's broadcast cleared the user's old commitments + planted the new change UTXO.
  if (kmIsUnlocked()) {
    void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
  }

  const completed = advance(broadcastRecord, 'hub-confirmed', {
    sourceTxHash: submitResponse.txHash as `0x${string}`,
  })
  await ctx.upsert(completed)
}
