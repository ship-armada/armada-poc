// ABOUTME: Transaction lifecycle model — discriminated unions defining each TxKind's stages, artifacts, and meta.
// ABOUTME: Plan §7. All tx UX flows through these types; the same <TxLifecycleStepper> renders any kind.

export type TxKind =
  | 'shield'
  | 'shield-xchain'
  | 'unshield-local'
  | 'unshield-xchain'
  | 'transfer-shielded'
  | 'transfer-shielded-received'
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

/** A terminal state is settled — resume, cancel, and expiry must never move a record out of it. */
export const TERMINAL_STATES: ReadonlyArray<TxExecutionState> = [
  'completed', 'failed', 'expired', 'cancelled',
]

/** True when the execution state is terminal (no further transitions expected). */
export function isTerminalState(state: TxExecutionState): boolean {
  return (TERMINAL_STATES as ReadonlyArray<string>).includes(state)
}

/**
 * Sort key for history ordering (T-L3). Terminal records anchor at `createdAt` so a row whose
 * `updatedAt` was bumped by a late history-recovery reconcile (a week-old tx re-confirmed from
 * chain) doesn't leap above newer activity. In-flight records use `updatedAt` so they bubble as
 * their stage advances. Consumers sort descending: `(a, b) => historySortTime(b) - historySortTime(a)`.
 */
export function historySortTime(record: {
  executionState: TxExecutionState
  createdAt: number
  updatedAt: number
}): number {
  return isTerminalState(record.executionState) ? record.createdAt : record.updatedAt
}

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

/**
 * Synthetic received-transfer kind. These records are not authored by the user — they're
 * reconstructed from chain via `getWalletTransactionHistory` when another wallet shields to our
 * 0zk address. There's no proof/submit/confirm flow we drove, so the lifecycle collapses to a
 * single terminal `observed` stage: by the time we synthesize the record, the commitment is
 * already on the merkle tree.
 */
export type StageReceived = 'observed'

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
  | StageReceived
  | StageYieldDeposit
  | StageYieldWithdraw

/* Per-kind stage map — used to constrain `TxRecord<K>['stage']` to legal values. */
export type StageFor<K extends TxKind> =
  K extends 'shield' ? StageShield
  : K extends 'shield-xchain' ? StageShieldXchain
  : K extends 'unshield-local' ? StageUnshieldLocal
  : K extends 'unshield-xchain' ? StageUnshieldXchain
  : K extends 'transfer-shielded' ? StageTransferShielded
  : K extends 'transfer-shielded-received' ? StageReceived
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
  /**
   * Phase B3 — gasless mode flag. Frozen at submit-time by the modal based on (wrapper
   * deployed for fromChainId AND relayer healthy AND user hasn't toggled wallet-override).
   *   - `true`  → handler signs an EIP-2612 permit + POSTs gaslessShield(...) calldata to the
   *     relayer; user pays the relayer's `shield` tier fee in USDC and no ETH gas.
   *   - `false` → handler does the existing direct path (user-signed approve + shield from the
   *     EVM wallet, paying ETH gas). Defaults to false (omitted) for records pre-dating B3.
   */
  useGasless?: boolean
  /**
   * Phase B3 — USDC raw amount paid to the relayer's wrapper for gas reimbursement. Only set
   * when `useGasless` is true. The permit signature authorises `amount + feeAmount` total; the
   * wrapper splits `amount` to the pool and `feeAmount` to the relayer.
   */
  feeAmount?: bigint
  /**
   * Phase B3 — `GaslessShieldWrapper` address on `fromChainId`, copied from the deployment
   * manifest at submit-time. Frozen on the record so a manifest refresh mid-flight can't shift
   * the target out from under an in-flight tx. Only set when `useGasless` is true.
   */
  wrapperAddress?: string
  /**
   * Phase B3 — Unix seconds the permit signature is valid until. Picked by the modal (~10 min
   * window per plan doc) and frozen here so the handler signs the permit with the same value.
   */
  permitDeadline?: number
  /**
   * Phase C — the relayer's Railgun (`0zk...`) address, frozen from the fee quote. The gasless
   * build-proof shields the relayer's fee note to this npk (a second note in the array), replacing
   * the old public-USDC fee. Only set when `useGasless` is true.
   */
  broadcasterRailgunAddress?: string
}

