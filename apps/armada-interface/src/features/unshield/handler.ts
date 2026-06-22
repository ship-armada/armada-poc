// ABOUTME: Unshield-local stage handler — build-proof (with broadcaster fee) → submit-relayer (POST /relay) → poll status → hub-confirmed.
// ABOUTME: Phase A3 — first relayer-mediated handler. Zero EVM wallet prompts; tx broadcast + gas paid by the relayer; status tracked via /status polling.

import { sendTransaction } from 'wagmi/actions'
import { loadDeployments } from '@/config/deployments'
import { getNetworkConfig } from '@/config/network'
import { wagmiConfig } from '@/config/wagmi'
import { ensureChain } from '@/lib/network-switch'
import { waitForReceiptOrFail } from '@/lib/tx/receipt'
import { simulateOrThrow } from '@/lib/tx/simulate'
import {
  getSdkEncryptionKey as kmGetSdkEncryptionKey,
  getWalletId as kmGetWalletId,
  isUnlocked as kmIsUnlocked,
} from '@/lib/railgun/keyManager'
import { refreshShieldedBalances } from '@/lib/railgun/sync'
import {
  generateUnshieldProofForRecipient,
  populateUnshieldTransaction,
  type BroadcasterFeeRecipient,
} from '@/lib/railgun/unshield'
import { submitRelay } from '@/lib/relayer'
import { handleRelaySubmitError } from '@/lib/tx/relaySubmit'
import { advance, markFailed } from '@/lib/tx/reducer'
import { recordBroadcastHash } from '@/lib/tx/broadcast'
import { poll, pollBudgetMs, pollRelayStatusOnce } from '@/lib/tx/poller'
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
      const failed = markFailed(record, classifyHandlerError(err, 'Unshield failed.', record.artifacts.sourceTxHash, getNetworkConfig().hub.chainId))
      await ctx.upsert(failed)
    }
  },
}

/**
 * Compute the broadcasterFee argument for proof generation + population. Returns null when the
 * record was created with the A6 wallet-override flag set, so the proof is built for direct EVM
 * submit; otherwise returns the broadcaster context baked into the record's meta at submit-time.
 * Centralised here because BOTH the proof step AND the populate step must pass identical values
 * — the SDK's in-memory proof cache is keyed by it.
 */
