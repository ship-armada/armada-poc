// ABOUTME: Yield-deposit (lend) handler — single atomic adapt-proof tx with broadcaster fee → POST /relay → poll status. Relayer-mediated (A4).
// ABOUTME: Three stages: build-proof (~20-30s, embeds broadcaster output), submit-relayer (POST + status poll), hub-confirmed (balance refresh).

import { sendTransaction } from 'wagmi/actions'
import { loadDeployments, loadYieldDeployment } from '@/config/deployments'
import { getNetworkConfig } from '@/config/network'
import { wagmiConfig } from '@/config/wagmi'
import { ensureChain } from '@/lib/network-switch'
import { waitForReceiptOrFail } from '@/lib/tx/receipt'
import {
  getRailgunAddress as kmGetRailgunAddress,
  getSdkEncryptionKey as kmGetSdkEncryptionKey,
  getWalletId as kmGetWalletId,
  isUnlocked as kmIsUnlocked,
} from '@/lib/railgun/keyManager'
import { refreshShieldedBalances } from '@/lib/railgun/sync'
import { buildYieldAdaptTransaction, type BroadcasterFeeRecipient } from '@/lib/railgun/yield'
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
 * Lifecycle:
 *   build-proof    — CrossContractCalls proof (USDC → adapter → aUSDC re-shielded) with the
 *                    broadcaster-fee output baked in. Stashes the populated calldata into
 *                    `artifacts.yieldTx` so a resume after submit doesn't re-prove.
 *   submit-relayer — POST `lendAndShield(...)` calldata to `/relay`, poll `/status` until
 *                    terminal. Verifier on the relayer side decodes the wrapper to lift the
 *                    embedded Transaction, then checks the broadcaster output (see
 *                    relayer/lib/transact-shape.ts).
 *   hub-confirmed  — balance refresh; user's shielded ayUSDC balance ticks up.
 *
 * No EVM wallet signature anywhere — the relayer broadcasts. The user's shielded balance pays
 * the broadcaster fee as an extra proof output, NOT a separate ETH gas payment.
 */
export const yieldDepositHandler: StageHandler<'yield-deposit'> = {
  kind: 'yield-deposit',
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
      // hub-confirmed is terminal.
    } catch (err) {
      if (ctx.signal.aborted) return
      await ctx.upsert(markFailed(record, classifyHandlerError(err, 'Vault deposit failed.', record.artifacts.sourceTxHash)))
    }
  },
}

/** A6 — null when wallet-override, otherwise the broadcaster context from meta. */
function broadcasterFeeFromRecord(
  record: TxRecord<'yield-deposit'>,
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
  record: TxRecord<'yield-deposit'>,
  ctx: Parameters<typeof yieldDepositHandler.run>[1],
): Promise<void> {
  if (!kmIsUnlocked()) {
    throw new Error('Yield deposit requires an unlocked shielded wallet.')
  }
  const walletId = kmGetWalletId()
  const encryptionKey = kmGetSdkEncryptionKey()
  const railgunAddress = kmGetRailgunAddress()
  const deployments = await loadDeployments()
  const yieldDeployment = await loadYieldDeployment()
  if (!yieldDeployment) {
    throw new Error('Yield deployment manifest not found — run `npm run setup` to deploy yield contracts.')
  }
  const usdcAddress = deployments.hub.cctp.usdc
  const vaultAddress = yieldDeployment.contracts.armadaYieldVault
  const adapterAddress = yieldDeployment.contracts.armadaYieldAdapter

  if (ctx.signal.aborted) throw new Error('cancelled')

  const progress = createProofProgressWriter(record, ctx.signal)
  const built = await buildYieldAdaptTransaction({
    walletId,
    encryptionKey,
    mode: 'lend',
    unshieldToken: usdcAddress,
    shieldOutputToken: vaultAddress,
    amount: record.meta.amount,
    railgunAddress,
    adapterAddress,
    hubChainId: getNetworkConfig().hub.chainId,
    broadcasterFee: broadcasterFeeFromRecord(record, usdcAddress),
    onProgress: progress.write,
  })

  if (ctx.signal.aborted) throw new Error('cancelled')
  // Stash the populated calldata so submit-relayer skips re-proving. The SDK's
  // generateProofTransactions is stateless — without this, a resume after a transient relayer
  // error would pay the ~20-30s proving cost again.
  await ctx.upsert(advance(progress.latest(), 'submit-relayer', {
    yieldTx: {
      to: built.transaction.to,
      data: built.transaction.data,
      value: built.transaction.value.toString(),
    },
  }))
}

async function runSubmitAndConfirm(
  record: TxRecord<'yield-deposit'>,
  ctx: Parameters<typeof yieldDepositHandler.run>[1],
): Promise<void> {
  const yieldTx = record.artifacts.yieldTx
  if (!yieldTx) {
    throw new Error('Yield adapt-proof tx missing — re-run build-proof stage.')
  }
  const hubChainId = getNetworkConfig().hub.chainId

  // A6 wallet-override path — submit the wrapper calldata via the user's EVM wallet.
  if (record.meta.useWalletOverride) {
    await ensureChain(hubChainId)
    if (ctx.signal.aborted) throw new Error('cancelled')
    const hash = await sendTransaction(wagmiConfig, {
      to: yieldTx.to as `0x${string}`,
      data: yieldTx.data as `0x${string}`,
      value: BigInt(yieldTx.value),
    })
    const broadcast = await recordBroadcastHash(record, hash, ctx)
    if (broadcast.dismissed) return
    const broadcastRecord = broadcast.record
    await waitForReceiptOrFail({ hash, signal: ctx.signal })
    if (kmIsUnlocked()) {
      void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
    }
    await ctx.upsert(advance(broadcastRecord, 'hub-confirmed', { sourceTxHash: hash }))
    return
  }

  let submitResponse
  try {
    submitResponse = await submitRelay(
      {
        chainId: hubChainId,
        to: yieldTx.to,
        data: yieldTx.data,
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
    await ctx.upsert(markFailed(broadcastRecord, error))
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
    await ctx.upsert(markFailed(broadcastRecord, error))
    return
  }

  track('tx.relayer.confirmed', { id: record.id, kind: record.kind })

  if (kmIsUnlocked()) {
    void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
  }

  await ctx.upsert(advance(broadcastRecord, 'hub-confirmed', {
    sourceTxHash: submitResponse.txHash as `0x${string}`,
  }))
}
