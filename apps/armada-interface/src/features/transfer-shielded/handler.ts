// ABOUTME: Transfer-shielded stage handler — 0zk → 0zk private send. Relayer-mediated submit (A4); zero EVM wallet prompts.
// ABOUTME: Build-proof with broadcaster fee → POST /relay → poll /status → hub-confirmed. Mirrors features/unshield/handler.ts pattern.

import { sendTransaction } from 'wagmi/actions'
import { loadDeployments } from '@/config/deployments'
import { getNetworkConfig } from '@/config/network'
import { wagmiConfig } from '@/config/wagmi'
import { ensureChain } from '@/lib/network-switch'
import { waitForReceiptOrFail } from '@/lib/tx/receipt'
import {
  getSdkEncryptionKey as kmGetSdkEncryptionKey,
  getWalletId as kmGetWalletId,
  isUnlocked as kmIsUnlocked,
} from '@/lib/railgun/keyManager'
import { refreshShieldedBalances } from '@/lib/railgun/sync'
import {
  generateTransferProofForRecipient,
  populateTransferTransaction,
  type BroadcasterFeeRecipient,
} from '@/lib/railgun/transfer'
import { submitRelay, RelayerError } from '@/lib/relayer'
import { advance, markFailed } from '@/lib/tx/reducer'
import { recordBroadcastHash } from '@/lib/tx/broadcast'
import { poll, pollRelayStatusOnce } from '@/lib/tx/poller'
import { classifyHandlerError } from '@/lib/tx/errors'
import { createProofProgressWriter } from '@/lib/tx/progress'
import { track } from '@/lib/telemetry'
import type { StageHandler } from '@/lib/tx/executor'
import type { TxError, TxRecord } from '@/lib/tx/types'

/**
 * `transfer-shielded` stages (Phase A4 — relayer-mediated):
 *   1. `build-proof`    — generate the Groth16 transfer proof with broadcaster fee baked in
 *                          (~20-30s on local Anvil). The proof embeds a USDC output to the
 *                          relayer's 0zk address at the advertised fee amount.
 *   2. `submit-relayer` — populate `transact()` calldata, POST to relayer's `/relay`, poll
 *                          `/status` until confirmed (or failed).
 *   3. `hub-confirmed`  — terminal. Kicks a balance refresh.
 *
 * No EVM wallet signature anywhere — proof generation uses the shielded wallet's spending key
 * (`keyManager`); the relayer broadcasts and pays gas in ETH, claiming reimbursement via the
 * embedded broadcaster output. Recipient is a 0zk address (encrypted UTXO bundle).
 */
export const transferShieldedHandler: StageHandler<'transfer-shielded'> = {
  kind: 'transfer-shielded',
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
      // hub-confirmed is terminal; defensive no-op for resume-on-load.
    } catch (err) {
      if (ctx.signal.aborted) return
      const failed = markFailed(record, classifyHandlerError(err, 'Private send failed.', record.artifacts.sourceTxHash))
      await ctx.upsert(failed)
    }
  },
}

/** A6 — see comment in features/unshield/handler.ts::broadcasterFeeFromRecord. */
function broadcasterFeeFromRecord(
  record: TxRecord<'transfer-shielded'>,
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
  record: TxRecord<'transfer-shielded'>,
  ctx: Parameters<typeof transferShieldedHandler.run>[1],
): Promise<void> {
  if (!kmIsUnlocked()) {
    throw new Error('Private send requires an unlocked shielded wallet.')
  }
  const walletId = kmGetWalletId()
  const encryptionKey = kmGetSdkEncryptionKey()
  const deployments = await loadDeployments()
  const tokenAddress = deployments.hub.cctp.usdc

  if (ctx.signal.aborted) throw new Error('cancelled')

  const progress = createProofProgressWriter(record, ctx.signal)
  await generateTransferProofForRecipient({
    walletId,
    encryptionKey,
    tokenAddress,
    recipient: record.meta.recipient,
    amount: record.meta.amount,
    broadcasterFee: broadcasterFeeFromRecord(record, tokenAddress),
    onProgress: progress.write,
  })

  if (ctx.signal.aborted) throw new Error('cancelled')

  const next = advance(progress.latest(), 'submit-relayer')
  await ctx.upsert(next)
}

async function runSubmitAndConfirm(
  record: TxRecord<'transfer-shielded'>,
  ctx: Parameters<typeof transferShieldedHandler.run>[1],
): Promise<void> {
  if (!kmIsUnlocked()) {
    throw new Error('Private send requires an unlocked shielded wallet.')
  }
  const walletId = kmGetWalletId()
  const deployments = await loadDeployments()
  const tokenAddress = deployments.hub.cctp.usdc
  const hubChainId = getNetworkConfig().hub.chainId

  const populated = await populateTransferTransaction({
    walletId,
    tokenAddress,
    recipient: record.meta.recipient,
    amount: record.meta.amount,
    broadcasterFee: broadcasterFeeFromRecord(record, tokenAddress),
  })
  if (ctx.signal.aborted) throw new Error('cancelled')

  // A6 wallet-override path — submit through the user's EVM wallet instead of the relayer.
  // The proof has no broadcaster output (sendWithPublicWallet=true on the SDK side), so the
  // verifier would reject; we go direct. Terminal state is identical to the relayer path.
  if (record.meta.useWalletOverride) {
    await ensureChain(hubChainId)
    if (ctx.signal.aborted) throw new Error('cancelled')
    const hash = await sendTransaction(wagmiConfig, {
      to: populated.to,
      data: populated.data,
      value: populated.value,
    })
    const broadcast = await recordBroadcastHash(record, hash, ctx)
    if (broadcast.dismissed) return
    const broadcastRecord = broadcast.record
    await waitForReceiptOrFail({ hash, signal: ctx.signal })
    if (kmIsUnlocked()) {
      void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
    }
    const completed = advance(broadcastRecord, 'hub-confirmed', { sourceTxHash: hash })
    await ctx.upsert(completed)
    return
  }

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

  const broadcast = await recordBroadcastHash(record, submitResponse.txHash as `0x${string}`, ctx)
  if (broadcast.dismissed) return
  const broadcastRecord = broadcast.record

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

  track('tx.relayer.confirmed', { id: record.id, kind: record.kind })

  if (kmIsUnlocked()) {
    void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
  }

  const completed = advance(broadcastRecord, 'hub-confirmed', {
    sourceTxHash: submitResponse.txHash as `0x${string}`,
  })
  await ctx.upsert(completed)
}
