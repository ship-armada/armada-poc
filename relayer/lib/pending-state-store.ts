/**
 * ABOUTME: Per-source-chain persistence for pendingMessages + processedMessages — survives
 * restarts so we (a) don't re-relay messages already delivered (gas savings) and (b) don't
 * lose visibility into messages waiting on Iris attestation.
 * ABOUTME: Sibling of CursorStore using the same JsonStateStore primitive — one file per source
 * chain at relayer/state/pending-<chain>.json. Atomic writes, schema-versioned.
 */

import { JsonStateStore } from "./json-state-store";

/**
 * Schema version of the persisted pending-state file. Bumped 1 → 2 when dedupKey was added
 * alongside the (sourceTxHash, logIndex)-based dedup; see `migrateV1ToV2` below for the
 * forward path.
 *
 * ROLLBACK STRATEGY: there is no automatic v2 → v1 downgrade. A v2 file rejected by an older
 * relayer would simply throw on startup. If you must roll back, delete the per-chain
 * `relayer/state/pending-<chain>.json` files first — the scanner will re-discover any
 * in-flight messages from chain history via its persisted cursor (the lookback covers the
 * recent past, so no events are lost). The cost is one repeated relay attempt per
 * previously-delivered message; the destination contract's "already processed" check is
 * the safety net.
 */
const PENDING_SCHEMA_VERSION = 3 as const;

/**
 * Persisted shape of a pending CCTP message. Mirrors the iris-relay `PendingMessage` interface
 * with two NEW fields for Phase 2 (`retryAttempts`, `nextRetryAt`) that support per-message
 * retry/backoff on relayWithHook failures, plus two NEW fields for Phase 2B
 * (`submittedTxHash`, `submittedAt`) that turn the relay loop into a state machine — the
 * presence of `submittedTxHash` means "broadcast happened, waiting for destination receipt"
 * (handled by `processInflightRelays`); absence means "still waiting on Iris attestation"
 * (handled by `processPendingMessages`).
 *
 * Both Phase 2B fields are OPTIONAL — a v1 file written by the prior version (which had
 * neither) loads cleanly. The state machine treats absent fields as "awaiting Iris."
 *
 * v2 added `dedupKey` — `${sourceTxHash}:${logIndex}`. The previous v1 dedup used
 * `messageHash` (keccak256 of the source-side messageBytes), but CCTP V2 leaves the source
 * nonce slot at bytes32(0) and our burn body has no per-tx-unique field, so two unshields
 * with the same {amount, maxFee, finalRecipient} produce byte-identical messageBytes and
 * collide on hash. `(sourceTxHash, logIndex)` is the canonical EVM identifier for a log and
 * cannot collide between two distinct burns.
 */
export interface PersistedPendingMessage {
  messageBytes: string;
  messageHash: string;
  /**
   * Globally-unique-per-log dedup key, format `${sourceTxHash}:${logIndex}`. Used as the key
   * in the in-memory pendingMessages Map and the per-chain processedMessages Set. Distinct
   * from `messageHash` (which is keccak256(messageBytes) — used for Iris attestation lookup,
   * not dedup, because identical burns produce identical hashes in CCTP V2).
   */
  dedupKey: string;
  sourceDomain: number;
  destinationDomain: number;
  nonce: string;
  sourceTxHash: string;
  sourceBlock: number;
  detectedAt: number;
  pollAttempts: number;
  lastStatus: string;
  /** Failed-relay retry counter; null means no relay attempted yet. Capped at MAX_RELAY_RETRIES. */
  retryAttempts: number;
  /** Unix ms — relay attempts before this time are blocked by the backoff scheduler. 0 = no wait. */
  nextRetryAt: number;
  /**
   * Destination-chain tx hash once we've broadcast `hookRouter.relayWithHook(...)`. Presence
   * is the state-machine flag: set → awaiting receipt confirmation (processInflightRelays);
   * absent → still awaiting Iris attestation (processPendingMessages).
   */
  submittedTxHash?: string;
  /**
   * Unix ms of the broadcast. Used by processInflightRelays to detect stuck/dropped txs —
   * if the receipt hasn't arrived within `STUCK_TX_THRESHOLD_MS` of this timestamp, the
   * message is force-re-submitted with a fresh nonce.
   */
  submittedAt?: number;
}