export interface MetaShieldXchain extends MetaCommon {
  /** Client chain id we're shielding FROM. Always a client (not hub) — the modal routes
   *  same-chain shield to `shield` instead. */
  fromChainId: number
  /**
   * Phase B4 — gasless mode flag. Frozen at submit-time by the modal based on (client wrapper
   * deployed for fromChainId AND relayer healthy AND user hasn't toggled wallet-override).
   *   - `true`  → handler signs an EIP-2612 permit on the source chain + POSTs
   *     gaslessCrossChainShield(...) calldata to the relayer; user pays the `shieldXchain`
   *     tier fee in USDC and no native gas on the source chain.
   *   - `false` → handler does the existing direct path (user-signed approve + crossChainShield
   *     from the EVM wallet, paying native gas on the source chain). Defaults to false (omitted)
   *     for records pre-dating B4.
   */
  useGasless?: boolean
  /**
   * Phase B4 — USDC raw amount paid to the relayer's wrapper for gas reimbursement on the
   * source chain. Only set when `useGasless` is true. The permit signature authorises
   * `amount + feeAmount` total; the wrapper splits `amount` into the CCTP burn and `feeAmount`
   * to the relayer.
   */
  feeAmount?: bigint
  /**
   * Phase B4 — `GaslessShieldWrapperClient` address on `fromChainId`, copied from the
   * deployment manifest at submit-time. Frozen on the record so a manifest refresh mid-flight
   * can't shift the target out from under an in-flight tx. Only set when `useGasless` is true.
   */
  wrapperAddress?: string
  /**
   * Phase B4 — Unix seconds the permit signature is valid until. Picked by the modal (~10 min
   * window per plan doc) and frozen here so the handler signs the permit with the same value.
   */
  permitDeadline?: number
  /**
   * Phase C — the relayer's Railgun (`0zk...`) address, frozen from the fee quote. The gasless
   * build-proof shields the relayer's fee note to this npk (carried across CCTP, minted on the
   * hub at full value). Only set when `useGasless` is true.
   */
  broadcasterRailgunAddress?: string
}

export interface MetaUnshieldLocal extends MetaCommon, MetaBroadcaster {
  /** EVM recipient on the hub chain. */
  recipient: string
}

export interface MetaUnshieldXchain extends MetaCommon, MetaBroadcaster {
  /** Destination client chain id. */
  toChainId: number
  /** EVM recipient on the destination chain. */
  recipient: string
}

/**
 * Broadcaster context captured at submit-time from the FeeSchedule the modal used. The proof
 * embeds these EXACT values; the relayer's server-side verifier (Phase A2) rejects requests
 * whose decrypted broadcaster output doesn't match. Frozen for the record's lifetime — the
 * cacheId already gates against the relayer rotating the schedule mid-flight.
 *
 * A6 — when `useWalletOverride: true` the handler skips the broadcaster path entirely: the proof
 * is built with `broadcasterFee: null`, the tx is submitted via the user's EVM wallet, and the
 * broadcasterFeeAmount / broadcasterRailgunAddress fields are recorded for history but ignored
 * by the proof builder. The flag is frozen on the record at submit-time so a session-level
 * preference flip mid-flight doesn't strand the handler.
 */
interface MetaBroadcaster {
  /** USDC raw amount paid to the relayer's broadcaster output. */
  broadcasterFeeAmount: bigint
  /** Relayer's Railgun (`0zk`) address that the broadcaster output pays. */
  broadcasterRailgunAddress: string
  /**
   * A6 wallet-override escape hatch. When true, handler builds the proof with `broadcasterFee:
   * null` and submits via the user's EVM wallet (writeContract / sendTransaction) instead of
   * POSTing to `/relay`. Defaults to false (relayer path) for records created before A6.
   */
  useWalletOverride?: boolean
}

export interface MetaTransferShielded extends MetaCommon, MetaBroadcaster {
  /** 0zk recipient. */
  recipient: string
}

/**
 * Meta for a synthetic received transfer. Deliberately does NOT extend `MetaCommon` — a received
 * transfer carries no fee (we didn't author it, so there's no `feeCacheId` to attach). The sender
 * is private by Railgun's design and not recoverable, so we only keep the amount + any plaintext
 * memo the sender chose to attach.
 */
