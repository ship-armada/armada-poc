// ABOUTME: Transaction lifecycle model — discriminated unions defining each TxKind's stages, artifacts, and meta.
// ABOUTME: Plan §7. All tx UX flows through these types; the same <TxLifecycleStepper> renders any kind.

export type TxKind =
  | 'shield'
  | 'shield-xchain'
  | 'unshield-local'
  | 'unshield-xchain'
  | 'transfer-shielded'
  | 'yield-deposit'
  | 'yield-withdraw'

/**
 * Execution lifecycle state — separate from the protocol stage so they don't
 * grow tangled meanings (e.g. an xchain unshield can be `waiting` for hours
 * during `iris-attestation-pending` without "submitted" losing meaning).
 *
 *  pending    — record created, executor has not started this stage yet
 *  active     — executor is currently running the stage
 *  waiting    — running but awaiting an external event (Iris attestation, mint receipt)
 *  retrying   — a retry attempt is in flight after a recoverable failure
 *  completed  — terminal success (stage === lifecycle.terminalSuccess)
 *  failed     — terminal failure (unrecoverable error)
 *  expired    — exceeded lifecycle.maxDurationMs without reaching a terminal state
 *  cancelled  — user-initiated abort
 */
export type TxExecutionState =
  | 'pending'
  | 'active'
  | 'waiting'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled'

/** A non-terminal state still has work to do (resumable / pollable). */
export const NON_TERMINAL_STATES: ReadonlyArray<TxExecutionState> = [
  'pending', 'active', 'waiting', 'retrying',
]

/* Stage unions — every TxKind declares its own sequence. Adding a stage means
 * adding to the union AND to the lifecycle definition in `lifecycles.ts`. */

export type StageShield =
  | 'build-proof'
  | 'submit-relayer'
  | 'hub-confirmed'

/**
 * Cross-chain shield: client chain → hub. User signs `crossChainShield` on the client's
 * PrivacyPoolClient (which burns USDC via CCTP with shield-payload hook data). The CCTP
 * message + attestation arrives on hub; the relayer/hookRouter atomically mints USDC at the
 * hookRouter and dispatches the shield, adding a commitment to the hub merkle tree.
 *
 * Stages mirror unshield-xchain's structure but flipped: burn happens on CLIENT (instead of
 * hub), mint happens on HUB (instead of client).
 */
export type StageShieldXchain =
  | 'build-proof'
  | 'submit-relayer'
  | 'client-burn-confirmed'
  | 'iris-attestation-pending'
  | 'iris-attestation-ready'
  | 'hub-mint-pending'
  | 'hub-mint-confirmed'

export type StageUnshieldLocal =
  | 'build-proof'
  | 'submit-relayer'
  | 'hub-confirmed'

export type StageUnshieldXchain =
  | 'build-proof'
  | 'submit-relayer'
  | 'hub-burn-confirmed'
  | 'iris-attestation-pending'
  | 'iris-attestation-ready'
  | 'client-mint-pending'
  | 'client-mint-confirmed'

export type StageTransferShielded =
  | 'build-proof'
  | 'submit-relayer'
  | 'hub-confirmed'

export type StageYieldDeposit =
  | 'build-proof'
  | 'submit-relayer'
  | 'hub-confirmed'

export type StageYieldWithdraw =
  | 'build-proof'
  | 'submit-relayer'
  | 'hub-confirmed'

export type TxStage =
  | StageShield
  | StageShieldXchain
  | StageUnshieldLocal
  | StageUnshieldXchain
  | StageTransferShielded
  | StageYieldDeposit
  | StageYieldWithdraw

/* Per-kind stage map — used to constrain `TxRecord<K>['stage']` to legal values. */
export type StageFor<K extends TxKind> =
  K extends 'shield' ? StageShield
  : K extends 'shield-xchain' ? StageShieldXchain
  : K extends 'unshield-local' ? StageUnshieldLocal
  : K extends 'unshield-xchain' ? StageUnshieldXchain
  : K extends 'transfer-shielded' ? StageTransferShielded
  : K extends 'yield-deposit' ? StageYieldDeposit
  : K extends 'yield-withdraw' ? StageYieldWithdraw
  : never

/* Meta — input parameters captured at tx submit time. */

export interface MetaCommon {
  /** USDC raw amount (6 decimals). */
  amount: bigint
  /** Fee quote attached to this submission. */
  feeCacheId: string
}

export interface MetaShield extends MetaCommon {
  /** Source chain id where USDC currently lives. */
  fromChainId: number
}

export interface MetaShieldXchain extends MetaCommon {
  /** Client chain id we're shielding FROM. Always a client (not hub) — the modal routes
   *  same-chain shield to `shield` instead. */
  fromChainId: number
}

