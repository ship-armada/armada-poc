// ABOUTME: Cross-chain shield handler — dual-mode (direct user-wallet submit OR Phase B4 permit-based gasless via GaslessShieldWrapperClient).
// ABOUTME: Mirrors unshield-xchain but flipped direction: burn on CLIENT → mint on HUB. Hub-side delivery polling identical across both submission modes.

import { encodeFunctionData } from 'viem'
import {
  getPublicClient,
  readContract,
  sendTransaction,
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
  generateRandomShieldPrivateKey,
} from '@/lib/railgun/shield'
import { extractCctpMessageFromReceipt, messageReceivedTopic } from '@/lib/cctp'
import { cctpMaxFeeForKind, submitRelay, fetchCctpDeliveryStatus } from '@/lib/relayer'
import { handleRelaySubmitError } from '@/lib/tx/relaySubmit'
import { signUsdcPermit } from '@/lib/wallet/permit'
import { buildGaslessCrossChainShieldCalldata } from '@/lib/wallet/gasless-cross-chain-shield'
import {
  computeShieldDataHash,
  readIntentNonce,
  signCrossChainShieldIntent,
  toShieldDataStruct,
  type ShieldDataStruct,
} from '@/lib/wallet/shield-intent'
import { ensureChain } from '@/lib/network-switch'
import { advance, markFailed, markWaiting, patchArtifacts } from '@/lib/tx/reducer'
import { recordBroadcastHash } from '@/lib/tx/broadcast'
import { poll, pollBudgetMs } from '@/lib/tx/poller'
import { asTxError, waitForReceiptOrFail } from '@/lib/tx/receipt'
import { simulateOrThrow } from '@/lib/tx/simulate'
import { classifyHandlerError } from '@/lib/tx/errors'
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
      await ctx.upsert(markFailed(record, classifyHandlerError(err, 'Cross-chain deposit failed.', record.artifacts.sourceTxHash, record.meta.fromChainId)))
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

  // Same flow as same-chain shield: generate an ephemeral per-deposit shieldPrivateKey and ask
  // the engine to build the ShieldRequest. Cross-chain doesn't change the off-chain ZK
  // construction — only what we do with the result on-chain. See lib/railgun/shield.ts for why
  // randomness is correct (the Railgun-convention wallet prompt is unnecessary in our model).
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
  const shieldPrivateKey = generateRandomShieldPrivateKey()
  const request = await createShieldRequest(
    railgunAddress,
    shieldValue,
    hubUsdcAddress,
    shieldPrivateKey,
  )
  if (ctx.signal.aborted) throw new Error('cancelled')

  // Phase C — gasless path: build the relayer fee note (a second note carried across CCTP, minted
  // on the hub at full value), then sign an EIP-2612 USDC permit on the CLIENT chain AND an EIP-712
  // CrossChainShieldIntent binding both notes + the CCTP maxFee/finality. All wallet prompts surface
  // here back-to-back; the submit stage is network-only. Permit value = the entered `amount`.
  const gaslessArtifacts = record.meta.useGasless
    ? await buildGaslessXchainArtifacts(record, ctx, request, clientUsdcAddress, hubUsdcAddress)
    : undefined

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
    ...(gaslessArtifacts ?? {}),
  }))
}

/**
 * Build the gasless-specific artifacts for the cross-chain path: the relayer fee note (hub-usdc
 * denominated), the CLIENT-chain EIP-2612 permit, and the EIP-712 CrossChainShieldIntent binding
 * both notes + the CCTP `maxFee`/finality (resolved here so the submit stage passes the same values
 * the user signed). Gasless shields carry no integrator (address(0)).
 */
