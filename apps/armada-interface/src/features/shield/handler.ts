// ABOUTME: Shield stage handler — dual-mode (direct user-wallet submit OR Phase B3 permit-based gasless via wrapper).
// ABOUTME: build-proof generates an ephemeral shieldPrivateKey (+ EIP-2612 permit when gasless); submit-relayer either writeContract or POST /relay.

import {
  readContract,
  writeContract,
} from 'wagmi/actions'
import { asTxError, waitForReceiptOrFail } from '@/lib/tx/receipt'
import { classifyHandlerError } from '@/lib/tx/errors'
import { erc20Abi, maxUint256 } from 'viem'
import { wagmiConfig } from '@/config/wagmi'
import { loadDeployments } from '@/config/deployments'
import { getIntegratorAddress } from '@/config/network'
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
import { signUsdcPermit } from '@/lib/wallet/permit'
import { buildGaslessShieldCalldata } from '@/lib/wallet/gasless-shield'
import { submitRelay, RelayerError } from '@/lib/relayer'
import { poll, pollBudgetMs, pollRelayStatusOnce } from '@/lib/tx/poller'
import { ensureChain } from '@/lib/network-switch'
import { advance, markFailed } from '@/lib/tx/reducer'
import { recordBroadcastHash } from '@/lib/tx/broadcast'
import { track } from '@/lib/telemetry'
import type { StageHandler } from '@/lib/tx/executor'
import type { TxError, TxRecord } from '@/lib/tx/types'

// PrivacyPool.shield ABI — the hub-side direct shield entry point. `integrator` lets the
// contract route fees to a third party; we always pass ZeroAddress for direct user shields.
// We carry the inline tuple/enum naming so viem can encode the calldata correctly.
const PRIVACY_POOL_SHIELD_ABI = [
  {
    type: 'function',
    name: 'shield',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: '_shieldRequests',
        type: 'tuple[]',
        components: [
          {
            name: 'preimage',
            type: 'tuple',
            components: [
              { name: 'npk', type: 'bytes32' },
              {
                name: 'token',
                type: 'tuple',
                components: [
                  { name: 'tokenType', type: 'uint8' },
                  { name: 'tokenAddress', type: 'address' },
                  { name: 'tokenSubID', type: 'uint256' },
                ],
              },
              { name: 'value', type: 'uint120' },
            ],
          },
          {
            name: 'ciphertext',
            type: 'tuple',
            components: [
              { name: 'encryptedBundle', type: 'bytes32[3]' },
              { name: 'shieldKey', type: 'bytes32' },
            ],
          },
        ],
      },
      { name: 'integrator', type: 'address' },
    ],
    outputs: [],
  },
] as const

/**
 * Shield stage handler. Two submission paths share the same lifecycle stages — `build-proof`
 * always produces the ShieldRequest from the user's signature, and `submit-relayer` then either
 * routes through the user's EVM wallet (direct) or the relayer-mediated wrapper (gasless).
 *
 *   1. `build-proof`    — sign 'RAILGUN_SHIELD' → derive shieldPrivateKey → build ShieldRequest.
 *                         When gasless: ALSO sign an EIP-2612 USDC permit for `amount + fee` to
 *                         the wrapper address. Both prompts surface to the user in succession.
 *   2. `submit-relayer` — direct path: approve USDC + writeContract(PrivacyPool.shield).
 *                         gasless path: encode `gaslessShield(...)` calldata + POST /relay +
 *                         poll /status. No EVM wallet prompts after build-proof on this branch.
 *   3. `hub-confirmed`  — terminal. Kicks a balance refresh.
 *
 * "submit-relayer" is the framework's stage name for "tx on the wire" — for direct submit it's
 * the user's wallet, not the relayer. Same stage name regardless of path keeps the lifecycle +
 * UI uniform.
 */
export const shieldHandler: StageHandler<'shield'> = {
  kind: 'shield',
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
      if (record.stage === 'hub-confirmed') {
        // Terminal — reducer.advance already flipped executionState='completed' on the previous
        // transition, so the executor's loop won't re-enter run(). This branch is unreachable
        // under normal flow but kept defensive for resume-on-load scenarios.
        return
      }
    } catch (err) {
      // If the user cancelled / auto-lock fired, abortAndMark already wrote the terminal state.
      // The throw bubbling up here is the cooperative response to the abort signal — no-op so we
      // don't clobber the cancelled/dismissed record with a failed one.
      if (ctx.signal.aborted) return
      const failed = markFailed(record, classifyHandlerError(err, 'Shield failed.', record.artifacts.sourceTxHash))
      await ctx.upsert(failed)
    }
  },
}

