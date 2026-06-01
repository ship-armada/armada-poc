// ABOUTME: Cross-chain shield handler — dual-mode (direct user-wallet submit OR Phase B4 permit-based gasless via GaslessShieldWrapperClient).
// ABOUTME: Mirrors unshield-xchain but flipped direction: burn on CLIENT → mint on HUB. Hub-side delivery polling identical across both submission modes.

import { encodeFunctionData, pad } from 'viem'
import {
  getPublicClient,
  readContract,
  sendTransaction,
  signMessage,
  writeContract,
} from 'wagmi/actions'
import { erc20Abi, maxUint256 } from 'viem'
import { ethers } from 'ethers'
import { wagmiConfig } from '@/config/wagmi'
import { loadDeployments } from '@/config/deployments'
import { getChainById, getNetworkConfig } from '@/config/network'
import { createProvider } from '@/lib/rpc'
import {
  getRailgunAddress as kmGetRailgunAddress,
  getWalletId as kmGetWalletId,
  isUnlocked as kmIsUnlocked,
} from '@/lib/railgun/keyManager'
import { refreshShieldedBalances } from '@/lib/railgun/sync'
import {
  createShieldRequest,
  deriveShieldPrivateKey,
  SHIELD_SIGNATURE_MESSAGE,
} from '@/lib/railgun/shield'
import { extractCctpMessageFromReceipt, messageReceivedTopic } from '@/lib/cctp'
import { cctpMaxFeeForKind, submitRelay, RelayerError } from '@/lib/relayer'
import { signUsdcPermit } from '@/lib/wallet/permit'
import { buildGaslessCrossChainShieldCalldata } from '@/lib/wallet/gasless-cross-chain-shield'
import { ensureChain } from '@/lib/network-switch'
import { advance, markFailed, markWaiting, patchArtifacts } from '@/lib/tx/reducer'
import { poll } from '@/lib/tx/poller'
import { asTxError, waitForReceiptOrFail } from '@/lib/tx/receipt'
import { classifyHandlerError } from '@/lib/tx/errors'
import { lifecycleFor } from '@/lib/tx/lifecycles'
import { track } from '@/lib/telemetry'
import { scanCctpDeliveryWindow } from '../unshield-xchain/scan'
import type { StageHandler } from '@/lib/tx/executor'
import type { TxRecord } from '@/lib/tx/types'

// MessageReceived ABI for ethers.Interface.parseLog. We route the destination scan through
// ethers (rather than viem) so the app-wide bisecting JsonRpcProvider patch
// (lib/rpc-bisecting.ts) takes effect on free-tier RPCs that cap getLogs at 10 blocks
// (Alchemy free). Viem's HTTP transport is not covered by that patch.
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

/**
 * PrivacyPoolClient.crossChainShield ABI — the client-side entry point. Pulls USDC from the user,
 * approves TokenMessenger, and calls depositForBurnWithHook with the shield payload as hook data
 * (npk + encryptedBundle + shieldKey). The hub-side HookRouter atomically receives the CCTP
 * message and dispatches to PrivacyPool.shield with the recovered shield request.
 */
const PRIVACY_POOL_CLIENT_SHIELD_ABI = [
  {
    type: 'function',
    name: 'crossChainShield',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'npk', type: 'bytes32' },
      { name: 'encryptedBundle', type: 'bytes32[3]' },
      { name: 'shieldKey', type: 'bytes32' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'integrator', type: 'address' },
    ],
    outputs: [{ name: 'nonce', type: 'uint64' }],
  },
] as const