async function buildGaslessXchainArtifacts(
  record: TxRecord<'shield-xchain'>,
  ctx: Parameters<typeof shieldXchainHandler.run>[1],
  userNote: Awaited<ReturnType<typeof createShieldRequest>>,
  clientUsdcAddress: string,
  hubUsdcAddress: string,
): Promise<{
  permitV: number
  permitR: `0x${string}`
  permitS: `0x${string}`
  feeNote: { npk: `0x${string}`; value: string; encryptedBundle: readonly [`0x${string}`, `0x${string}`, `0x${string}`]; shieldKey: `0x${string}` }
  feeShieldRandom: string
  intentSig: `0x${string}`
  intentNonce: string
  intentMaxFee: string
  intentMinFinality: number
}> {
  if (
    record.meta.feeAmount === undefined ||
    record.meta.wrapperAddress === undefined ||
    record.meta.permitDeadline === undefined ||
    record.meta.broadcasterRailgunAddress === undefined
  ) {
    throw new Error(
      'Shield-xchain gasless mode requires feeAmount + wrapperAddress + permitDeadline + broadcasterRailgunAddress in meta.',
    )
  }
  const ownerCaptured = record.walletContext.evmAddress
  if (!ownerCaptured) {
    throw new Error('Cross-chain deposit requires a connected EVM wallet; none captured at submit time.')
  }
  const owner = ownerCaptured as `0x${string}`
  const wrapper = record.meta.wrapperAddress as `0x${string}`
  const deadline = BigInt(record.meta.permitDeadline)

  // Fee note is HUB-usdc denominated — the commitment is minted on the hub after CCTP delivery.
  const feeShieldPrivateKey = generateRandomShieldPrivateKey()
  const feeNote = await createShieldRequest(
    record.meta.broadcasterRailgunAddress,
    record.meta.feeAmount,
    hubUsdcAddress,
    feeShieldPrivateKey,
  )
  if (ctx.signal.aborted) throw new Error('cancelled')

  // Gasless cross-chain shields carry no integrator (address(0)).
  const userNoteStruct = toShieldDataStruct(userNote, ethers.ZeroAddress as `0x${string}`)
  const feeNoteStruct = toShieldDataStruct(feeNote, ethers.ZeroAddress as `0x${string}`)
  const { maxFee, minFinalityThreshold } = await resolveCctpSubmitParams(record)
  const intentNonce = await readIntentNonce(wrapper, record.meta.fromChainId, owner)

  // 1. EIP-2612 permit for the full total on the CLIENT chain (both notes' value).
  const permitSig = await signUsdcPermit({
    usdcAddress: clientUsdcAddress as `0x${string}`,
    chainId: record.meta.fromChainId,
    owner,
    spender: wrapper,
    value: record.meta.amount,
    deadline,
  })
  if (ctx.signal.aborted) throw new Error('cancelled')

  // 2. EIP-712 CrossChainShieldIntent binding both note hashes + CCTP params + deadline + nonce.
  const intentSig = await signCrossChainShieldIntent({
    wrapperAddress: wrapper,
    chainId: record.meta.fromChainId,
    user: owner,
    userNoteHash: computeShieldDataHash(userNoteStruct),
    feeNoteHash: computeShieldDataHash(feeNoteStruct),
    maxFee,
    minFinalityThreshold,
    deadline,
    nonce: intentNonce,
  })
  if (ctx.signal.aborted) throw new Error('cancelled')

  return {
    permitV: permitSig.v,
    permitR: permitSig.r,
    permitS: permitSig.s,
    feeNote: {
      npk: feeNote.npk,
      value: feeNote.value.toString(),
      encryptedBundle: feeNote.encryptedBundle,
      shieldKey: feeNote.shieldKey,
    },
    feeShieldRandom: feeNote.random,
    intentSig,
    intentNonce: intentNonce.toString(),
    intentMaxFee: maxFee.toString(),
    intentMinFinality: minFinalityThreshold,
  }
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

  // Idempotency guard (P0-1): once the client-chain crossChainShield broadcast we persist its
  // hash. NEVER re-send — a second crossChainShield is a second real USDC burn. On re-entry
  // (Retry after a delivery timeout / resume-on-reload) finalize on the known hash instead.
  if (artifacts.sourceTxHash) {
    await finalizeBurnAndAdvance(record, ctx, artifacts.sourceTxHash)
    return
  }

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
    chainId: record.meta.fromChainId,
  })
  if (ctx.signal.aborted) throw new Error('cancelled')

  // S-M4: thread a `working` record through the wallet prompts so the stepper shows "Confirm in
  // your wallet" (markWaiting) while each prompt is open, and record the approve leg in artifacts
  // (approveTxHash / approveSkipped) for the WalletConfirmList checklist.
  let working: TxRecord<'shield-xchain'> = record
  if (allowance < record.meta.amount) {
    working = markWaiting(working)
    await ctx.upsert(working)
    const approveHash = await writeContract(wagmiConfig, {
      address: clientUsdcAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'approve',
      args: [privacyPoolClientAddress as `0x${string}`, maxUint256],
      chainId: record.meta.fromChainId,
    })
    await waitForReceiptOrFail({ hash: approveHash, signal: ctx.signal, chainId: record.meta.fromChainId })
    if (ctx.signal.aborted) throw new Error('cancelled')
    working = advance(working, 'submit-relayer', { approveTxHash: approveHash })
    await ctx.upsert(working)
  } else {
    working = patchArtifacts(working, { approveSkipped: true })
    await ctx.upsert(working)
  }

  const { maxFee, minFinalityThreshold } = await resolveCctpSubmitParams(record)

  // 2. Submit the cross-chain shield on the CLIENT chain via the connected wallet.
  //    The CCTP destinationCaller is pinned to hubHookRouter by PrivacyPoolClient (issue #64) — not
  //    passed here.
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
      ethers.ZeroAddress as `0x${string}`, // integrator: no fee routing for direct user shields
    ],
  })

  // S-M8: pre-flight simulate so an on-chain revert surfaces as a typed PRE_FLIGHT_REVERT
  // ("nothing was sent") instead of MetaMask's opaque 30M-gas-fallback "gas limit too high".
  await simulateOrThrow({
    to: privacyPoolClientAddress as `0x${string}`,
    data: calldata,
    value: 0n,
    account: owner,
    chainId: record.meta.fromChainId,
  })
  if (ctx.signal.aborted) throw new Error('cancelled')

  // S-M4: "Confirm in your wallet" for the crossChainShield prompt (after simulate so a doomed tx
  // fails without prompting). finalizeBurnAndAdvance advances to client-burn-confirmed (active)
  // once the prompt is confirmed, restoring "Submitting" copy.
  working = markWaiting(working)
  await ctx.upsert(working)

  const hash = await sendTransaction(wagmiConfig, {
    to: privacyPoolClientAddress as `0x${string}`,
    data: calldata,
    value: 0n,
    chainId: record.meta.fromChainId,
  })

  await finalizeBurnAndAdvance(working, ctx, hash)
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

  // Idempotency guard (P0-1): never re-POST a gasless cross-chain shield we already submitted —
  // a duplicate gets a 409 and a fresh POST against an expired permit is doomed. On re-entry
  // finalize on the known hash instead.
  if (artifacts.sourceTxHash) {
    await finalizeBurnAndAdvance(record, ctx, artifacts.sourceTxHash)
    return
  }

  const shieldRequest = artifacts.shieldRequest!
  const { permitV, permitR, permitS, feeNote, intentSig, intentNonce, intentMaxFee, intentMinFinality, feeShieldRandom } =
    artifacts
  if (permitV === undefined || permitR === undefined || permitS === undefined) {
    throw new Error('Shield-xchain gasless submit requires permit (v, r, s) in artifacts — re-run build-proof.')
  }
  if (
    feeNote === undefined ||
    intentSig === undefined ||
    intentNonce === undefined ||
    intentMaxFee === undefined ||
    intentMinFinality === undefined ||
    feeShieldRandom === undefined
  ) {
    throw new Error('Shield-xchain gasless submit requires the fee note + intent artifacts — re-run build-proof.')
  }
  if (record.meta.wrapperAddress === undefined || record.meta.permitDeadline === undefined) {
    throw new Error('Shield-xchain gasless submit requires gasless meta fields — re-run build-proof.')
  }
  const ownerCaptured = record.walletContext.evmAddress
  if (!ownerCaptured) {
    throw new Error('Shield-xchain gasless submit requires a connected EVM wallet; none captured at submit time.')
  }

  // Permit-deadline guard (P0-1): an expired permit/intent makes the wrapper call revert, so
  // POSTing is doomed. Fail with honest copy. Nothing was sent (PRE_FLIGHT_REVERT).
  if (record.meta.permitDeadline * 1000 <= Date.now()) {
    throw asTxError({
      code: 'PRE_FLIGHT_REVERT',
      message: 'This quote expired before it could be submitted. Start a new transaction.',
    })
  }

  const zero = ethers.ZeroAddress as `0x${string}`
  // Reconstruct the exact userNote + feeNote the intent was signed over. maxFee/finality come from
  // the STORED intent values (not recomputed) or the signature would mismatch.
  const userNote: ShieldDataStruct = toShieldDataStruct(
    {
      npk: shieldRequest.npk as `0x${string}`,
      value: BigInt(shieldRequest.value),
      encryptedBundle: shieldRequest.encryptedBundle,
      shieldKey: shieldRequest.shieldKey as `0x${string}`,
      random: '',
    },
    zero,
  )
  const feeNoteStruct: ShieldDataStruct = toShieldDataStruct(
    {
      npk: feeNote.npk,
      value: BigInt(feeNote.value),
      encryptedBundle: feeNote.encryptedBundle,
      shieldKey: feeNote.shieldKey,
      random: feeShieldRandom,
    },
    zero,
  )
  const data = buildGaslessCrossChainShieldCalldata({
    user: ownerCaptured as `0x${string}`,
    deadline: BigInt(record.meta.permitDeadline),
    nonce: BigInt(intentNonce),
    maxFee: BigInt(intentMaxFee),
    minFinalityThreshold: intentMinFinality,
    permitV,
    permitR: permitR as `0x${string}`,
    permitS: permitS as `0x${string}`,
    intentSig,
    userNote,
    feeNote: feeNoteStruct,
  })

  let submitResponse
  try {
    submitResponse = await submitRelay(
      {
        chainId: record.meta.fromChainId,
        to: record.meta.wrapperAddress,
        data,
        feesCacheId: record.meta.feeCacheId,
        idempotencyKey: record.id,
        feeShieldRandom,
      },
      ctx.signal,
    )
  } catch (err) {
    // T-M3/S-M1: recover an already-broadcast hash from a DUPLICATE_TX so we resume polling
    // instead of failing a tx the relayer already sent; non-recoverable errors rethrow.
    submitResponse = handleRelaySubmitError(err, { id: record.id, kind: record.kind })
  }

  track('tx.relayer.submitted', { id: record.id, kind: record.kind })

  await finalizeBurnAndAdvance(record, ctx, submitResponse.txHash as `0x${string}`)
}

