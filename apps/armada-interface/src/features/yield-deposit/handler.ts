// ABOUTME: Yield-deposit (lend) handler — single atomic adapt-proof tx with broadcaster fee → POST /relay → poll status. Relayer-mediated (A4).
// ABOUTME: Three stages: build-proof (~20-30s, embeds broadcaster output), submit-relayer (POST + status poll), hub-confirmed (balance refresh).

import { sendTransaction } from 'wagmi/actions'
import { loadDeployments, loadYieldDeployment } from '@/config/deployments'
import { getNetworkConfig } from '@/config/network'
import { wagmiConfig } from '@/config/wagmi'
import { ensureChain } from '@/lib/network-switch'
import { waitForReceiptOrFail } from '@/lib/tx/receipt'
import { simulateOrThrow } from '@/lib/tx/simulate'
import {
  getRailgunAddress as kmGetRailgunAddress,
  getSdkEncryptionKey as kmGetSdkEncryptionKey,
  getWalletId as kmGetWalletId,
  isUnlocked as kmIsUnlocked,
} from '@/lib/railgun/keyManager'
import { refreshShieldedBalances } from '@/lib/railgun/sync'
import { buildYieldAdaptTransaction, type BroadcasterFeeRecipient } from '@/lib/railgun/yield'
import { runYieldDifferential, yieldDifferentialEnabled } from '@/lib/railgun/yield-differential'
import { buildYieldAdaptSdk, sdkYieldEnabled } from '@/lib/railgun/yield-sdk'
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
      await ctx.upsert(markFailed(record, classifyHandlerError(err, 'Vault deposit failed.', record.artifacts.sourceTxHash, getNetworkConfig().hub.chainId)))
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

  if (sdkYieldEnabled()) {
    // @armada/sdk cutover: plan (unshield USDC → adapter + re-shield-bundle adaptParams) → prove
    // off-thread → encode lendAndShield, and stash the calldata so submit-relayer dispatches it
    // without re-proving. Survives a reload (persisted in the record).
    const bf = broadcasterFeeFromRecord(record, usdcAddress)
    const { to, data } = await buildYieldAdaptSdk({
      mode: 'lend',
      amount: record.meta.amount,
      unshieldToken: usdcAddress as `0x${string}`,
      shieldOutputToken: vaultAddress as `0x${string}`,
      adapterAddress: adapterAddress as `0x${string}`,
      railgunAddress,
      broadcasterFee: bf ? { amount: bf.amount, recipientAddress: bf.recipientAddress } : null,
      onProgress: progress.write,
    })
    if (ctx.signal.aborted) throw new Error('cancelled')
    await ctx.upsert(advance(progress.latest(), 'submit-relayer', { yieldTx: { to, data, value: '0' } }))
    return
  }

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

  // Pre-cutover differential (opt-in, observe-only): build this deposit with @armada/sdk and simulate
  // it against the adapter — telemetry-reports whether the SDK proof + re-shield binding verifies
  // on-chain. Fire-and-forget; never blocks or fails the deposit (the engine build above is what submits).
  const evmFrom = record.walletContext.evmAddress
  if (yieldDifferentialEnabled() && evmFrom) {
    const bf = broadcasterFeeFromRecord(record, usdcAddress)
    void runYieldDifferential({
      mode: 'lend',
      amount: record.meta.amount,
      unshieldToken: usdcAddress as `0x${string}`,
      shieldOutputToken: vaultAddress as `0x${string}`,
      adapterAddress: adapterAddress as `0x${string}`,
      railgunAddress,
      broadcasterFee: bf ? { amount: bf.amount, recipientAddress: bf.recipientAddress } : null,
      from: evmFrom as `0x${string}`,
      chainId: getNetworkConfig().hub.chainId,
    })
  }

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
  // `yieldTx` is persisted in artifacts at build-proof, so it survives a reload — no re-proving
  // needed on resume. Only the broadcast itself must be guarded against re-entry.
  const existingHash = record.artifacts.sourceTxHash

  // A6 wallet-override path — submit the wrapper calldata via the user's EVM wallet.
  if (record.meta.useWalletOverride) {
    // Idempotency guard (P0-1): never re-broadcast a tx we already sent. On re-entry skip to the
    // receipt wait for the known hash.
    let hash = existingHash
    let broadcastRecord = record
    if (!hash) {
      await ensureChain(hubChainId)
      if (ctx.signal.aborted) throw new Error('cancelled')
      // S-M8: pre-flight simulate so an on-chain revert surfaces as a typed PRE_FLIGHT_REVERT
      // ("nothing was sent") instead of MetaMask's opaque 30M-gas-fallback "gas limit too high".
      const sender = record.walletContext.evmAddress
      if (sender) {
        await simulateOrThrow({
          to: yieldTx.to as `0x${string}`,
          data: yieldTx.data as `0x${string}`,
          value: BigInt(yieldTx.value),
          account: sender as `0x${string}`,
          chainId: hubChainId,
        })
        if (ctx.signal.aborted) throw new Error('cancelled')
      }
      hash = await sendTransaction(wagmiConfig, {
        to: yieldTx.to as `0x${string}`,
        data: yieldTx.data as `0x${string}`,
        value: BigInt(yieldTx.value),
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
    await ctx.upsert(advance(broadcastRecord, 'hub-confirmed', { sourceTxHash: hash }))
    return
  }

  // Idempotency guard (P0-1): once the relayer accepted the POST we persist the returned txHash.
  // NEVER re-POST — a duplicate gets a 409 and surfaces a false failure. On re-entry skip to the
  // status poll for the known hash.
  let txHash = existingHash
  let broadcastRecord = record
  if (!txHash) {
    let submitResponse
    try {
      submitResponse = await submitRelay(
        {
          chainId: hubChainId,
          to: yieldTx.to,
          data: yieldTx.data,
          feesCacheId: record.meta.feeCacheId,
          idempotencyKey: record.id,
        },
        ctx.signal,
      )
    } catch (err) {
      // T-M3/S-M1: recover an already-broadcast hash from a DUPLICATE_TX so we resume polling
      // instead of failing a tx the relayer already sent; non-recoverable errors rethrow.
      submitResponse = handleRelaySubmitError(err, { id: record.id, kind: record.kind })
    }

    track('tx.relayer.submitted', { id: record.id, kind: record.kind })

    txHash = submitResponse.txHash as `0x${string}`
    const broadcast = await recordBroadcastHash(record, txHash, ctx)
    if (broadcast.dismissed) return
    broadcastRecord = broadcast.record
  }

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
      txHash,
    }
    await ctx.upsert(markFailed(broadcastRecord, error))
    return
  }

  track('tx.relayer.confirmed', { id: record.id, kind: record.kind })

  if (kmIsUnlocked()) {
    void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
  }

  await ctx.upsert(advance(broadcastRecord, 'hub-confirmed', {
    sourceTxHash: txHash,
  }))
}