/**
 * Stage map for `shield-xchain`:
 *   1. `build-proof`              — sign RAILGUN_SHIELD, derive shieldPrivateKey, build the
 *                                    ShieldRequest off-chain (keyed to the HUB USDC address — the
 *                                    shield commitment lives on the hub once delivered).
 *   2. `submit-relayer`           — on the CLIENT chain: ensure USDC allowance for the
 *                                    PrivacyPoolClient, then call crossChainShield. The contract
 *                                    handles depositForBurnWithHook internally, emitting a CCTP
 *                                    MessageSent that the relayer will pick up.
 *   3. `client-burn-confirmed`    — wait for the client-chain receipt, extract the CCTP nonce
 *                                    from MessageSent, snapshot hub-chain head for the delivery
 *                                    scan cursor.
 *   4. `iris-attestation-pending` — poll the HUB chain for MessageReceived matching the nonce.
 *                                    Real CCTP mode goes through Iris attestation (relayer-side);
 *                                    mock mode short-circuits via the local CCTP relay. Either
 *                                    way our signal is the on-chain MessageReceived event.
 *   5. `iris-attestation-ready` / `hub-mint-pending` / `hub-mint-confirmed` — walked through in
 *                                    quick succession with brief delays so the stepper has time
 *                                    to render each stage. Same single-detection collapse as the
 *                                    inverse-direction handler.
 */
export const shieldXchainHandler: StageHandler<'shield-xchain'> = {
  kind: 'shield-xchain',
  // Iris/hub polling can be resumed; pre-receipt stages can't (RAILGUN_SHIELD sig + on-chain submit).
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
        case 'client-burn-confirmed':
          // Bridge stage — advance into the polling phase.
          await ctx.upsert(advance(record, 'iris-attestation-pending'))
          return
        case 'iris-attestation-pending':
          await runWaitForDelivery(record, ctx)
          return
        // Remaining stages are walked through inside runWaitForDelivery. Resume-on-load lands
        // here only if we crashed mid-walk; we're already terminal in that case.
      }
    } catch (err) {
      if (ctx.signal.aborted) return
      await ctx.upsert(markFailed(record, classifyHandlerError(err, 'Cross-chain deposit failed.', record.artifacts.sourceTxHash)))
    }
  },
}