function broadcasterFeeFromRecord(
  record: TxRecord<'unshield-local'>,
  tokenAddress: string,
): BroadcasterFeeRecipient | null {
  if (record.meta.useWalletOverride) return null
  return {
    tokenAddress,
    amount: record.meta.broadcasterFeeAmount,
    recipientAddress: record.meta.broadcasterRailgunAddress,
  }
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

  const progress = createProofProgressWriter(record, ctx.signal)
  await generateUnshieldProofForRecipient({
    walletId,
    encryptionKey,
    tokenAddress,
    recipient: record.meta.recipient,
    amount: record.meta.amount,
    // A6: null when wallet-override is set → SDK builds a proof without a broadcaster output
    // (sendWithPublicWallet=true on the SDK side, no extra unshield commitment to the relayer).
    broadcasterFee: broadcasterFeeFromRecord(record, tokenAddress),
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
  const hubChainId = getNetworkConfig().hub.chainId
  const existingHash = record.artifacts.sourceTxHash

  // Re-populate the proof calldata only when we still need to broadcast. On re-entry (Retry after
  // a POLL_TIMEOUT / resume-on-reload) the hash is already persisted; re-populating is pointless
  // and would throw anyway — the SDK's in-memory proof cache doesn't survive a reload. (P0-1)
  let populated: Awaited<ReturnType<typeof populateUnshieldTransaction>> | undefined
  if (!existingHash) {
    const walletId = kmGetWalletId()
    const deployments = await loadDeployments()
    const tokenAddress = deployments.hub.cctp.usdc
    // Re-populate must use the EXACT same args as the proof (the SDK's in-memory proof cache is
    // keyed by them; mismatched broadcasterFee throws "proof not found"). Reading from meta keeps
    // the values immutable across resumes-after-crash.
    populated = await populateUnshieldTransaction({
      walletId,
      tokenAddress,
      recipient: record.meta.recipient,
      amount: record.meta.amount,
      broadcasterFee: broadcasterFeeFromRecord(record, tokenAddress),
    })
    if (ctx.signal.aborted) throw new Error('cancelled')
  }

  // A6 wallet-override path — bypass the relayer entirely and submit through the user's EVM
  // wallet. Builds the same populated calldata (just with a different proof shape), waits for
  // the receipt directly, and advances to the same `hub-confirmed` terminal stage so the rest
  // of the lifecycle (UI, history, balance refresh) is uniform across both paths.
  if (record.meta.useWalletOverride) {
    let hash = existingHash
    let broadcastRecord = record
    if (!hash) {
      const tx = populated!
      await ensureChain(hubChainId)
      if (ctx.signal.aborted) throw new Error('cancelled')
      // S-M8: pre-flight simulate so an on-chain revert surfaces as a typed PRE_FLIGHT_REVERT
      // ("nothing was sent") instead of MetaMask's opaque 30M-gas-fallback "gas limit too high".
      const sender = record.walletContext.evmAddress
      if (sender) {
        await simulateOrThrow({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          account: sender as `0x${string}`,
          chainId: hubChainId,
        })
        if (ctx.signal.aborted) throw new Error('cancelled')
      }
      hash = await sendTransaction(wagmiConfig, {
        to: tx.to,
        data: tx.data,
        value: tx.value,
        chainId: hubChainId,
      })
      const broadcast = await recordBroadcastHash(record, hash, ctx)
      if (broadcast.dismissed) return
      broadcastRecord = broadcast.record
    }
    await waitForReceiptOrFail({ hash, signal: ctx.signal, chainId: hubChainId })
    if (kmIsUnlocked()) {
      void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
    }
    const completed = advance(broadcastRecord, 'hub-confirmed', { sourceTxHash: hash })
    await ctx.upsert(completed)
    return
  }

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
  // Idempotency guard (P0-1): once the relayer accepted the POST we persist the returned txHash.
  // NEVER re-POST — a duplicate gets a 409 and surfaces a false failure. On re-entry skip to the
  // status poll for the known hash.
  let txHash = existingHash
  let broadcastRecord = record
  if (!txHash) {
    const tx = populated!
    let submitResponse
    try {
      submitResponse = await submitRelay(
        {
          chainId: hubChainId,
          to: tx.to,
          data: tx.data,
          feesCacheId: record.meta.feeCacheId,
        },
        ctx.signal,
      )
    } catch (err) {
      // T-M3/S-M1: recover an already-broadcast hash from a DUPLICATE_TX so we resume polling
      // instead of failing a tx the relayer already sent; non-recoverable errors rethrow.
      submitResponse = handleRelaySubmitError(err, { id: record.id, kind: record.kind })
    }

    track('tx.relayer.submitted', { id: record.id, kind: record.kind })

    // Persist the txHash before the polling loop so cancel/dismiss after this point carries the
    // hash forward into the dismissed-with-explorer-link UX, and so the guard above sees it on
    // re-entry. Threading the patched record forward matters: `record` is now stale (lower
    // updatedSeq than the atom/IDB) and a later advance from it would equal-seq write that OCC
    // silently drops, leaving the executor looping here.
    txHash = submitResponse.txHash as `0x${string}`
    const broadcast = await recordBroadcastHash(record, txHash, ctx)
    if (broadcast.dismissed) return
    broadcastRecord = broadcast.record
  }

  // Poll the relayer's /status until terminal. The adapter returns null while pending (loop keeps
  // waiting) and the full StatusResponse once confirmed/failed. The generic poll loop handles
  // jittered backoff + abort propagation; we just branch on the returned status.
  const pollResult = await poll(
    (signal) => pollRelayStatusOnce(txHash, signal, hubChainId),
    { signal: ctx.signal, timeoutMs: pollBudgetMs(record) },
  )

  if (pollResult.status === 'aborted') throw new Error('cancelled')
  if (pollResult.status === 'timeout') {
    const error: TxError = {
      code: 'POLL_TIMEOUT',
      message:
        'The relayer hasn\'t reported a final status. The transaction may still complete on chain — check the explorer.',
      txHash,
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
      txHash,
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
    sourceTxHash: txHash,
  })
  await ctx.upsert(completed)
}
