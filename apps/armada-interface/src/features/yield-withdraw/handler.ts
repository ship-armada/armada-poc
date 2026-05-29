// ABOUTME: Yield-withdraw (redeem) handler — single atomic adapt-proof tx with broadcaster fee → POST /relay → poll status. Relayer-mediated (A4).
// ABOUTME: Symmetric with yield-deposit; only the adapter entry point + token roles flip.

import { loadDeployments, loadYieldDeployment } from '@/config/deployments'
import { getNetworkConfig } from '@/config/network'
import {
  getRailgunAddress as kmGetRailgunAddress,
  getSdkEncryptionKey as kmGetSdkEncryptionKey,
  getWalletId as kmGetWalletId,
  isUnlocked as kmIsUnlocked,
} from '@/lib/railgun/keyManager'
import { refreshShieldedBalances } from '@/lib/railgun/sync'
import { buildYieldAdaptTransaction } from '@/lib/railgun/yield'
import { submitRelay, RelayerError } from '@/lib/relayer'
import { advance, markFailed, patchArtifacts } from '@/lib/tx/reducer'
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

  const progress = createProofProgressWriter(record)
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
    // Broadcaster fee is paid in USDC (the unshielded output token), same as deposit. The
    // SDK includes the broadcaster output alongside the cross-contract spend in one proof.
    broadcasterFee: {
      tokenAddress: usdcAddress,
      amount: record.meta.broadcasterFeeAmount,
      recipientAddress: record.meta.broadcasterRailgunAddress,
    },
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

  const broadcastRecord = patchArtifacts(record, { sourceTxHash: submitResponse.txHash as `0x${string}` })
  await ctx.upsert(broadcastRecord)
  if (ctx.signal.aborted) throw new Error('cancelled')

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