async function runBuildProof(
  record: TxRecord<'shield-xchain'>,
  ctx: Parameters<typeof shieldXchainHandler.run>[1],
): Promise<void> {
  if (!kmIsUnlocked()) {
    throw new Error('Cross-chain deposit requires an unlocked shielded wallet.')
  }
  const railgunAddress = kmGetRailgunAddress()

  const deployments = await loadDeployments()
  // The shield request is keyed to the HUB USDC address because the commitment lives on the
  // hub merkle tree. The CLIENT-side USDC we're spending is just the source asset that gets
  // bridged through CCTP — it isn't what the SDK encodes into the note.
  const hubUsdcAddress = deployments.hub.cctp.usdc
  const privacyPoolAddress = deployments.hub.contracts.privacyPool

  // Resolve the client-chain deployment (used by submit-relayer + the approve preflight).
  const fromChainDeployment = deployments.clients.find(c => c.chainId === record.meta.fromChainId)
  if (!fromChainDeployment) {
    throw new Error(`No deployment for source chain ${record.meta.fromChainId}`)
  }
  const privacyPoolClientAddress = fromChainDeployment.contracts.privacyPoolClient
  const clientUsdcAddress = fromChainDeployment.cctp.usdc

  if (ctx.signal.aborted) throw new Error('cancelled')

  // RAILGUN_SHIELD is chain-agnostic (plain personal_sign of a constant string), but for UX we
  // still want the wallet on the source client chain so the prompt shows the right network and
  // the subsequent submit-relayer step doesn't have to switch a second time. Same pattern the
  // same-chain shield handler uses with meta.fromChainId.
  await ensureChain(record.meta.fromChainId)
  if (ctx.signal.aborted) throw new Error('cancelled')

  // Same flow as same-chain shield: prompt RAILGUN_SHIELD, derive the per-session key, ask the
  // engine to build the ShieldRequest. Cross-chain doesn't change the off-chain ZK construction —
  // only what we do with the result on-chain.
  const sigHex = await signMessage(wagmiConfig, { message: SHIELD_SIGNATURE_MESSAGE })
  if (ctx.signal.aborted) throw new Error('cancelled')

  // Determine the value that lands in the shielded commitment. Gasless path: the wrapper takes
  // `amount` via permit on the CLIENT chain, sends `fee` to the relayer, burns `(amount - fee)`
  // through CCTP — the hub mint + shield commitment values must match the post-fee amount. The
  // client wrapper's contract pins this through its `crossChainShield(shieldAmount, ...)` call
  // shape. Direct submit shields the full `amount` (user paid client-chain gas separately).
  const shieldValue =
    record.meta.useGasless && record.meta.feeAmount !== undefined
      ? record.meta.amount - record.meta.feeAmount
      : record.meta.amount
  if (shieldValue <= 0n) {
    throw new Error(
      'Shield amount must be greater than the relayer fee. Lower the fee or raise the amount.',
    )
  }
  const shieldPrivateKey = deriveShieldPrivateKey(sigHex)
  const request = await createShieldRequest(
    railgunAddress,
    shieldValue,
    hubUsdcAddress,
    shieldPrivateKey,
  )
  if (ctx.signal.aborted) throw new Error('cancelled')

  // Phase B4 — gasless path also requires an EIP-2612 USDC permit on the CLIENT chain (the
  // chain where the user's USDC lives + where the wrapper will pull from). Sign it here so the
  // two wallet prompts (RAILGUN_SHIELD then permit) surface back-to-back; the submit stage is
  // then network-only with no further user interaction. Permit value = the entered `amount`;
  // the wrapper splits it on-chain: `(amount - fee)` burned through CCTP, `fee` to the relayer.
  let permitV: number | undefined
  let permitR: `0x${string}` | undefined
  let permitS: `0x${string}` | undefined
  if (record.meta.useGasless) {
    if (
      record.meta.feeAmount === undefined ||
      record.meta.wrapperAddress === undefined ||
      record.meta.permitDeadline === undefined
    ) {
      throw new Error(
        'Shield-xchain gasless mode requires feeAmount + wrapperAddress + permitDeadline in meta.',
      )
    }
    const ownerCaptured = record.walletContext.evmAddress
    if (!ownerCaptured) {
      throw new Error('Cross-chain deposit requires a connected EVM wallet; none captured at submit time.')
    }
    const sig = await signUsdcPermit({
      usdcAddress: clientUsdcAddress as `0x${string}`,
      chainId: record.meta.fromChainId,
      owner: ownerCaptured as `0x${string}`,
      spender: record.meta.wrapperAddress as `0x${string}`,
      value: record.meta.amount,
      deadline: BigInt(record.meta.permitDeadline),
    })
    permitV = sig.v
    permitR = sig.r
    permitS = sig.s
    if (ctx.signal.aborted) throw new Error('cancelled')
  }

  await ctx.upsert(advance(record, 'submit-relayer', {
    shieldRequest: {
      npk: request.npk,
      value: request.value.toString(),
      encryptedBundle: request.encryptedBundle,
      shieldKey: request.shieldKey,
    },
    privacyPoolAddress,
    privacyPoolClientAddress,
    clientUsdcAddress,
    hubUsdcAddress,
    ...(permitV !== undefined ? { permitV, permitR, permitS } : {}),
  }))
}

async function runSubmitAndBurn(
  record: TxRecord<'shield-xchain'>,
  ctx: Parameters<typeof shieldXchainHandler.run>[1],
): Promise<void> {
  const artifacts = record.artifacts
  const shieldRequest = artifacts.shieldRequest
  const privacyPoolClientAddress = artifacts.privacyPoolClientAddress
  const clientUsdcAddress = artifacts.clientUsdcAddress
  if (!shieldRequest || !privacyPoolClientAddress || !clientUsdcAddress) {
    throw new Error('Shield-xchain artifacts missing — re-run build-proof stage.')
  }

  if (record.meta.useGasless) {
    await runGaslessSubmit(record, ctx)
  } else {
    await runDirectSubmit(record, ctx)
  }
}

/**
 * Phase A direct-submit path: user signs USDC `approve` + `PrivacyPoolClient.crossChainShield`
 * from their wallet, paying native gas on the source client chain. Same flow that's been in
 * production through Phase A — kept unchanged so a relayer outage / explicit override still
 * has a working cross-chain shield.
 */