/**
 * A delivered-message dedup record: the `dedupKey` plus the unix-ms timestamp it was marked
 * processed. v3 added the timestamp so the consumer can prune entries that are older than any
 * message could still be re-discovered (≈ MAX_ATTESTATION_AGE_MS × 2), bounding the set's growth.
 */
export interface ProcessedEntry {
  key: string;
  at: number;
}

export interface PendingStateData {
  pending: PersistedPendingMessage[];
  /**
   * Delivered-message dedup records (`dedupKey` + timestamp), format key
   * `${sourceTxHash}:${logIndex}`. Used to short-circuit `enqueueMessage` when the scanner
   * re-discovers a message after a restart. Stored sorted by key on disk for JSON-friendliness.
   * The timestamp lets the consumer prune aged-out entries rather than growing forever.
   */
  processed: ProcessedEntry[];
  updatedAt: number;
  version: typeof PENDING_SCHEMA_VERSION;
}

/**
 * Filesystem-backed per-source-chain pending state. The key is the SOURCE chain name (where
 * MessageSent was emitted) because that's the dimension the iris-relay's `pendingMessages` Map
 * is implicitly keyed by — each chain's state owns its own pendingMessages.
 *
 * Mutation pattern: load on init → mutate in memory → write the whole snapshot back on every
 * change. Writes are cheap (single-file, atomic rename, small payload) but the caller MUST
 * await the write before returning from the mutating operation, otherwise a crash between
 * mutation + write would lose the change.
 */
export class PendingStateStore {
  private readonly inner: JsonStateStore<PendingStateData>;

  constructor(baseDir: string) {
    this.inner = new JsonStateStore<PendingStateData>({
      baseDir,
      filenamePrefix: "pending",
      expectedVersion: PENDING_SCHEMA_VERSION,
      validate,
      migrate: migrateToCurrent,
    });
  }

  async read(chainName: string): Promise<PendingStateData | null> {
    return this.inner.read(chainName);
  }

