// ABOUTME: Durable idempotency for POST /relay. Maps a client-generated idempotencyKey (the tx
// record's ulid, stable across retries/resume) to the already-broadcast txHash, so a re-POST —
// including one after a relayer restart — returns the same hash instead of double-broadcasting.
// ABOUTME: Persistence reuses the atomic, schema-versioned JsonStateStore (single file, one record
// array); an in-flight lock makes concurrent same-key POSTs resolve to exactly one broadcast.

import * as path from "path";
import { JsonStateStore } from "../lib/json-state-store";

/** Terminal-ish status carried alongside the cached hash so a late repeat POST can report it. */
export type IdempotencyStatus = "pending" | "confirmed" | "failed";

export interface IdempotencyRecord {
  idempotencyKey: string;
  txHash: string;
  chainId: number;
  status: IdempotencyStatus;
  /** Unix ms the record was first persisted. Drives TTL eviction. */
  createdAt: number;
}

interface IdempotencyData {
  records: IdempotencyRecord[];
  updatedAt: number;
  version: typeof SCHEMA_VERSION;
}

const SCHEMA_VERSION = 1 as const;
/** Single fixed key — the whole record set lives in one file (idempotency-records.json). */
const RECORDS_KEY = "records";
/** Default retention: well past any tx lifecycle, so a late retry still dedups but the store stays bounded. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Where state files live — module-relative, matching the sibling stores. */
const RELAYER_STATE_DIR = path.join(__dirname, "..", "state");

const VALID_STATUSES: ReadonlySet<string> = new Set<IdempotencyStatus>([
  "pending",
  "confirmed",
  "failed",
]);

/**
 * Restart-safe `/relay` idempotency. `submitOnce(key, submit)` guarantees exactly one `submit()`
 * per key across concurrent requests AND across process restarts (once the first broadcast is
 * persisted). Requests without a key never touch this store — they keep the legacy calldata-dedup
 * behaviour in wallet-manager.
 */
export class IdempotencyStore {
  /** key → durable record (delivered submissions). */
  private records: Map<string, IdempotencyRecord> = new Map();
  /** key → in-flight submission promise (concurrent same-key POSTs await this, no re-broadcast). */
  private inflight: Map<string, Promise<{ txHash: string; chainId: number }>> = new Map();
  private readonly store: JsonStateStore<IdempotencyData>;
  private readonly ttlMs: number;

  constructor(baseDir: string = RELAYER_STATE_DIR, ttlMs: number = DEFAULT_TTL_MS) {
    this.store = new JsonStateStore<IdempotencyData>({
      baseDir,
      filenamePrefix: "idempotency",
      expectedVersion: SCHEMA_VERSION,
      validate,
    });
    this.ttlMs = ttlMs;
  }

  /** Load persisted records (evicting any already past TTL) so a restart still dedups re-POSTs. */
  async initialize(): Promise<void> {
    let data: IdempotencyData | null;
    try {
      data = await this.store.read(RECORDS_KEY);
    } catch (err: any) {
      console.error(
        `[idempotency] failed to read store (${err.message}). Starting empty — re-POSTs across this restart won't dedup. Check relayer/state/idempotency-records.json.`,
      );
      return;
    }
    if (!data) return;
    const cutoff = Date.now() - this.ttlMs;
    let loaded = 0;
    let evicted = 0;
    for (const r of data.records) {
      if (r.createdAt < cutoff) {
        evicted++;
        continue;
      }
      this.records.set(r.idempotencyKey, r);
      loaded++;
    }
    console.log(
      `[idempotency] loaded ${loaded} record(s)${evicted > 0 ? `, evicted ${evicted} expired` : ""}.`,
    );
    if (evicted > 0) await this.persist();
  }

  /** Look up a durable record without running a submission. */
  get(key: string): IdempotencyRecord | undefined {
    return this.records.get(key);
  }