async function runBuildProof(
  record: TxRecord<'shield'>,
  ctx: Parameters<typeof shieldHandler.run>[1],
): Promise<void> {
  // Resolve dependencies the handler needs from outside the record itself. The handler doesn't
  // capture these at submit-time because they're not serializable / are session-scoped.
  if (!kmIsUnlocked()) {
    throw new Error('Shield requires an unlocked shielded wallet.')
  }
  const railgunAddress = kmGetRailgunAddress()

  const deployments = await loadDeployments()
  const usdcAddress = deployments.hub.cctp.usdc
  const privacyPoolAddress = deployments.hub.contracts.privacyPool

  if (ctx.signal.aborted) throw new Error('cancelled')

  // Ensure the wallet is on the chain we're shielding FROM before any signature. Today the
  // handler only supports hub-to-hub shield (so meta.fromChainId == hub); once cross-chain
  // shield lands the same call will switch to the originating client chain instead.
  await ensureChain(record.meta.fromChainId)
  if (ctx.signal.aborted) throw new Error('cancelled')

  // shieldPrivateKey is an ephemeral per-deposit ECIES sender secret — used once at note
  // construction, never re-needed (the recipient's chain scan uses the on-chain `shieldKey` +
  // their viewing key to decrypt). Random generation eliminates the Railgun-convention
  // `personal_sign('RAILGUN_SHIELD')` wallet prompt; see lib/railgun/shield.ts for the full
  // rationale.

  // Determine the value that lands in the shielded commitment. For the gasless path the wrapper
  // takes `amount` from the user via permit, sends `fee` to the relayer, and shields the
  // remainder. The SDK's ShieldRequest must therefore reflect `amount - fee` so the on-chain
  // shield commitment matches what the user actually receives — the wrapper's contract pins
  // `preimage.value == totalAmount - fee` and reverts on mismatch. Direct submit shields the
  // full `amount` (user paid ETH gas separately; no relayer fee).
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
    usdcAddress,
    shieldPrivateKey,
  )
  if (ctx.signal.aborted) throw new Error('cancelled')

  // Phase B3 — gasless path also requires an EIP-2612 USDC permit. Sign it here, back-to-back
  // with the SHIELD_SIGNATURE_MESSAGE, so both wallet prompts surface to the user in one beat
  // rather than spread across the submit stage. Permit value = the entered `amount` (the
  // wrapper splits it on-chain: `(amount - fee)` to the pool, `fee` to the relayer).
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
        'Shield gasless mode requires feeAmount + wrapperAddress + permitDeadline in meta.',
      )
    }
    const ownerCaptured = record.walletContext.evmAddress
    if (!ownerCaptured) {
      throw new Error('Shield requires a connected EVM wallet; none captured at submit time.')
    }
    const sig = await signUsdcPermit({
      usdcAddress: usdcAddress as `0x${string}`,
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

  // Stash the request fields + permit signature components + addresses in artifacts so the next
  // stage can submit without re-running the (already-signed) build step on a resume.
  const next = advance(record, 'submit-relayer', {
    shieldRequest: {
      npk: request.npk,
      value: request.value.toString(), // bigint → string for IDB serializability
      encryptedBundle: request.encryptedBundle,
      shieldKey: request.shieldKey,
    },
    privacyPoolAddress,
    usdcAddress,
    ...(permitV !== undefined ? { permitV, permitR, permitS } : {}),
  })
  await ctx.upsert(next)
}

async function runSubmitAndConfirm(
  record: TxRecord<'shield'>,
  ctx: Parameters<typeof shieldHandler.run>[1],
): Promise<void> {
  const artifacts = record.artifacts
  const shieldRequest = artifacts.shieldRequest
  const privacyPoolAddress = artifacts.privacyPoolAddress
  const usdcAddress = artifacts.usdcAddress
  if (!shieldRequest || !privacyPoolAddress || !usdcAddress) {
    throw new Error('Shield artifacts missing — re-run build-proof stage.')
  }

  if (record.meta.useGasless) {
    await runGaslessSubmit(record, ctx)
  } else {
    await runDirectSubmit(record, ctx)
  }
}

/**
 * Phase A direct-submit path: user signs USDC `approve` + `PrivacyPool.shield(...)` from their
 * wallet. Same flow that's been in production through Phase A — kept unchanged so a relayer
 * outage / explicit override still has a working shield.
 */
async function runDirectSubmit(
  record: TxRecord<'shield'>,
  ctx: Parameters<typeof shieldHandler.run>[1],
): Promise<void> {
  const artifacts = record.artifacts
  const shieldRequest = artifacts.shieldRequest!
  const privacyPoolAddress = artifacts.privacyPoolAddress!
  const usdcAddress = artifacts.usdcAddress!

  // Idempotency guard (P0-1): once the shield has broadcast we persist its hash. NEVER re-send —
  // a second writeContract(shield) is a second real USDC deposit. On re-entry (Retry after a
  // POLL_TIMEOUT, or resume-on-reload) skip straight to waiting on the known receipt.
  let shieldHash = artifacts.sourceTxHash
  let broadcastRecord = record
  if (!shieldHash) {
    // The user may have changed networks between build-proof and submit; re-assert here.
    await ensureChain(record.meta.fromChainId)
    if (ctx.signal.aborted) throw new Error('cancelled')

    // 1. Ensure USDC allowance. We use the connected wallet's address (looked up via wagmi's
    //    getAccount under writeContract's hood). readContract is synchronous-ish; signal-checked
    //    around each long step.
    const ownerCaptured = record.walletContext.evmAddress
    if (!ownerCaptured) {
      throw new Error('Shield requires a connected EVM wallet; none captured at submit time.')
    }
    const owner = ownerCaptured as `0x${string}`
    const allowance = await readContract(wagmiConfig, {
      address: usdcAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, privacyPoolAddress as `0x${string}`],
    })
    if (ctx.signal.aborted) throw new Error('cancelled')

    if (allowance < record.meta.amount) {
      // Approve max — same UX trade-off as the legacy app (one approval, all future shields free).
      const approveHash = await writeContract(wagmiConfig, {
        address: usdcAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [privacyPoolAddress as `0x${string}`, maxUint256],
      })
      await waitForReceiptOrFail({ hash: approveHash, signal: ctx.signal })
      if (ctx.signal.aborted) throw new Error('cancelled')
    }

    // 2. Submit the shield tx. Compose the tuple from the stored artifacts.
    const shieldRequestTuple = {
      preimage: {
        npk: shieldRequest.npk as `0x${string}`,
        token: {
          tokenType: 0, // 0 = ERC20 per RailgunSmartWallet's TokenType enum
          tokenAddress: usdcAddress as `0x${string}`,
          tokenSubID: 0n,
        },
        value: BigInt(shieldRequest.value),
      },
      ciphertext: {
        encryptedBundle: shieldRequest.encryptedBundle as readonly [`0x${string}`, `0x${string}`, `0x${string}`],
        shieldKey: shieldRequest.shieldKey as `0x${string}`,
      },
    }
    shieldHash = await writeContract(wagmiConfig, {
      address: privacyPoolAddress as `0x${string}`,
      abi: PRIVACY_POOL_SHIELD_ABI,
      functionName: 'shield',
      args: [[shieldRequestTuple], getIntegratorAddress()],
    })
    // Persist the source tx hash immediately so any subsequent failure (timeout, revert, cancel)
    // carries the hash for the explorer-link UX, and so the idempotency guard above sees it on
    // re-entry. We MUST thread the patched record forward to the final advance: `record` is now
    // stale (updatedSeq lower than the atom/IDB), so an advance from `record` would produce an
    // equal-seq write that OCC silently drops, leaving the executor stuck re-entering this stage.
    const broadcast = await recordBroadcastHash(record, shieldHash, ctx)
    if (broadcast.dismissed) return
    broadcastRecord = broadcast.record
  }

  // 3. Wait for confirmation. The SDK's merkle scan will pick up the new commitment via the
  //    onBalanceUpdate callback — but we also kick a refresh explicitly so the UI doesn't have
  //    to wait for the SDK's poll interval. Timeout-and-signal-aware so a wedged RPC doesn't
  //    pin this handler for the full 10-min lifecycle cap.
  await waitForReceiptOrFail({ hash: shieldHash, signal: ctx.signal })

  if (kmIsUnlocked()) {
    // Fire-and-forget — failures here are non-fatal (the periodic refresh would catch it).
    void refreshShieldedBalances(kmGetWalletId()).catch(() => {})
  }

  const completed = advance(broadcastRecord, 'hub-confirmed', {
    sourceTxHash: shieldHash,
  })
  await ctx.upsert(completed)
}

