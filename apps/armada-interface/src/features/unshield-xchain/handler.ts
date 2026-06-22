// ABOUTME: Cross-chain unshield handler — A5 relayer-mediated. Hub-side atomicCrossChainUnshield is wrapped by the relayer; destination CCTP delivery polling is unchanged.
// ABOUTME: Same handler covers Withdraw modal (destination ≠ hub) and Send-External tab (destination ≠ hub) — same contract path, different UI entry.

import { ethers } from 'ethers'
import { encodeFunctionData, pad } from 'viem'
import { getPublicClient, sendTransaction } from 'wagmi/actions'
import { asTxError, waitForReceiptOrFail } from '@/lib/tx/receipt'
import { simulateOrThrow } from '@/lib/tx/simulate'
import { classifyHandlerError } from '@/lib/tx/errors'
import { track } from '@/lib/telemetry'
import { wagmiConfig } from '@/config/wagmi'
import { loadDeployments } from '@/config/deployments'
import { getChainById, getNetworkConfig } from '@/config/network'
import { ensureChain } from '@/lib/network-switch'
import { createProvider } from '@/lib/rpc'
import {
  getSdkEncryptionKey as kmGetSdkEncryptionKey,
  getWalletId as kmGetWalletId,
  isUnlocked as kmIsUnlocked,
} from '@/lib/railgun/keyManager'
import { refreshShieldedBalances } from '@/lib/railgun/sync'
import {
  buildXchainUnshieldTransactionStruct,
  generateXchainUnshieldProof,
  type BroadcasterFeeRecipient,
} from '@/lib/railgun/unshield'
import {
  extractCctpMessageFromReceipt,
  messageReceivedTopic,
} from '@/lib/cctp'
import { cctpMaxFeeForKind, submitRelay } from '@/lib/relayer'
import { handleRelaySubmitError } from '@/lib/tx/relaySubmit'

// MessageReceived ABI — used by ethers.Interface.parseLog to decode `messageBody` from a raw log.
// We route the destination scan through ethers (rather than viem) so the app-wide bisecting
// JsonRpcProvider patch (lib/rpc-bisecting.ts) takes effect on free-tier RPCs that cap getLogs
// at 10 blocks (Alchemy free). Viem's HTTP transport is not covered by that patch.
const MESSAGE_RECEIVED_IFACE = new ethers.Interface([
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
])

// Explicit log shape we hand scanCctpDeliveryWindow so the predicate sees `topics` + `data`.
// Mirrors ethers' Log surface (string-typed hashes, readonly topics array).
type EthersScanLog = {
  transactionHash?: string | null
  topics: readonly string[]
  data: string
}
import { advance, markFailed, markWaiting, patchArtifacts } from '@/lib/tx/reducer'
import { recordBroadcastHash } from '@/lib/tx/broadcast'
import { poll, pollBudgetMs, pollRelayStatusOnce } from '@/lib/tx/poller'
import { scanCctpDeliveryWindow, matchesXchainDelivery } from './scan'
import { createProofProgressWriter } from '@/lib/tx/progress'
import type { StageHandler } from '@/lib/tx/executor'
import type { TxError, TxRecord } from '@/lib/tx/types'

/**
 * PrivacyPool.atomicCrossChainUnshield ABI — same Transaction struct as transact(), wrapped with
 * the CCTP destination + recipient + caller-restriction + maxFee. The destination router on the
 * client chain ATOMICALLY receives the CCTP USDC and forwards it to `finalRecipient` in one
 * `relayWithHook` call, so the user sees a single tx on each chain.
 */