  /**
   * Run `submit` exactly once for `key`:
   *  - a durable record exists → return it (`replayed: true`), no submit.
   *  - a submission is in flight → await it (`replayed: true`), no second broadcast.
   *  - otherwise → register the in-flight promise, run submit, persist key→txHash on success, return
   *    (`replayed: false`).
   *
   * On submit FAILURE nothing is persisted and the in-flight entry is cleared — no broadcast
   * happened, so a later retry with the same key is free to try again. The original error is
   * rethrown verbatim so the caller's RelayError handling still applies.
   */
  async submitOnce(
    key: string,
    submit: () => Promise<{ txHash: string; chainId: number }>,
  ): Promise<{ txHash: string; status: IdempotencyStatus; chainId: number; replayed: boolean }> {
    const existing = this.records.get(key);
    if (existing) {
      return {
        txHash: existing.txHash,
        status: existing.status,
        chainId: existing.chainId,
        replayed: true,
      };
    }
    const pending = this.inflight.get(key);
    if (pending) {
      const r = await pending;
      return { txHash: r.txHash, status: "pending", chainId: r.chainId, replayed: true };
    }

    // Register the in-flight promise BEFORE awaiting — the synchronous check-then-set above means a
    // concurrent same-key POST that runs after this yields will see `inflight` and await it.
    const p = submit();
    this.inflight.set(key, p);
    let result: { txHash: string; chainId: number };
    try {
      result = await p;
    } catch (err) {
      this.inflight.delete(key);
      throw err;
    }

    const record: IdempotencyRecord = {
      idempotencyKey: key,
      txHash: result.txHash,
      chainId: result.chainId,
      status: "pending",
      createdAt: Date.now(),
    };
    this.records.set(key, record);
    this.inflight.delete(key);
    // Persist before returning so a crash immediately after broadcast still dedups the retry.
    await this.persist();
    return { txHash: record.txHash, status: "pending", chainId: record.chainId, replayed: false };
  }

  /**
   * Backfill a terminal status onto the record matching `txHash` (best-effort; called when /status
   * observes a confirmed/failed receipt) so a late repeat POST returns the accurate terminal status.
   */
  async updateStatusByTxHash(txHash: string, status: IdempotencyStatus): Promise<void> {
    const target = txHash.toLowerCase();
    let changed = false;
    for (const r of this.records.values()) {
      if (r.txHash.toLowerCase() === target && r.status !== status) {
        r.status = status;
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  /** Evict records older than the TTL. Call periodically + at startup. */
  async sweep(): Promise<void> {
    const cutoff = Date.now() - this.ttlMs;
    let evicted = 0;
    for (const [k, r] of this.records) {
      if (r.createdAt < cutoff) {
        this.records.delete(k);
        evicted++;
      }
    }
    if (evicted > 0) {
      console.log(`[idempotency] swept ${evicted} expired record(s).`);
      await this.persist();
    }
  }

  /** Test/inspection helper. */
  size(): number {
    return this.records.size;
  }

  private async persist(): Promise<void> {
    try {
      await this.store.write(RECORDS_KEY, {
        records: Array.from(this.records.values()),
        updatedAt: Date.now(),
        version: SCHEMA_VERSION,
      });
    } catch (err: any) {
      console.error(
        `[idempotency] failed to persist (${err.message}). In-memory state is correct; next write retries.`,
      );
    }
  }
}

function validate(parsed: unknown, key: string, path: string): IdempotencyData {
  const candidate = parsed as { records?: unknown; updatedAt?: unknown };
  if (!Array.isArray(candidate.records)) {
    throw new Error(
      `idempotency-store: invalid 'records' at ${path}. Expected an array. Delete to reset.`,
    );
  }
  if (
    typeof candidate.updatedAt !== "number" ||
    !Number.isInteger(candidate.updatedAt) ||
    candidate.updatedAt < 0
  ) {
    throw new Error(`idempotency-store: invalid 'updatedAt' at ${path}. Delete to reset.`);
  }
  const records = candidate.records.map((raw, idx) => validateRecord(raw, path, idx));
  return { records, updatedAt: candidate.updatedAt, version: SCHEMA_VERSION };
}

function validateRecord(raw: unknown, path: string, idx: number): IdempotencyRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`idempotency-store: records[${idx}] at ${path} is not an object.`);
  }
  const r = raw as Partial<IdempotencyRecord>;
  if (typeof r.idempotencyKey !== "string" || r.idempotencyKey.length === 0) {
    throw new Error(`idempotency-store: records[${idx}].idempotencyKey at ${path} is not a non-empty string.`);
  }
  if (typeof r.txHash !== "string") {
    throw new Error(`idempotency-store: records[${idx}].txHash at ${path} is not a string.`);
  }
  if (typeof r.chainId !== "number" || !Number.isFinite(r.chainId)) {
    throw new Error(`idempotency-store: records[${idx}].chainId at ${path} is not a finite number.`);
  }
  if (!VALID_STATUSES.has(r.status as string)) {
    throw new Error(`idempotency-store: records[${idx}].status '${r.status}' at ${path} is not valid.`);
  }
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) {
    throw new Error(`idempotency-store: records[${idx}].createdAt at ${path} is not a finite number.`);
  }
  return r as IdempotencyRecord;
}