/**
 * Per-submit CCTP params resolved from the loaded deployment + network mode. Shared across both
 * direct and gasless submit branches so the on-chain inputs (maxFee, minFinalityThreshold) stay
 * identical regardless of who broadcasts the tx. The CCTP destinationCaller is no longer resolved
 * here — PrivacyPoolClient pins it to its configured hubHookRouter at the contract level (issue #64).
 */
async function resolveCctpSubmitParams(record: TxRecord<'shield-xchain'>): Promise<{
  maxFee: bigint
  minFinalityThreshold: number
}> {
  // maxFee = upper bound CCTP's MessageTransmitter accepts for `feeExecuted`. Iris sets the
  // actual fee (1–1.3 bps depending on chain); we pass 2× the realistic estimate as headroom.
  // Computed locally from amount, no relayer round-trip needed.
  const maxFee = cctpMaxFeeForKind('shield-xchain', record.meta.amount)

  // minFinalityThreshold = FAST (1000) on Sepolia testing, else 0 which the contract resolves
  // to STANDARD as the safe default. CCTPHookRouter on the hub handles both threshold values.
  const minFinalityThreshold = getNetworkConfig().mode === 'sepolia' ? 1000 : 0

  return { maxFee, minFinalityThreshold }
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
  const broadcast = await recordBroadcastHash(record, hash, ctx)
  if (broadcast.dismissed) return
  const broadcastRecord = broadcast.record

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

  // Derive the inner poll timeout from the per-kind lifecycle cap minus elapsed time, crediting
  // back tab-hidden time (T-M5/S-M6) so a slow Iris attestation watched from a backgrounded tab
  // doesn't time out with budget still on the clock. pollBudgetMs floors at 10s + emits
  // tx.budget.tight when the floor engages.
  const pollTimeoutMs = pollBudgetMs(record)

  const result = await poll<`0x${string}`>(
    async (signal) => {
      if (signal.aborted) return null
      // T-M7 Option B primary: ask the relayer for authoritative CCTP delivery status (it performs
      // the hub mint in both mock + real mode and tracks Iris). Falls through to the on-chain scan
      // below when the endpoint is unavailable (not deployed / relayer down) — no hard dependency.
      const messageHash = record.artifacts.messageHash
      if (messageHash) {
        const relayed = await fetchCctpDeliveryStatus(messageHash, signal)
        if (relayed.kind === 'delivered') return relayed.destTxHash
        if (relayed.kind === 'pending') return null
        if (relayed.kind === 'failed') {
          throw asTxError({
            code: 'TX_REVERTED',
            message: relayed.error ?? 'Cross-chain delivery failed on the hub chain.',
            txHash: record.artifacts.sourceTxHash,
          })
        }
        // relayed.kind === 'unavailable' → fall through to the on-chain scan.
      }
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
      // A cancel/dismiss may have fired during the async scan above. Skip the cursor persist so we
      // don't resurrect a record abortAndMark has already moved to a terminal state. (P0-3 WS1.2b)
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