const PRIVACY_POOL_XCHAIN_UNSHIELD_ABI = [
  {
    type: 'function',
    name: 'atomicCrossChainUnshield',
    stateMutability: 'nonpayable',
    inputs: [
      // The Transaction struct — we extract this from the SDK's transact() calldata.
      { name: '_transaction', type: 'tuple', components: [
        { name: 'proof', type: 'tuple', components: [
          { name: 'a', type: 'tuple', components: [
            { name: 'x', type: 'uint256' },
            { name: 'y', type: 'uint256' },
          ] },
          { name: 'b', type: 'tuple', components: [
            { name: 'x', type: 'uint256[2]' },
            { name: 'y', type: 'uint256[2]' },
          ] },
          { name: 'c', type: 'tuple', components: [
            { name: 'x', type: 'uint256' },
            { name: 'y', type: 'uint256' },
          ] },
        ] },
        { name: 'merkleRoot', type: 'bytes32' },
        { name: 'nullifiers', type: 'bytes32[]' },
        { name: 'commitments', type: 'bytes32[]' },
        { name: 'boundParams', type: 'tuple', components: [
          { name: 'treeNumber', type: 'uint16' },
          { name: 'minGasPrice', type: 'uint72' },
          { name: 'unshield', type: 'uint8' },
          { name: 'chainID', type: 'uint64' },
          { name: 'adaptContract', type: 'address' },
          { name: 'adaptParams', type: 'bytes32' },
          { name: 'commitmentCiphertext', type: 'tuple[]', components: [
            { name: 'ciphertext', type: 'bytes32[4]' },
            { name: 'blindedSenderViewingKey', type: 'bytes32' },
            { name: 'blindedReceiverViewingKey', type: 'bytes32' },
            { name: 'annotationData', type: 'bytes' },
            { name: 'memo', type: 'bytes' },
          ] },
        ] },
        { name: 'unshieldPreimage', type: 'tuple', components: [
          { name: 'npk', type: 'bytes32' },
          { name: 'token', type: 'tuple', components: [
            { name: 'tokenType', type: 'uint8' },
            { name: 'tokenAddress', type: 'address' },
            { name: 'tokenSubID', type: 'uint256' },
          ] },
          { name: 'value', type: 'uint120' },
        ] },
      ] },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'finalRecipient', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

/**
 * Stage map for `unshield-xchain` (A5 — relayer-mediated hub burn):
 *   1. `build-proof`              — Groth16 proof (recipient = PrivacyPool itself) with
 *                                    broadcaster-fee output to the relayer's 0zk address.
 *   2. `submit-relayer`           — extract Transaction struct from populated calldata, encode
 *                                    atomicCrossChainUnshield, POST to `/relay`, poll `/status`
 *                                    until confirmed. Once confirmed, fetch the hub receipt by
 *                                    the relayer's txHash to extract the CCTP MessageSent log.
 *   3. `hub-burn-confirmed`       — wait for hub receipt
 *   4. `iris-attestation-pending` — polls destination chain for the recipient's USDC balance to
 *                                    tick up (signal that CCTP delivered + hook router minted).
 *                                    In MOCK mode the local cctp-relay handles this; in REAL
 *                                    mode Iris attestation + the relayer's iris-relay handles it.
 *   5. `iris-attestation-ready` / `client-mint-pending` / `client-mint-confirmed` — advanced
 *                                    through in quick succession on detection. The intermediate
 *                                    states exist for finer-grained UI; v1 collapses them since
 *                                    our single "balance increased on destination" signal can't
 *                                    distinguish them.
 */
export const unshieldXchainHandler: StageHandler<'unshield-xchain'> = {
  kind: 'unshield-xchain',
  // Iris/client polling can be resumed; pre-hub-receipt stages can't (proof + onchain submit).
  resumableFrom: ['submit-relayer', 'iris-attestation-pending'],

  async run(record, ctx) {
    try {
      switch (record.stage) {
        case 'build-proof':
          await runBuildProof(record, ctx)
          return
        case 'submit-relayer':
          await runSubmitAndBurn(record, ctx)
          return
        case 'hub-burn-confirmed':
          // Bridge stage — advance into the polling phase.
          await ctx.upsert(advance(record, 'iris-attestation-pending'))
          return
        case 'iris-attestation-pending':
          await runWaitForDelivery(record, ctx)
          return
        // The remaining stages (iris-attestation-ready / client-mint-pending /
        // client-mint-confirmed) are advanced through inside runWaitForDelivery. If we end up
        // here it's a resume from a partially-completed delivery and we're already terminal.
      }
    } catch (err) {
      if (ctx.signal.aborted) return
      const failed = markFailed(record, classifyHandlerError(err, 'Cross-chain withdraw failed.', record.artifacts.sourceTxHash, getNetworkConfig().hub.chainId))
      await ctx.upsert(failed)
    }
  },
}

/** A6 — null when wallet-override, otherwise the broadcaster context from meta. */
function broadcasterFeeFromRecord(
  record: TxRecord<'unshield-xchain'>,
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
  record: TxRecord<'unshield-xchain'>,
  ctx: Parameters<typeof unshieldXchainHandler.run>[1],
): Promise<void> {
  if (!kmIsUnlocked()) {
    throw new Error('Cross-chain withdraw requires an unlocked shielded wallet.')
  }
  const walletId = kmGetWalletId()
  const encryptionKey = kmGetSdkEncryptionKey()
  const deployments = await loadDeployments()
  const tokenAddress = deployments.hub.cctp.usdc
  const privacyPoolAddress = deployments.hub.contracts.privacyPool

  if (ctx.signal.aborted) throw new Error('cancelled')

  const progress = createProofProgressWriter(record, ctx.signal)
  await generateXchainUnshieldProof({
    walletId,
    encryptionKey,
    tokenAddress,
    privacyPoolAddress,
    amount: record.meta.amount,
    broadcasterFee: broadcasterFeeFromRecord(record, tokenAddress),
    onProgress: progress.write,
  })

  if (ctx.signal.aborted) throw new Error('cancelled')
  // Advance from the LIVE record (progress bumps incremented updatedSeq).
  await ctx.upsert(advance(progress.latest(), 'submit-relayer'))
}

async function runSubmitAndBurn(
  record: TxRecord<'unshield-xchain'>,
  ctx: Parameters<typeof unshieldXchainHandler.run>[1],
): Promise<void> {
  const deployments = await loadDeployments()
  const privacyPoolAddress = deployments.hub.contracts.privacyPool
  const hubChainId = getNetworkConfig().hub.chainId
  const existingHash = record.artifacts.sourceTxHash

  // Build the hub-burn calldata only when we still need to broadcast. On re-entry (Retry /
  // resume-on-reload) the hash is already persisted; rebuilding it would re-run the SDK proof
  // (whose in-memory cache doesn't survive a reload) and serve no purpose. (P0-1)
  let calldata: `0x${string}` | undefined
  if (!existingHash) {
    const walletId = kmGetWalletId()
    const tokenAddress = deployments.hub.cctp.usdc

    // Map destination chain id → CCTP domain. Both come from the network config.
    const destChain = getNetworkConfig().clients.find(c => c.chainId === record.meta.toChainId)
    if (!destChain) {
      throw new Error(`Unknown destination chain ${record.meta.toChainId}`)
    }
    const destinationDomain = destChain.domain
    const destClientDeployment = deployments.clients.find(c => c.chainId === record.meta.toChainId)
    if (!destClientDeployment) {
      throw new Error(`No deployment for destination chain ${record.meta.toChainId}`)
    }
    const destHookRouter = destClientDeployment.contracts.hookRouter

    // Build the Transaction struct (decoded from the SDK's populated transact() calldata). The
    // broadcaster fee must be passed here EXACTLY as it was passed to generateXchainUnshieldProof —
    // the SDK's in-memory proof cache is keyed by it, and a mismatch throws "proof not found".
    const txStruct = await buildXchainUnshieldTransactionStruct({
      walletId,
      tokenAddress,
      privacyPoolAddress,
      amount: record.meta.amount,
      broadcasterFee: broadcasterFeeFromRecord(record, tokenAddress),
    })
    if (ctx.signal.aborted) throw new Error('cancelled')

    // destinationCaller: bytes32 form of the destination hook router; restricts who can call
    // receiveMessage on the destination MessageTransmitter (the router atomically delivers).
    const destinationCaller = destHookRouter && destHookRouter !== ethers.ZeroAddress
      ? pad(destHookRouter as `0x${string}`, { size: 32 })
      : `0x${'00'.repeat(32)}` as `0x${string}`

    // maxFee = upper bound CCTP's MessageTransmitter accepts for `feeExecuted`. Iris sets the
    // actual fee (1–1.3 bps depending on chain); we pass 2× the realistic estimate as headroom.
    // Fee is deducted from the amount minted on the destination — recipient receives
    // (amount − feeExecuted). The modal's Review step shows the realistic fee (without the bound
    // multiplier) so the user sees what they will actually pay, not the contract bound.
    const maxFee = cctpMaxFeeForKind('unshield-xchain', record.meta.amount)

    calldata = encodeAtomicCrossChainUnshield(
      txStruct,
      destinationDomain,
      record.meta.recipient as `0x${string}`,
      destinationCaller,
      maxFee,
    )
  }

  // A6 wallet-override path — submit the wrapper calldata via the user's EVM wallet. The
  // CCTP-message extraction + destination polling are identical to the relayer path; the only
  // difference is the source of the hub-side tx hash.
  if (record.meta.useWalletOverride) {
    // Idempotency guard (P0-1): never re-broadcast a hub burn we already sent. On re-entry skip
    // to the receipt wait + CCTP extraction for the known hash.
    let userHash = existingHash
    let broadcastRecord = record
    if (!userHash) {
      await ensureChain(hubChainId)
      if (ctx.signal.aborted) throw new Error('cancelled')
      // S-M8: pre-flight simulate so an on-chain revert surfaces as a typed PRE_FLIGHT_REVERT
      // ("nothing was sent") instead of MetaMask's opaque 30M-gas-fallback "gas limit too high".
      const sender = record.walletContext.evmAddress
      if (sender) {
        await simulateOrThrow({
          to: privacyPoolAddress as `0x${string}`,
          data: calldata!,
          value: 0n,
          account: sender as `0x${string}`,
          chainId: hubChainId,
        })
        if (ctx.signal.aborted) throw new Error('cancelled')
      }
      userHash = await sendTransaction(wagmiConfig, {
        to: privacyPoolAddress as `0x${string}`,
        data: calldata!,
        value: 0n,
        chainId: hubChainId,
      })
      const broadcast = await recordBroadcastHash(record, userHash, ctx)
      if (broadcast.dismissed) return
      broadcastRecord = broadcast.record
    }
    await waitForReceiptOrFail({ hash: userHash, signal: ctx.signal, chainId: hubChainId })
    await extractCctpRefAndAdvance({
      ctx,
      record: broadcastRecord,
      txHash: userHash,
      hubChainId,
      messageTransmitter: deployments.hub.cctp.messageTransmitter as `0x${string}`,
      destChainId: record.meta.toChainId,
    })
    if (kmIsUnlocked()) {
      void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
    }
    return
  }

  // Hand the wrapper calldata to the relayer. Pre-submit pipeline validates the selector
  // (atomicCrossChainUnshield → A5 addition) and decrypts the embedded broadcaster output against
  // the `crossChainUnshield` advertised fee. Same failure modes as unshield-local:
  //   FEE_INSUFFICIENT       — broadcaster output below advertised
  //   FEE_EXPIRED            — cacheId expired between modal validation and relayer submit
  //   GAS_ESTIMATION_FAILED  — would revert on-chain
  //   SUBMISSION_FAILED      — relayer wallet couldn't broadcast
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
          to: privacyPoolAddress,
          data: calldata!,
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

    // Persist sourceTxHash immediately so cancel/timeout/revert can carry the hash forward, and so
    // the guard above sees it on re-entry. The patched record MUST be threaded into the final
    // advance below — `record` is now stale (lower updatedSeq than the atom/IDB) so an advance from
    // it would produce an equal-seq write that OCC silently drops, stranding the executor.
    txHash = submitResponse.txHash as `0x${string}`
    const broadcast = await recordBroadcastHash(record, txHash, ctx)
    if (broadcast.dismissed) return
    broadcastRecord = broadcast.record
  }

  // Poll the relayer's /status until terminal. Same shape as unshield-local — the generic poll
  // loop handles jittered backoff + abort propagation.
  const pollResult = await poll(
    (signal) => pollRelayStatusOnce(txHash, signal, hubChainId),
    { signal: ctx.signal, timeoutMs: pollBudgetMs(record) },
  )

  if (pollResult.status === 'aborted') throw new Error('cancelled')
  if (pollResult.status === 'timeout') {
    const error: TxError = {
      code: 'POLL_TIMEOUT',
      message:
        'The relayer hasn\'t reported a final status for the hub burn. The transaction may still complete on chain — check the explorer.',
      txHash,
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
      message: final.error ?? 'Relayer-broadcast hub burn reverted on chain.',
      txHash,
    }
    const failed = markFailed(broadcastRecord, error)
    await ctx.upsert(failed)
    return
  }
  track('tx.relayer.confirmed', { id: record.id, kind: record.kind })

  await extractCctpRefAndAdvance({
    ctx,
    record: broadcastRecord,
    txHash,
    hubChainId,
    messageTransmitter: deployments.hub.cctp.messageTransmitter as `0x${string}`,
    destChainId: record.meta.toChainId,
  })

  // Refresh shielded balance now — the burn debited the user's UTXOs plus the broadcaster output.
  // Hub-side completion of the burn is the right moment; the destination mint is a separate event.
  if (kmIsUnlocked()) {
    void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
  }
}

/**
 * Hub-side completion: fetch the tx receipt from the wagmi public client, extract the CCTP
 * MessageSent event from the logs, snapshot the destination chain's current block height, and
 * advance the record to `hub-burn-confirmed`. Identical for both the relayer-mediated path (A5)
 * and the wallet-override path (A6) — they only differ in the source of the txHash.
 */
async function extractCctpRefAndAdvance(args: {
  ctx: Parameters<typeof unshieldXchainHandler.run>[1]
  record: TxRecord<'unshield-xchain'>
  txHash: `0x${string}`
  hubChainId: number
  messageTransmitter: `0x${string}`
  destChainId: number
}): Promise<void> {
  const { ctx, record, txHash, hubChainId, messageTransmitter, destChainId } = args
  const hubClient = getPublicClient(wagmiConfig, { chainId: hubChainId })
  if (!hubClient) {
    throw new Error('No wagmi public client for hub chain — cannot fetch tx receipt.')
  }
  const receipt = await hubClient.getTransactionReceipt({ hash: txHash })
  if (!receipt) {
    throw asTxError({
      code: 'POLL_TIMEOUT',
      message: 'Hub burn confirmed, but no receipt is fetchable. Retry shortly.',
      txHash,
    })
  }
  const cctpRef = extractCctpMessageFromReceipt({
    logs: receipt.logs,
    messageTransmitterAddress: messageTransmitter,
  })
  if (!cctpRef) {
    throw new Error('No CCTP MessageSent log in hub tx receipt — cross-chain delivery cannot be tracked.')
  }
  const destClient = getPublicClient(wagmiConfig, { chainId: destChainId })
  if (!destClient) {
    throw new Error(`No wagmi public client for destination chain ${destChainId}`)
  }
  const destFromBlock = await destClient.getBlockNumber()
  await ctx.upsert(advance(record, 'hub-burn-confirmed', {
    sourceTxHash: txHash,
    messageHash: cctpRef.messageHash,
    cctpNonce: cctpRef.nonce,
    destFromBlock: destFromBlock.toString(),
  }))
}

async function runWaitForDelivery(
  record: TxRecord<'unshield-xchain'>,
  ctx: Parameters<typeof unshieldXchainHandler.run>[1],
): Promise<void> {
  const deployments = await loadDeployments()
  const destClientDeployment = deployments.clients.find(c => c.chainId === record.meta.toChainId)
  if (!destClientDeployment) {
    throw new Error(`No deployment for destination chain ${record.meta.toChainId}`)
  }
  const destMessageTransmitter = destClientDeployment.cctp.messageTransmitter as `0x${string}`
  // CCTP V2 destination scan: we can't filter on the indexed `nonce` topic. V2's nonce slot is
  // bytes32(0) on outbound MessageSent; the destination contract emits an Iris-assigned
  // `eventNonce` which isn't derivable from the source side. So we drop the topic filter and
  // identify ours by looking inside the messageBody's hookData for a unique-per-tx marker.
  // For unshield-xchain the hookData encodes only `recipient`; two parallel unshields to the
  // same recipient would be indistinguishable by content. Combined with the burn-time
  // `destFromBlock` cursor this is correct for in-series flows, and the rare parallel-same-
  // recipient case is acceptable (either delivery satisfies one of the two records — both
  // ultimately resolve as the second delivery lands).
  const recipientBytes32 = pad(record.meta.recipient as `0x${string}`, { size: 32 })
  const uniqueMarker = recipientBytes32.slice(2).toLowerCase()
  // Build an ethers JsonRpcProvider for the destination chain. We deliberately bypass viem here
  // so the app-wide bisecting `eth_getLogs` patch (lib/rpc-bisecting.ts, installed in main.tsx)
  // applies — free-tier RPCs (Alchemy = 10-block cap) reject the configured 5_000-block window
  // outright, and only the bisector recovers automatically.
  const destChain = getChainById(record.meta.toChainId)
  if (!destChain) {
    throw new Error(`No chain config for destination chain ${record.meta.toChainId}`)
  }
  const destProvider = createProvider(destChain.rpcUrls)
  const destMessageReceivedTopic = messageReceivedTopic()
  // T-M7: the burn for unshield-xchain happens on the hub, so a genuine delivery's CCTP
  // sourceDomain is the hub's domain. Match on it to reject same-recipient transfers from elsewhere.
  const hubDomain = getNetworkConfig().hub.domain

  // Park the record in 'waiting' so the stepper renders the "Waiting for cross-chain confirmation"
  // copy. The handler doesn't return here — poll() continues; the 'waiting' state is purely a
  // UI hint for the active row.
  let cursor = markWaiting(record)
  await ctx.upsert(cursor)

  // Mutable scan cursor. Initialised from the artifact (set by runSubmitAndBurn to the dest-chain
  // head at burn time). Advanced after every tick whose scan finds no match so a long-running poll
  // never re-scans history; a crash + resume picks up from the persisted value.
  let scanFromBlock = record.artifacts.destFromBlock
    ? BigInt(record.artifacts.destFromBlock)
    : 0n
  const maxLogRange = BigInt(getNetworkConfig().maxLogRange)

  // Derive the inner polling timeout from the per-kind lifecycle cap minus elapsed time, crediting
  // back tab-hidden time (T-M5/S-M6) so a slow Iris attestation watched from a backgrounded tab
  // isn't timed out with budget still on the clock. pollBudgetMs floors at 10s (so an over-budget
  // record fails fast rather than hanging a tick) and emits tx.budget.tight when the floor engages.
  const pollTimeoutMs = pollBudgetMs(record)

  const result = await poll<`0x${string}`>(
    async (signal) => {
      if (signal.aborted) return null
      // Bounded per-tick scan — never queries more than maxLogRange blocks in a single getLogs
      // call. Across many ticks the cursor marches forward chunk-by-chunk; once caught up to head,
      // ticks short-circuit on `no-new-blocks` until the next block lands.
      const outcome = await scanCctpDeliveryWindow<EthersScanLog>({
        getBlockNumber: async () => BigInt(await destProvider.getBlockNumber()),
        // Filter on the MessageReceived topic only — V2 puts an Iris-assigned `eventNonce` in
        // the indexed `nonce` topic that we can't predict source-side. The matchPredicate below
        // narrows by hookData content (uniqueMarker = pad32(recipient)).
        getLogsForRange: (fromBlock, toBlock) => destProvider.getLogs({
          address: destMessageTransmitter,
          topics: [destMessageReceivedTopic],
          fromBlock,
          toBlock,
        }),
        matchPredicate: (log) => {
          try {
            const parsed = MESSAGE_RECEIVED_IFACE.parseLog({
              topics: Array.from(log.topics),
              data: log.data,
            })
            return matchesXchainDelivery(
              { messageBody: parsed?.args.messageBody, sourceDomain: parsed?.args.sourceDomain },
              { recipientMarker: uniqueMarker, sourceDomain: hubDomain },
            )
          } catch {
            // Foreign log on the same address (different ABI / unindexed topic mismatch) — skip
            // rather than fail the whole tick. The scanner continues to the next log.
            return false
          }
        },
        scanFromBlock,
        maxLogRange,
      })
      if (outcome.kind === 'match') return outcome.txHash
      if (outcome.kind === 'no-new-blocks') return null

      // Advance the cursor and persist so a crash + resume starts where we left off rather than
      // re-scanning everything back to burn-time head.
      scanFromBlock = outcome.nextScanFromBlock
      // A cancel/dismiss may have fired during the async scan above. Skip the cursor persist so we
      // don't resurrect a record abortAndMark has already moved to a terminal state — the terminal-
      // write guard in upsertTxAtom would refuse it anyway, but skipping is clearer + avoids a
      // pointless write. (P0-3 WS1.2b)
      if (signal.aborted) return null
      cursor = patchArtifacts(cursor, { destFromBlock: scanFromBlock.toString() })
      await ctx.upsert(cursor)
      return null
    },
    {
      intervalMs: 3_000,
      jitter: 0.2,
      timeoutMs: pollTimeoutMs,
      signal: ctx.signal,
    },
  )

  if (result.status === 'aborted') {
    // Cancel/dismiss already wrote the terminal state via abortAndMark. Returning here without
    // throwing avoids the outer catch trying to classifyHandlerError and OCC-rejecting against
    // the already-terminal record.
    return
  }
  if (result.status !== 'done') {
    // Timeout: we know the sourceTxHash and that the relayer/Iris haven't delivered within the
    // budget. The on-chain mint may still happen later — the user should check the destination
    // explorer. POLL_TIMEOUT category surfaces that ambiguity in the UI copy.
    throw asTxError({
      code: 'POLL_TIMEOUT',
      message: 'Timed out waiting for cross-chain delivery. The destination mint may still occur — check the destination chain explorer.',
      txHash: record.artifacts.sourceTxHash,
    })
  }

  // We have ONE real signal (MessageReceived observed) — the intermediate stages between hub
  // burn and destination mint don't have distinct signals in mock mode (no Iris API; relayer's
  // /status reports only on hub-side txs). Walk through them as visual progress; finer-grained
  // detection is a real-CCTP-mode polish that requires Iris polling.
  //
  // Brief inter-stage delay so the stepper has time to render each row as "current" rather than
  // flashing through three transitions in a single frame. ~350ms feels intentional and still
  // completes the visual sequence in ~1s. Skipped between the last-but-one and terminal stage to
  // keep the success state landing promptly.
  const STAGE_VISUAL_DELAY_MS = 350
  // `cursor` carries forward from the poll loop above — it already reflects any artifact patches
  // we wrote during the scan, so each advance() composes cleanly on top of the latest seq.
  const skipStages = ['iris-attestation-ready', 'client-mint-pending', 'client-mint-confirmed'] as const
  for (let i = 0; i < skipStages.length; i++) {
    // Cancel/dismiss may have fired since the last delay — checking BEFORE the upsert prevents
    // us from advancing a record that abortAndMark has already moved to a terminal state.
    // Without this guard the OCC `updatedSeq` collision would silently drop the write, but the
    // intent is clearer when we don't even attempt it.
    if (ctx.signal.aborted) return
    const next = skipStages[i]!
    cursor = advance(cursor, next, next === 'client-mint-confirmed' ? { destTxHash: result.value } : {})
    await ctx.upsert(cursor)
    // Only delay before the next non-terminal hop; no point pausing before terminal.
    if (i < skipStages.length - 1) {
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, STAGE_VISUAL_DELAY_MS)
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
      })
      if (ctx.signal.aborted) return
    }
  }

  // Final shielded-balance refresh — the destination mint is a separate event but the user's
  // shielded debit happened at the hub burn. Refreshing again here is a no-op safety net in case
  // an earlier refresh raced the relayer's state.
  if (kmIsUnlocked()) {
    void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
  }
}

function encodeAtomicCrossChainUnshield(
  transactionStruct: unknown,
  destinationDomain: number,
  finalRecipient: `0x${string}`,
  destinationCaller: `0x${string}`,
  maxFee: bigint,
): `0x${string}` {
  return encodeFunctionData({
    abi: PRIVACY_POOL_XCHAIN_UNSHIELD_ABI,
    functionName: 'atomicCrossChainUnshield',
    args: [
      // The decoded transaction struct from the SDK — viem encodes by name matching the ABI's
      // component names. Cast through unknown since the struct shape is dynamic at this seam.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transactionStruct as any,
      destinationDomain,
      finalRecipient,
      destinationCaller,
      maxFee,
    ],
  })
}