export interface MetaTransferShieldedReceived {
  /** USDC raw amount (6 decimals) credited to our shielded balance. */
  amount: bigint
  /** Optional plaintext memo the sender attached (`memoText` on the SDK history item). */
  memoText?: string
}

export type MetaYieldDeposit = MetaCommon & MetaBroadcaster
export interface MetaYieldWithdraw extends MetaCommon, MetaBroadcaster {
  /** Yield share amount to redeem; `amount` is the expected USDC output. */
  shares: bigint
}

export type MetaFor<K extends TxKind> =
  K extends 'shield' ? MetaShield
  : K extends 'shield-xchain' ? MetaShieldXchain
  : K extends 'unshield-local' ? MetaUnshieldLocal
  : K extends 'unshield-xchain' ? MetaUnshieldXchain
  : K extends 'transfer-shielded' ? MetaTransferShielded
  : K extends 'transfer-shielded-received' ? MetaTransferShieldedReceived
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
 *  INTERRUPTED       — a non-terminal record was found on resume (app reload / crash) that never
 *                      reached a broadcast (no sourceTxHash). Nothing was sent; resuming would
 *                      re-prompt the wallet out of nowhere, so we fail honestly and ask the user
 *                      to start a new transaction.
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
  | 'INTERRUPTED'
  // The relayer rejected the proof's baked-in fee quote (expired / too low / insufficient). The
  // cacheId + fee are frozen into the proof, so retrying re-POSTs the same doomed quote — only a
  // fresh transaction recovers. Retry is gated off for this code (S-H1).
  | 'FEE_EXPIRED'
  // The relayer already has this transaction (HTTP 409). It WAS submitted; recovery is to fetch
  // the hash via /status and resume watching rather than surface a failure (S-H2 / T-M3).
  | 'DUPLICATE_TX'
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
  /**
   * Cross-chain unshield: the fully-encoded `atomicCrossChainUnshield` calldata built during
   * build-proof, so submit-relayer can dispatch it without re-running the ~20-30s proof. The
   * destination binding (recipient + domain + maxFee) is baked into the proof at build time, so
   * these bytes are immutable once persisted. `value` stringified for IDB serializability.
   */
  unshieldTx?: {
    to: `0x${string}`
    data: `0x${string}`
    value: string
  }
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
 * (and any post-reload resume) can submit the on-chain shield tx without re-generating the random
 * shield key or re-building the ShieldRequest. `value` is stringified for IDB serializability.
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
  /**
   * Phase B3 — EIP-2612 permit signature captured during build-proof when `meta.useGasless`
   * is true. submit-relayer's gasless branch needs all three to encode the wrapper calldata.
   * Absent on direct-submit records.
   */
  permitV?: number
  permitR?: `0x${string}`
  permitS?: `0x${string}`
  /**
   * Phase C — the relayer's fee note (a second ShieldRequest to the relayer's 0zk), captured at
   * build-proof when `meta.useGasless` is true. The gasless submit shields `[shieldRequest, feeNote]`
   * as one array. Absent on direct-submit records.
   */
  feeNote?: {
    npk: `0x${string}`
    value: string
    encryptedBundle: readonly [`0x${string}`, `0x${string}`, `0x${string}`]
    shieldKey: `0x${string}`
  }
  /**
   * Phase C — the fee note's 16-byte hex `random`, sent on the /relay request so the relayer can
   * verify the fee note is shielded to its own 0zk without decryption. Absent on direct-submit.
   */
  feeShieldRandom?: string
  /** Phase C — the EIP-712 ShieldIntent signature; and the intent nonce it consumed (stringified). */
  intentSig?: `0x${string}`
  intentNonce?: string
  /**
   * Direct-path approve leg (S-M4). `approveTxHash` is set after the USDC `approve` confirms;
   * `approveSkipped` is set when allowance already covered the amount (no approve prompt). Drives
   * the WalletConfirmList checklist (`shieldWalletSteps`). Absent on the gasless path.
   */
  approveTxHash?: `0x${string}`
  approveSkipped?: boolean
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
  /**
   * Withdraw-only (#312): the fee note's 16-byte hex `random`, captured at build-proof and sent on
   * the /relay request so the relayer can verify the fee is shielded to itself. Absent on deposit /
   * wallet-override / fee-less redeem.
   */
  feeShieldRandom?: string
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
  /**
   * Phase B4 — EIP-2612 permit signature captured during build-proof when `meta.useGasless`
   * is true. submit-relayer's gasless branch needs all three to encode the wrapper calldata.
   * Absent on direct-submit records.
   */
  permitV?: number
  permitR?: `0x${string}`
  permitS?: `0x${string}`
  /**
   * Phase C — the relayer's fee note (built against the HUB usdc; minted on the hub at full value),
   * captured at build-proof when `meta.useGasless` is true. Absent on direct-submit records.
   */
  feeNote?: {
    npk: `0x${string}`
    value: string
    encryptedBundle: readonly [`0x${string}`, `0x${string}`, `0x${string}`]
    shieldKey: `0x${string}`
  }
  /** Phase C — the fee note's 16-byte hex `random`, sent on /relay for relayer-side npk verification. */
  feeShieldRandom?: string
  /** Phase C — the EIP-712 CrossChainShieldIntent signature; and the intent nonce it consumed. */
  intentSig?: `0x${string}`
  intentNonce?: string
  /**
   * Phase C — the CCTP `maxFee` + finality bound into the intent at build-proof. Frozen so the
   * submit stage passes the same values the user signed (they can't be recomputed at submit or the
   * signature would mismatch). Stringified maxFee for IDB serializability.
   */
  intentMaxFee?: string
  intentMinFinality?: number
  /** Direct-path approve leg (S-M4) — see ArtifactsShield. Absent on the gasless path. */
  approveTxHash?: `0x${string}`
  approveSkipped?: boolean
}