/**
 * Phase B3 gasless-shield path: encode `gaslessShield(...)` calldata from the permit signature
 * + ShieldRequest captured in build-proof, POST to /relay, poll /status. Zero EVM wallet
 * prompts here — the user already signed both the RAILGUN_SHIELD message and the USDC permit
 * during build-proof, so this stage is purely network-side work.
 */
async function runGaslessSubmit(
  record: TxRecord<'shield'>,
  ctx: Parameters<typeof shieldHandler.run>[1],
): Promise<void> {
  // Idempotency guard (P0-1): once the relayer accepted the gaslessShield POST we persist the
  // returned txHash. NEVER re-POST — the relayer answers a duplicate with 409 and the user sees a
  // false failure, and a fresh POST against an expired permit is doomed. On re-entry skip to the
  // status poll for the known hash.
  let txHash = record.artifacts.sourceTxHash
  let broadcastRecord = record
  if (!txHash) {
    const artifacts = record.artifacts
    const shieldRequest = artifacts.shieldRequest!
    const usdcAddress = artifacts.usdcAddress!
    const permitV = artifacts.permitV
    const permitR = artifacts.permitR
    const permitS = artifacts.permitS
    if (permitV === undefined || permitR === undefined || permitS === undefined) {
      throw new Error('Shield gasless submit requires permit (v, r, s) in artifacts — re-run build-proof.')
    }
    if (
      record.meta.feeAmount === undefined ||
      record.meta.wrapperAddress === undefined ||
      record.meta.permitDeadline === undefined
    ) {
      throw new Error('Shield gasless submit requires gasless meta fields — re-run build-proof.')
    }
    const ownerCaptured = record.walletContext.evmAddress
    if (!ownerCaptured) {
      throw new Error('Shield gasless submit requires a connected EVM wallet; none captured at submit time.')
    }

    // Permit-deadline guard (P0-1): an expired EIP-2612 permit makes the wrapper call revert, so
    // re-POSTing is doomed. Fail with honest copy instead. Nothing was sent (PRE_FLIGHT_REVERT).
    if (record.meta.permitDeadline * 1000 <= Date.now()) {
      throw asTxError({
        code: 'PRE_FLIGHT_REVERT',
        message: 'This quote expired before it could be submitted. Start a new transaction.',
      })
    }

    const data = buildGaslessShieldCalldata({
      user: ownerCaptured as `0x${string}`,
      totalAmount: record.meta.amount,
      fee: record.meta.feeAmount,
      deadline: BigInt(record.meta.permitDeadline),
      v: permitV,
      r: permitR as `0x${string}`,
      s: permitS as `0x${string}`,
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
      tokenAddress: usdcAddress as `0x${string}`,
      integrator: getIntegratorAddress() as `0x${string}`,
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

    // Persist the relayer-broadcast txHash immediately — same OCC-correct patch-then-advance
    // dance the unshield handler uses, and the marker the idempotency guard above reads on re-entry.
    txHash = submitResponse.txHash as `0x${string}`
    const broadcast = await recordBroadcastHash(record, txHash, ctx)
    if (broadcast.dismissed) return
    broadcastRecord = broadcast.record
  }

  const pollResult = await poll(
    (signal) => pollRelayStatusOnce(txHash, signal, record.meta.fromChainId),
    { signal: ctx.signal, timeoutMs: pollBudgetMs(record) },
  )

  if (pollResult.status === 'aborted') throw new Error('cancelled')
  if (pollResult.status === 'timeout') {
    const error: TxError = {
      code: 'POLL_TIMEOUT',
      message:
        "The relayer hasn't reported a final status. The transaction may still complete on chain — check the explorer.",
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
      message: final.error ?? 'Relayer-broadcast tx reverted on chain.',
      txHash,
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
    sourceTxHash: txHash,
  })
  await ctx.upsert(completed)
}