async function runDirectSubmit(
  record: TxRecord<'shield-xchain'>,
  ctx: Parameters<typeof shieldXchainHandler.run>[1],
): Promise<void> {
  const artifacts = record.artifacts
  const shieldRequest = artifacts.shieldRequest!
  const privacyPoolClientAddress = artifacts.privacyPoolClientAddress!
  const clientUsdcAddress = artifacts.clientUsdcAddress!

  const ownerCaptured = record.walletContext.evmAddress
  if (!ownerCaptured) {
    throw new Error('Cross-chain deposit requires a connected EVM wallet; none captured at submit time.')
  }
  const owner = ownerCaptured as `0x${string}`

  // The user may have switched networks between build-proof and submit; re-assert before the
  // approve + crossChainShield calls. ensureChain is a no-op when already on target.
  await ensureChain(record.meta.fromChainId)
  if (ctx.signal.aborted) throw new Error('cancelled')

  // 1. Ensure USDC allowance from the user to the PrivacyPoolClient. The client contract
  //    `safeTransferFrom`s the user's tokens; we need the allowance set first. Max-approve to
  //    avoid prompting again on subsequent cross-chain shields from the same chain.
  const allowance = await readContract(wagmiConfig, {
    address: clientUsdcAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, privacyPoolClientAddress as `0x${string}`],
  })
  if (ctx.signal.aborted) throw new Error('cancelled')

  if (allowance < record.meta.amount) {
    const approveHash = await writeContract(wagmiConfig, {
      address: clientUsdcAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'approve',
      args: [privacyPoolClientAddress as `0x${string}`, maxUint256],
    })
    await waitForReceiptOrFail({ hash: approveHash, signal: ctx.signal, chainId: record.meta.fromChainId })
  }

  const { destinationCaller, maxFee, minFinalityThreshold } = await resolveCctpSubmitParams(record)

  // 2. Submit the cross-chain shield on the CLIENT chain via the connected wallet.
  const calldata = encodeFunctionData({
    abi: PRIVACY_POOL_CLIENT_SHIELD_ABI,
    functionName: 'crossChainShield',
    args: [
      record.meta.amount,
      maxFee,
      minFinalityThreshold,
      shieldRequest.npk as `0x${string}`,
      shieldRequest.encryptedBundle as readonly [`0x${string}`, `0x${string}`, `0x${string}`],
      shieldRequest.shieldKey as `0x${string}`,
      destinationCaller,
      ethers.ZeroAddress as `0x${string}`, // integrator: no fee routing for direct user shields
    ],
  })

  const hash = await sendTransaction(wagmiConfig, {
    to: privacyPoolClientAddress as `0x${string}`,
    data: calldata,
    value: 0n,
    chainId: record.meta.fromChainId,
  })

  await finalizeBurnAndAdvance(record, ctx, hash)
}

/**
 * Phase B4 gasless cross-chain shield path: encode `gaslessCrossChainShield(...)` calldata from
 * the permit signature + ShieldRequest captured in build-proof, POST to /relay with the SOURCE
 * client chain id, wait for the source-chain receipt, then continue with the same CCTP nonce
 * extraction + hub-block snapshot the direct path uses.
 *
 * Zero EVM wallet prompts in this stage — the user already signed RAILGUN_SHIELD + USDC permit
 * during build-proof. The relayer broadcasts on the user's behalf and pays gas in the source
 * chain's native token; the wrapper pulls `amount + fee` USDC from the user via the permit
 * and reimburses the relayer.
 */