  async write(
    chainName: string,
    pending: PersistedPendingMessage[],
    processed: Map<string, number>,
  ): Promise<void> {
    const sortedProcessed: ProcessedEntry[] = Array.from(processed.entries())
      .map(([key, at]) => ({ key, at }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    // Defensive size signal — fires when the processed set grows past a level that suggests either
    // real volume scale-up or a dedup bug. With pruning in place this should stay small; crossing
    // 10k means either prune isn't keeping up OR something is wrong (e.g. the dedup short-circuit
    // in enqueueMessage broke and we're re-adding keys). Either way operators should investigate.
    if (sortedProcessed.length > PROCESSED_SET_WARN_THRESHOLD) {
      console.warn(
        `[pending-store] ${chainName}: processed set has grown to ${sortedProcessed.length} entries (warn threshold ${PROCESSED_SET_WARN_THRESHOLD}). Unexpected at current volume — investigate.`,
      );
    }
    await this.inner.write(chainName, {
      pending,
      processed: sortedProcessed,
      updatedAt: Date.now(),
      version: PENDING_SCHEMA_VERSION,
    });
  }
}

/** Loud-log threshold for the processed-set size — see comment in PendingStateStore.write. */
const PROCESSED_SET_WARN_THRESHOLD = 10_000;

/**
 * Migrate a v1 payload (pre-dedupKey, processed-keyed-by-messageHash) to v2.
 *
 * v1 `processed[]` entries are keccak256(messageBytes) — incompatible with v2's dedupKey
 * (`${sourceTxHash}:${logIndex}`). There's no way to recover the dedupKey from a bare hash, so
 * we drop the v1 processed[] entirely. Pending messages also get back-filled with a synthetic
 * dedupKey derived from their `sourceTxHash`; logIndex is unrecoverable from the persisted
 * payload, so we use `0` as a placeholder. The pending-message dedupKey is only used for
 * Map keying + future dedup; the brief window where two un-confirmed messages from the same
 * source tx could collide is acceptable — `atomicCrossChainUnshield` and `crossChainShield`
 * each emit exactly one MessageSent per tx, so `:0` is correct in practice today.
 *
 * The cost of dropping v1 processed[] is one possible re-relay per previously-delivered
 * message that the scanner re-discovers — the destination contract's "already processed"
 * check is the safety net (submitRelay returns 'already-processed', the message is then
 * marked processed under v2). One wasted RPC call per stale message, not a real issue.
 */
function migrateToCurrent(oldPayload: unknown, oldVersion: number): PendingStateData {
  if (oldVersion !== 1 && oldVersion !== 2) {
    throw new Error(
      `pending-store: cannot migrate from version ${oldVersion} — no migrator defined for that path.`,
    );
  }
  const candidate = oldPayload as {
    pending?: unknown;
    processed?: unknown;
    updatedAt?: unknown;
  };
  if (!Array.isArray(candidate.pending)) {
    throw new Error(`pending-store: v${oldVersion} migration failed — 'pending' is not an array.`);
  }
  if (typeof candidate.updatedAt !== "number") {
    throw new Error(
      `pending-store: v${oldVersion} migration failed — 'updatedAt' is missing or non-numeric.`,
    );
  }

  // v1 pending entries predate dedupKey; back-fill it from sourceTxHash. v2+ already carry it.
  const migratedPending = candidate.pending.map((raw, idx) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`pending-store: v${oldVersion} migration failed — pending[${idx}] is not an object.`);
    }
    const r = raw as Partial<PersistedPendingMessage> & { sourceTxHash?: string };
    if (typeof r.sourceTxHash !== "string") {
      throw new Error(
        `pending-store: v${oldVersion} migration failed — pending[${idx}].sourceTxHash missing or non-string.`,
      );
    }
    if (oldVersion === 1) return { ...r, dedupKey: `${r.sourceTxHash}:0` } as PersistedPendingMessage;
    return r as PersistedPendingMessage;
  });

  // Processed entries:
  //   v1 — keccak256(messageBytes) hashes, incompatible with the dedupKey scheme → drop.
  //   v2 — `string[]` of dedupKeys with no timestamp → wrap each at "now" (they age out from load,
  //        which is correct enough: a delivered message older than the migration is already past
  //        any re-discovery window).
  const now = Date.now();
  let processed: ProcessedEntry[] = [];
  if (oldVersion === 2 && Array.isArray(candidate.processed)) {
    processed = candidate.processed
      .filter((k): k is string => typeof k === "string")
      .map((key) => ({ key, at: now }));
  }
  console.warn(
    `[pending-store] Migrating v${oldVersion} → v${PENDING_SCHEMA_VERSION}: ${migratedPending.length} pending, ` +
      `${processed.length} processed entr${processed.length === 1 ? "y" : "ies"} carried` +
      `${oldVersion === 1 ? " (v1 legacy processed hashes dropped — back-filled dedupKeys on pending)" : " (timestamps stamped at load)"}.`,
  );
  return {
    pending: migratedPending,
    processed,
    updatedAt: candidate.updatedAt,
    version: PENDING_SCHEMA_VERSION,
  };
}