export interface MetaUnshieldLocal extends MetaCommon {
  /** EVM recipient on the hub chain. */
  recipient: string
  /**
   * Broadcaster-fee amount (USDC raw) that the SNARK proof embeds as a payment to the relayer.
   * Captured from the FeeSchedule at submit-time; immutable for the record's lifetime. The
   * relayer's server-side verifier (Phase A2) compares this against its advertised fee and
   * rejects mismatches with `FEE_INSUFFICIENT`.
   */
  broadcasterFeeAmount: bigint
  /**
   * Relayer's Railgun (`0zk`) address that the SNARK proof's broadcaster output pays. Captured
   * from the FeeSchedule alongside the amount; if the operator rotates the relayer wallet
   * between submit and proof-build the proof would land in some OTHER wallet's outbox, so we
   * freeze the address with the rest of the submit state.
   */
  broadcasterRailgunAddress: string
}

export interface MetaUnshieldXchain extends MetaCommon {
  /** Destination client chain id. */
  toChainId: number
  /** EVM recipient on the destination chain. */
  recipient: string
}

export interface MetaTransferShielded extends MetaCommon {
  /** 0zk recipient. */
  recipient: string
}

export interface MetaYieldDeposit extends MetaCommon {}
export interface MetaYieldWithdraw extends MetaCommon {
  /** Yield share amount to redeem; `amount` is the expected USDC output. */
  shares: bigint
}

export type MetaFor<K extends TxKind> =
  K extends 'shield' ? MetaShield
  : K extends 'shield-xchain' ? MetaShieldXchain
  : K extends 'unshield-local' ? MetaUnshieldLocal
  : K extends 'unshield-xchain' ? MetaUnshieldXchain
  : K extends 'transfer-shielded' ? MetaTransferShielded
  : K extends 'yield-deposit' ? MetaYieldDeposit
  : K extends 'yield-withdraw' ? MetaYieldWithdraw
  : never

/* Artifacts — opaque outputs accumulated as stages complete. */

/**
 * Categorised error codes carried on a failed/cancelled record so the UI can pick honest copy.
 *
 *  TX_REVERTED       — the on-chain tx was mined and reverted. Funds did not move (or moved + reverted).
 *  PRE_FLIGHT_REVERT — a handler-side `eth_call` simulation reverted BEFORE the tx was submitted.
 *                      Distinct from TX_REVERTED: nothing was sent, no wallet prompt, no gas paid.
 *                      The UI must communicate "nothing happened" (not "your tx failed on chain").
 *  POLL_TIMEOUT      — we lost track of an on-chain tx whose hash we know. It MAY still succeed;
 *                      the user should check their wallet or the explorer. Distinct from TX_REVERTED.
 *  RPC_ERROR         — wagmi/viem call threw before we got any tx hash. Usually safe to retry.
 *  USER_REJECTED     — the user declined a wallet signature or chain switch.
 *  CANCELLED         — user-initiated cancel on a record that hadn't broadcast yet. Nothing on-chain.
 *  DISMISSED         — user "stopped tracking" a record that HAD broadcast. The on-chain tx will run
 *                      to completion; we just stopped watching it. We persist the txHash so the user
 *                      can find it on the explorer.
 *  OTHER             — unclassified error. Catch-all for handler bugs and unexpected throws.
 */
export type TxErrorCode =
  | 'TX_REVERTED'
  | 'PRE_FLIGHT_REVERT'
  | 'POLL_TIMEOUT'
  | 'RPC_ERROR'
  | 'USER_REJECTED'
  | 'CANCELLED'
  | 'DISMISSED'
  | 'OTHER'

/**
 * Typed error carried in `artifacts.error`. The `txHash` field is critical for POLL_TIMEOUT and
 * DISMISSED: without it the user has no way to find their in-flight tx on the explorer.
 */
export interface TxError {
  code: TxErrorCode
  message: string
  txHash?: `0x${string}`
}

export interface ArtifactsCommon {
  /** Hash of the user/relayer-submitted transaction on the source chain. */
  sourceTxHash?: `0x${string}`
  /** Categorised error if the record terminated unsuccessfully (failed / expired / cancelled-with-context). */
  error?: TxError
  /**
   * ZK-proof generation progress (0–1). Set by the build-proof stage of any kind that calls
   * `generateUnshieldProof` / `generateTransferProof` / `generateProofTransactions`. Atom-only
   * write (no IDB) because progress is ephemeral — a reload restarts proof gen from scratch.
   */
  proofProgress?: number
}

export interface ArtifactsXchain extends ArtifactsCommon {
  /** Iris message hash, used to poll attestations. */
  messageHash?: `0x${string}`
  /** Attestation bytes once Iris returns 'complete'. */
  attestation?: `0x${string}`
  /** Hash of the destination-chain `receiveMessage` / `relayWithHook` tx. */
  destTxHash?: `0x${string}`
  /**
   * CCTP V2 nonce extracted from the source-chain MessageSent envelope (bytes32 at offset
   * [12, 44) of the message). The destination MessageTransmitter's `MessageReceived` event
   * has this as its indexed `nonce` topic, so we detect delivery by an exact-match log query
   * rather than recipient-balance polling — eliminates the false-positive window.
   */
  cctpNonce?: `0x${string}`
  /**
   * Block number on the destination chain at the moment we finished the hub burn. The polling
   * stage uses this as the `fromBlock` floor when scanning for MessageReceived events so we
   * don't pay for full-history rescans. Stored as a decimal string for IDB.
   */
  destFromBlock?: string
}

