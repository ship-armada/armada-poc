// ABOUTME: Yield-withdraw (redeem) handler — single atomic adapt-proof tx with broadcaster fee → POST /relay → poll status. Relayer-mediated (A4).
// ABOUTME: Symmetric with yield-deposit; only the adapter entry point + token roles flip.

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
 * Lifecycle mirrors yield-deposit. `meta.amount` is the SHARES count (ayUSDC), computed by the
 * modal as `requestedUsdc × 1e18 / rate` where rate comes from `useYieldRate()`. If rate moves
 * between quote and execution the user receives slightly more or less than requested — out of
 * scope to slippage-protect for v1.
 */
export const yieldWithdrawHandler: StageHandler<'yield-withdraw'> = {
  kind: 'yield-withdraw',
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
    } catch (err) {
      if (ctx.signal.aborted) return
      await ctx.upsert(markFailed(record, classifyHandlerError(err, 'Vault withdrawal failed.', record.artifacts.sourceTxHash)))
    }
  },
}

/** A6 — null when wallet-override, otherwise the broadcaster context from meta. */
function broadcasterFeeFromRecord(
  record: TxRecord<'yield-withdraw'>,
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
  record: TxRecord<'yield-withdraw'>,
  ctx: Parameters<typeof yieldWithdrawHandler.run>[1],
): Promise<void> {
  if (!kmIsUnlocked()) {
    throw new Error('Yield withdraw requires an unlocked shielded wallet.')
  }
  const walletId = kmGetWalletId()
  const encryptionKey = kmGetSdkEncryptionKey()
  const railgunAddress = kmGetRailgunAddress()
  const deployments = await loadDeployments()
  const yieldDeployment = await loadYieldDeployment()
  if (!yieldDeployment) {
    throw new Error('Yield deployment manifest not found — run `npm run setup`.')
  }
  if (record.meta.shares <= 0n) {
    throw new Error('Withdraw shares is zero — the vault rate may not have synced yet. Try again in a moment.')
  }
  const usdcAddress = deployments.hub.cctp.usdc

  if (ctx.signal.aborted) throw new Error('cancelled')

  const progress = createProofProgressWriter(record, ctx.signal)
  const built = await buildYieldAdaptTransaction({
    walletId,
    encryptionKey,
    mode: 'redeem',
    // Redeem flips the token roles: we unshield SHARES (ayUSDC, the vault token) and receive
    // USDC (the underlying) back into the shielded pool.
    unshieldToken: yieldDeployment.contracts.armadaYieldVault,
    shieldOutputToken: usdcAddress,
    amount: record.meta.shares,
    railgunAddress,
    adapterAddress: yieldDeployment.contracts.armadaYieldAdapter,
    hubChainId: getNetworkConfig().hub.chainId,
    // Broadcaster fee is paid in USDC (the unshielded output token), same as deposit. A6:
    // null when wallet-override is set → SDK builds without a broadcaster output.
    broadcasterFee: broadcasterFeeFromRecord(record, usdcAddress),
    onProgress: progress.write,
  })

  if (ctx.signal.aborted) throw new Error('cancelled')
  await ctx.upsert(advance(progress.latest(), 'submit-relayer', {
    yieldTx: {
      to: built.transaction.to,
      data: built.transaction.data,
      value: built.transaction.value.toString(),
    },
  }))
}

async function runSubmitAndConfirm(
  record: TxRecord<'yield-withdraw'>,
  ctx: Parameters<typeof yieldWithdrawHandler.run>[1],
): Promise<void> {
  const yieldTx = record.artifacts.yieldTx
  if (!yieldTx) {
    throw new Error('Yield adapt-proof tx missing — re-run build-proof stage.')
  }
  const hubChainId = getNetworkConfig().hub.chainId

  // A6 wallet-override — submit the redeemAndShield wrapper calldata via the user's wallet.
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