function validate(
  parsed: unknown,
  chainName: string,
  path: string,
): PendingStateData {
  const candidate = parsed as { pending?: unknown; processed?: unknown; updatedAt?: unknown };
  if (!Array.isArray(candidate.pending)) {
    throw new Error(
      `pending-store: invalid 'pending' field for chain '${chainName}' at ${path}. Expected an array. Delete to reset.`,
    );
  }
  if (!Array.isArray(candidate.processed)) {
    throw new Error(
      `pending-store: invalid 'processed' field for chain '${chainName}' at ${path}. Expected an array. Delete to reset.`,
    );
  }
  if (
    typeof candidate.updatedAt !== "number" ||
    !Number.isInteger(candidate.updatedAt) ||
    candidate.updatedAt < 0
  ) {
    throw new Error(
      `pending-store: invalid 'updatedAt' field for chain '${chainName}' at ${path}. Expected a non-negative integer (Unix ms). Delete to reset.`,
    );
  }
  // Per-element shape check on pending — loud failure on a corrupted entry rather than
  // propagating undefined fields into the relay loop. We're permissive about extra fields so
  // a future writer that added a field can still be read by an older reader.
  const pending = candidate.pending.map((msg, idx) =>
    validatePending(msg, chainName, path, idx),
  );
  // Processed entries are { key, at } records (v3). Light validation of each.
  const processed = candidate.processed.map((entry, idx): ProcessedEntry => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(
        `pending-store: processed[${idx}] for chain '${chainName}' at ${path} is not an object. Delete to reset.`,
      );
    }
    const e = entry as Partial<ProcessedEntry>;
    if (typeof e.key !== "string") {
      throw new Error(
        `pending-store: processed[${idx}].key for chain '${chainName}' at ${path} is not a string. Delete to reset.`,
      );
    }
    if (typeof e.at !== "number" || !Number.isFinite(e.at)) {
      throw new Error(
        `pending-store: processed[${idx}].at for chain '${chainName}' at ${path} is not a finite number. Delete to reset.`,
      );
    }
    return { key: e.key, at: e.at };
  });
  return {
    pending,
    processed,
    updatedAt: candidate.updatedAt,
    version: PENDING_SCHEMA_VERSION,
  };
}

function validatePending(
  msg: unknown,
  chainName: string,
  path: string,
  idx: number,
): PersistedPendingMessage {
  if (typeof msg !== "object" || msg === null) {
    throw new Error(
      `pending-store: pending[${idx}] for chain '${chainName}' at ${path} is not an object.`,
    );
  }
  const m = msg as Partial<PersistedPendingMessage>;
  const requiredStrings: (keyof PersistedPendingMessage)[] = [
    "messageBytes",
    "messageHash",
    "dedupKey",
    "nonce",
    "sourceTxHash",
    "lastStatus",
  ];
  for (const field of requiredStrings) {
    if (typeof m[field] !== "string") {
      throw new Error(
        `pending-store: pending[${idx}].${String(field)} for chain '${chainName}' at ${path} is not a string.`,
      );
    }
  }
  const requiredNumbers: (keyof PersistedPendingMessage)[] = [
    "sourceDomain",
    "destinationDomain",
    "sourceBlock",
    "detectedAt",
    "pollAttempts",
    "retryAttempts",
    "nextRetryAt",
  ];
  for (const field of requiredNumbers) {
    if (typeof m[field] !== "number" || !Number.isFinite(m[field] as number)) {
      throw new Error(
        `pending-store: pending[${idx}].${String(field)} for chain '${chainName}' at ${path} is not a finite number.`,
      );
    }
  }
  // Optional fields — validate ONLY if present. submittedTxHash + submittedAt MUST be present
  // together; one without the other indicates corruption that downstream logic would mishandle.
  if (m.submittedTxHash !== undefined || m.submittedAt !== undefined) {
    if (typeof m.submittedTxHash !== "string") {
      throw new Error(
        `pending-store: pending[${idx}].submittedTxHash for chain '${chainName}' at ${path} is set but not a string.`,
      );
    }
    if (typeof m.submittedAt !== "number" || !Number.isFinite(m.submittedAt)) {
      throw new Error(
        `pending-store: pending[${idx}].submittedAt for chain '${chainName}' at ${path} is set but not a finite number.`,
      );
    }
  }
  return m as PersistedPendingMessage;
}