/**
 * Shield-specific artifacts. The `build-proof` stage stashes its outputs here so the next stage
 * (and any post-reload resume) can submit the on-chain shield tx without re-signing RAILGUN_SHIELD
 * or re-computing the engine-side request. `value` is stringified for IDB serializability.
 */
export interface ArtifactsShield extends ArtifactsCommon {
  privacyPoolAddress?: string
  usdcAddress?: string
  shieldRequest?: {
    npk: `0x${string}`
    value: string
    encryptedBundle: readonly [`0x${string}`, `0x${string}`, `0x${string}`]
    shieldKey: `0x${string}`
  }
}

/**
 * Yield-specific artifacts. The `build-proof` stage stashes the populated adapter calldata here
 * so submit-relayer can dispatch it directly without re-running `generateProofTransactions`
 * (which is stateless in the Railgun SDK — a second call from submit-relayer would otherwise pay
 * the full ~20-30s proving cost again). `value` is stringified for IDB serializability.
 */
export interface ArtifactsYield extends ArtifactsCommon {
  yieldTx?: {
    to: `0x${string}`
    data: `0x${string}`
    value: string
  }
}

/**
 * Cross-chain shield artifacts. Combines the shield-request fields (from build-proof, same as
 * local shield) with the xchain message-tracking fields (from submit-relayer + delivery polling,
 * same shape as unshield-xchain). Kept as one interface rather than intersecting `ArtifactsShield
 * & ArtifactsXchain` so the manifest is explicit and easy to read.
 */
export interface ArtifactsShieldXchain extends ArtifactsXchain {
  /** Hub PrivacyPool address — used by the hub mint detection to scope log queries. */
  privacyPoolAddress?: string
  /** Client PrivacyPoolClient address — used by submit-relayer to call crossChainShield. */
  privacyPoolClientAddress?: string
  /** Client-chain USDC token address — used for the approve preflight. */
  clientUsdcAddress?: string
  /** Hub-chain USDC token address — the SHIELD on the hub side references this. */
  hubUsdcAddress?: string
  shieldRequest?: {
    npk: `0x${string}`
    value: string
    encryptedBundle: readonly [`0x${string}`, `0x${string}`, `0x${string}`]
    shieldKey: `0x${string}`
  }
}

export type ArtifactsFor<K extends TxKind> =
  K extends 'unshield-xchain' ? ArtifactsXchain
  : K extends 'shield' ? ArtifactsShield
  : K extends 'shield-xchain' ? ArtifactsShieldXchain
  : K extends 'yield-deposit' ? ArtifactsYield
  : K extends 'yield-withdraw' ? ArtifactsYield
  : ArtifactsCommon

/* Ownership / session context — captured at submit. Required for history
 * filtering, debugging, and the plural-wallet schema in state/wallet.ts. */

export interface TxWalletContext {
  /** Connected EVM wallet at submit time. Undefined for shielded-only ops
   *  that didn't touch an EVM signer (e.g. a pure shielded transfer). */
  evmAddress: string | undefined
  /** Always present — every tx originates from a shielded wallet. */
  railgunWalletId: string
  /** Source chain id for the operation. Hub chain for shielded-only ops. */
  sourceChainId: number
}

/* The record itself. */

export interface TxRecord<K extends TxKind = TxKind> {
  /** ulid; idempotency key (client-side dedup). */
  id: string
  kind: K
  /** Lifecycle execution state — independent of protocol position. */
  executionState: TxExecutionState
  /** Protocol position within the lifecycle. */
  stage: StageFor<K>
  /** Stages completed so far, in order. Useful for stepper rendering. */
  stagesCompleted: StageFor<K>[]
  /** Monotonic transition counter. Reducer increments; storage rejects stale writes (OCC). */
  updatedSeq: number
  createdAt: number
  updatedAt: number
  meta: MetaFor<K>
  artifacts: Partial<ArtifactsFor<K>>
  walletContext: TxWalletContext
}

/* Lifecycle metadata — drives steppers, retry buttons, expiry rules. */

export interface TxRetryPolicy {
  /** Maximum total retry attempts across the lifecycle's retryable stages. */
  maxAttempts: number
  /** Base backoff between retries (ms). Pollers add jitter on top. */
  backoffMs: number
}

export interface TxLifecycle<K extends TxKind = TxKind> {
  kind: K
  stages: ReadonlyArray<StageFor<K>>
  /** The stage that means "fully successful". */
  terminalSuccess: StageFor<K>
  /** Stages from which user can retry without restarting from scratch. */
  retryableStages: ReadonlyArray<StageFor<K>>
  /** Heuristic durations for ETA UI (milliseconds). */
  estDuration: { p50: number; p90: number }
  /** Hard cap on total lifecycle duration. After this, executionState → expired. */
  maxDurationMs: number
  /** Retry policy applied within retryableStages. */
  retry: TxRetryPolicy
}