async function runGaslessSubmit(
  record: TxRecord<'shield-xchain'>,
  ctx: Parameters<typeof shieldXchainHandler.run>[1],
): Promise<void> {
  const artifacts = record.artifacts
  const shieldRequest = artifacts.shieldRequest!
  const permitV = artifacts.permitV
  const permitR = artifacts.permitR
  const permitS = artifacts.permitS
  if (permitV === undefined || permitR === undefined || permitS === undefined) {
    throw new Error('Shield-xchain gasless submit requires permit (v, r, s) in artifacts — re-run build-proof.')
  }
  if (
    record.meta.feeAmount === undefined ||
    record.meta.wrapperAddress === undefined ||
    record.meta.permitDeadline === undefined
  ) {
    throw new Error('Shield-xchain gasless submit requires gasless meta fields — re-run build-proof.')
  }
  const ownerCaptured = record.walletContext.evmAddress
  if (!ownerCaptured) {
    throw new Error('Shield-xchain gasless submit requires a connected EVM wallet; none captured at submit time.')
  }

  const { destinationCaller, maxFee, minFinalityThreshold } = await resolveCctpSubmitParams(record)

  const data = buildGaslessCrossChainShieldCalldata({
    user: ownerCaptured as `0x${string}`,
    totalAmount: record.meta.amount,
    fee: record.meta.feeAmount,
    deadline: BigInt(record.meta.permitDeadline),
    v: permitV,
    r: permitR as `0x${string}`,
    s: permitS as `0x${string}`,
    maxFee,
    minFinalityThreshold,
    shieldRequest: {
      npk: shieldRequest.npk as `0x${string}`,
      value: BigInt(shieldRequest.value),
      encryptedBundle: shieldRequest.encryptedBundle as readonly [
        `0x${string}`,
        `0x${string}`,
        `0x${string}`,
      ],
      shieldKey: shieldRequest.shieldKey as `0x${string}`,
    },
    destinationCaller,
    integrator: ethers.ZeroAddress as `0x${string}`,
  })

  let submitResponse
  try {
    submitResponse = await submitRelay(
      {
        chainId: record.meta.fromChainId,
        to: record.meta.wrapperAddress,
        data,
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

  await finalizeBurnAndAdvance(record, ctx, submitResponse.txHash as `0x${string}`)
}

/**
 * Per-submit CCTP params resolved from the loaded deployment + network mode. Shared across both
 * direct and gasless submit branches so the on-chain inputs (destinationCaller, maxFee,
 * minFinalityThreshold) stay identical regardless of who broadcasts the tx.
 */
async function resolveCctpSubmitParams(record: TxRecord<'shield-xchain'>): Promise<{
  destinationCaller: `0x${string}`
  maxFee: bigint
  minFinalityThreshold: number
}> {
  // destinationCaller = the HUB's hookRouter, in bytes32 form. Constrains who can call
  // receiveMessage on the hub MessageTransmitter so only our atomic-delivery path executes.
  const deployments = await loadDeployments()
  const hubHookRouter = deployments.hub.contracts.hookRouter
  const destinationCaller =
    hubHookRouter && hubHookRouter !== ethers.ZeroAddress
      ? pad(hubHookRouter as `0x${string}`, { size: 32 })
      : (`0x${'00'.repeat(32)}` as `0x${string}`)

  // maxFee = upper bound CCTP's MessageTransmitter accepts for `feeExecuted`. Iris sets the
  // actual fee (1–1.3 bps depending on chain); we pass 2× the realistic estimate as headroom.
  // Computed locally from amount, no relayer round-trip needed.
  const maxFee = cctpMaxFeeForKind('shield-xchain', record.meta.amount)

  // minFinalityThreshold = FAST (1000) on Sepolia testing, else 0 which the contract resolves
  // to STANDARD as the safe default. CCTPHookRouter on the hub handles both threshold values.
  const minFinalityThreshold = getNetworkConfig().mode === 'sepolia' ? 1000 : 0

  return { destinationCaller, maxFee, minFinalityThreshold }
}

/**
 * Common post-broadcast plumbing: persist sourceTxHash, wait for the source-chain receipt,
 * extract the CCTP MessageSent event, snapshot the hub head, advance to client-burn-confirmed.
 * Identical between direct and gasless paths because the receipt sits on the same client chain
 * regardless of broadcaster identity — the CCTP MessageSent event is emitted by the wrapper
 * call in both modes.
 */
async function finalizeBurnAndAdvance(
  record: TxRecord<'shield-xchain'>,
  ctx: Parameters<typeof shieldXchainHandler.run>[1],
  hash: `0x${string}`,
): Promise<void> {
  // Persist sourceTxHash before the receipt wait so any timeout / revert / cancel error carries
  // the hash forward into the error UX (explorer link, "Stopped tracking" copy). The patched
  // record MUST be threaded into the final advance below — `record` is now stale (lower
  // updatedSeq than the atom/IDB) so an advance from it would produce an equal-seq write that
  // OCC silently drops, leaving the executor looping on this stage.
  const broadcastRecord = patchArtifacts(record, { sourceTxHash: hash })
  await ctx.upsert(broadcastRecord)
  if (ctx.signal.aborted) throw new Error('cancelled')

  // Use the client chain's public client to wait for the receipt + extract the CCTP MessageSent
  // event. The receipt is on the source chain regardless of who broadcast the tx, so this works
  // for both direct (user wallet) and gasless (relayer) paths.
  const receipt = await waitForReceiptOrFail({
    hash,
    signal: ctx.signal,
    chainId: record.meta.fromChainId,
  })

  const deployments = await loadDeployments()
  const cctpRef = extractCctpMessageFromReceipt({
    logs: receipt.logs,
    messageTransmitterAddress: deployments.clients.find(c => c.chainId === record.meta.fromChainId)!
      .cctp.messageTransmitter as `0x${string}`,
  })
  if (!cctpRef) {
    throw new Error('No CCTP MessageSent log in client tx receipt — cross-chain delivery cannot be tracked.')
  }

  // Snapshot the HUB chain's current head so the delivery scan starts from now, not history.
  const hubClient = getPublicClient(wagmiConfig, { chainId: getNetworkConfig().hub.chainId })
  if (!hubClient) {
    throw new Error('No wagmi public client for hub chain')
  }
  const hubFromBlock = await hubClient.getBlockNumber()

  if (record.meta.useGasless) {
    track('tx.relayer.confirmed', { id: record.id, kind: record.kind })
  }

  await ctx.upsert(advance(broadcastRecord, 'client-burn-confirmed', {
    sourceTxHash: hash,
    messageHash: cctpRef.messageHash,
    cctpNonce: cctpRef.nonce,
    destFromBlock: hubFromBlock.toString(),
  }))
}

async function runWaitForDelivery(
  record: TxRecord<'shield-xchain'>,
  ctx: Parameters<typeof shieldXchainHandler.run>[1],
): Promise<void> {
  const deployments = await loadDeployments()
  const hubChainId = getNetworkConfig().hub.chainId
  const hubMessageTransmitter = deployments.hub.cctp.messageTransmitter as `0x${string}`
  // CCTP V2 destination scan: we can't filter on the indexed `nonce` topic. V2's nonce slot is
  // bytes32(0) on outbound MessageSent; the destination contract emits an Iris-assigned
  // `eventNonce` which isn't derivable from the source side. So we drop the topic filter and
  // identify ours by looking inside the messageBody's hookData for a unique-per-tx marker.
  // For shield-xchain that marker is `encryptedBundle[0]` — fresh randomness generated by the
  // Railgun SDK at shield-request time, so unique with overwhelming probability.
  const shieldRequest = record.artifacts.shieldRequest
  if (!shieldRequest?.encryptedBundle?.[0]) {
    throw new Error('Missing shieldRequest.encryptedBundle artifact — cannot identify destination delivery.')
  }
  const uniqueMarker = shieldRequest.encryptedBundle[0].slice(2).toLowerCase()
  // Build an ethers JsonRpcProvider for the hub chain. We deliberately bypass viem here so the
  // app-wide bisecting `eth_getLogs` patch (lib/rpc-bisecting.ts, installed in main.tsx) applies
  // — free-tier RPCs (Alchemy = 10-block cap) reject the configured 5_000-block window outright,
  // and only the bisector recovers automatically.
  const hubChain = getChainById(hubChainId)
  if (!hubChain) {
    throw new Error(`No chain config for hub chain ${hubChainId}`)
  }
  const hubProvider = createProvider(hubChain.rpcUrls)
  const hubMessageReceivedTopic = messageReceivedTopic()

  let cursor = markWaiting(record)
  await ctx.upsert(cursor)

  let scanFromBlock = record.artifacts.destFromBlock
    ? BigInt(record.artifacts.destFromBlock)
    : 0n
  const maxLogRange = BigInt(getNetworkConfig().maxLogRange)

  // Derive the inner poll timeout from the per-kind lifecycle cap, minus elapsed time. The
  // hardcoded 10min that lived here previously ignored the outer 60min xchain budget — a slow
  // Iris attestation would time us out with ~50 min still on the lifecycle clock.
  const lifecycle = lifecycleFor(record.kind)
  const remainingBudgetMs = record.createdAt + lifecycle.maxDurationMs - Date.now()
  const POLL_FLOOR_MS = 10_000
  if (remainingBudgetMs < POLL_FLOOR_MS) {
    track('tx.budget.tight', {
      id: record.id,
      kind: record.kind,
      elapsedMs: Date.now() - record.createdAt,
    })
  }
  const pollTimeoutMs = Math.max(POLL_FLOOR_MS, remainingBudgetMs)

  const result = await poll<`0x${string}`>(
    async (signal) => {
      if (signal.aborted) return null
      const outcome = await scanCctpDeliveryWindow<EthersScanLog>({
        getBlockNumber: async () => BigInt(await hubProvider.getBlockNumber()),
        // Filter on the MessageReceived topic only — V2 puts an Iris-assigned `eventNonce` in
        // the indexed `nonce` topic that we can't predict source-side. The matchPredicate below
        // narrows by hookData content (uniqueMarker = encryptedBundle[0]).
        getLogsForRange: (fromBlock, toBlock) => hubProvider.getLogs({
          address: hubMessageTransmitter,
          topics: [hubMessageReceivedTopic],
          fromBlock,
          toBlock,
        }),
        matchPredicate: (log) => {
          try {
            const parsed = MESSAGE_RECEIVED_IFACE.parseLog({
              topics: Array.from(log.topics),
              data: log.data,
            })
            const body = parsed?.args.messageBody as string | undefined
            return typeof body === 'string' && body.toLowerCase().includes(uniqueMarker)
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

      scanFromBlock = outcome.nextScanFromBlock
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
    // Cancel/dismiss already wrote the terminal state — no-op so we don't OCC-collide.
    return
  }
  if (result.status !== 'done') {
    throw asTxError({
      code: 'POLL_TIMEOUT',
      message: 'Timed out waiting for cross-chain delivery. The hub mint may still occur — check the hub explorer.',
      txHash: record.artifacts.sourceTxHash,
    })
  }

  // Walk through the three intermediate stages with brief gaps so the stepper renders each row
  // as "current" rather than flashing through transitions in a single frame. Same pattern as the
  // inverse-direction handler — see its docstring for the visual-delay rationale.
  const STAGE_VISUAL_DELAY_MS = 350
  const skipStages = ['iris-attestation-ready', 'hub-mint-pending', 'hub-mint-confirmed'] as const
  for (let i = 0; i < skipStages.length; i++) {
    // Abort check BEFORE the upsert — cancel/dismiss may have fired during the delay below or
    // during the upsert latency, and we don't want to clobber the already-written terminal state.
    if (ctx.signal.aborted) return
    const next = skipStages[i]!
    cursor = advance(cursor, next, next === 'hub-mint-confirmed' ? { destTxHash: result.value } : {})
    await ctx.upsert(cursor)
    if (i < skipStages.length - 1) {
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, STAGE_VISUAL_DELAY_MS)
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
      })
      if (ctx.signal.aborted) return
    }
  }

  // The shield commitment is now on the hub merkle tree — refresh balances so the UI ticks up.
  if (kmIsUnlocked()) {
    void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
  }
}
