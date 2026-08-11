// ABOUTME: Yield-withdraw (redeem) handler — single atomic adapt-proof tx with broadcaster fee → POST /relay → poll status. Relayer-mediated (A4).
// ABOUTME: Symmetric with yield-deposit; only the adapter entry point + token roles flip.

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
      await ctx.upsert(markFailed(record, classifyHandlerError(err, 'Vault withdrawal failed.', record.artifacts.sourceTxHash, getNetworkConfig().hub.chainId)))
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

  if (sdkYieldEnabled()) {
    // @armada/sdk cutover: plan (unshield shares → adapter + re-shield-bundle adaptParams) → prove
    // off-thread → encode redeemAndShield, and stash the calldata + the fee note's random (#312) so
    // submit-relayer dispatches it without re-proving. Survives a reload (persisted in the record).
    const bf = broadcasterFeeFromRecord(record, usdcAddress)
    const { to, data, feeShieldRandom } = await buildYieldAdaptSdk({
      mode: 'redeem',
      amount: record.meta.shares,
      unshieldToken: yieldDeployment.contracts.armadaYieldVault as `0x${string}`,
      shieldOutputToken: usdcAddress as `0x${string}`,
      adapterAddress: yieldDeployment.contracts.armadaYieldAdapter as `0x${string}`,
      railgunAddress,
      broadcasterFee: bf ? { amount: bf.amount, recipientAddress: bf.recipientAddress } : null,
      onProgress: progress.write,
    })
    if (ctx.signal.aborted) throw new Error('cancelled')
    await ctx.upsert(advance(progress.latest(), 'submit-relayer', { yieldTx: { to, data, value: '0' }, feeShieldRandom }))
    return
  }

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

  // Pre-cutover differential (opt-in, observe-only): build this withdraw with @armada/sdk and simulate
  // it against the adapter — telemetry-reports whether the SDK proof + re-shield binding (user + fee
  // notes) verifies on-chain. Fire-and-forget; never blocks or fails the withdraw.
  const evmFrom = record.walletContext.evmAddress
  if (yieldDifferentialEnabled() && evmFrom) {
    const bf = broadcasterFeeFromRecord(record, usdcAddress)
    void runYieldDifferential({
      mode: 'redeem',
      amount: record.meta.shares,
      unshieldToken: yieldDeployment.contracts.armadaYieldVault as `0x${string}`,
      shieldOutputToken: usdcAddress as `0x${string}`,
      adapterAddress: yieldDeployment.contracts.armadaYieldAdapter as `0x${string}`,
      railgunAddress,
      broadcasterFee: bf ? { amount: bf.amount, recipientAddress: bf.recipientAddress } : null,
      from: evmFrom as `0x${string}`,
      chainId: getNetworkConfig().hub.chainId,
    })
  }

  await ctx.upsert(advance(progress.latest(), 'submit-relayer', {
    yieldTx: {
      to: built.transaction.to,
      data: built.transaction.data,
      value: built.transaction.value.toString(),
    },
    // Persisted so submit-relayer can hand the relayer the fee note's random to verify the fee is
    // shielded to it (#312). Undefined on the wallet-override / fee-less path.
    feeShieldRandom: built.feeShieldRandom,
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
  // `yieldTx` is persisted in artifacts at build-proof, so it survives a reload — no re-proving
  // needed on resume. Only the broadcast itself must be guarded against re-entry.
  const existingHash = record.artifacts.sourceTxHash

  // A6 wallet-override — submit the redeemAndShield wrapper calldata via the user's wallet.
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
          // Redeem fee is contract-side (#312); the relayer needs this to verify the fee note is its own.
          feeShieldRandom: record.artifacts.feeShieldRandom,
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