export interface ArtifactsTransfer extends ArtifactsCommon {
  /**
   * The shielded-transfer `transact()` calldata built during build-proof (@armada/sdk plan → prove →
   * serialize), so submit-relayer dispatches it without re-running the ~20-30s proof. Unlike the
   * engine's in-memory proof cache (which a reload wipes), this survives a reload — it's persisted in
   * the record. `value` is '0' (a shielded tx carries no native value); stringified for IDB.
   */
  transferTx?: {
    to: `0x${string}`
    data: `0x${string}`
    value: string
  }
}

export interface ArtifactsUnshieldLocal extends ArtifactsCommon {
  /**
   * The same-chain unshield `transact()` calldata built during build-proof (@armada/sdk plan → prove →
   * serialize), so submit-relayer dispatches it without re-running the ~20-30s proof. Unlike the
   * engine's in-memory proof cache (which a reload wipes), this survives a reload — it's persisted in
   * the record. `value` is '0' (a shielded tx carries no native value); stringified for IDB. Mirrors
   * `ArtifactsTransfer.transferTx`; distinct from `ArtifactsXchain.unshieldTx` (cross-chain calldata).
   */
  unshieldTx?: {
    to: `0x${string}`
    data: `0x${string}`
    value: string
  }
}

export type ArtifactsFor<K extends TxKind> =
  K extends 'unshield-xchain' ? ArtifactsXchain
  : K extends 'unshield-local' ? ArtifactsUnshieldLocal
  : K extends 'shield' ? ArtifactsShield
  : K extends 'shield-xchain' ? ArtifactsShieldXchain
  : K extends 'yield-deposit' ? ArtifactsYield
  : K extends 'yield-withdraw' ? ArtifactsYield
  : K extends 'transfer-shielded' ? ArtifactsTransfer
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

export interface TxLifecycle<K extends TxKind = TxKind> {
  kind: K
  stages: ReadonlyArray<StageFor<K>>
  /** The stage that means "fully successful". */
  terminalSuccess: StageFor<K>
  /**
   * Stages from which the user can MANUALLY retry (via ErrorStep's "Try Again" → useTx.retry)
   * without restarting from scratch. There is intentionally NO automatic retry policy: a buggy
   * auto-resubmit could double-submit a shielded tx and lose funds. Retry is always user-driven.
   */
  retryableStages: ReadonlyArray<StageFor<K>>
  /** Heuristic durations for ETA UI (milliseconds). */
  estDuration: { p50: number; p90: number }
  /** Hard cap on total lifecycle duration. After this, executionState → expired. */
  maxDurationMs: number
}
