// ABOUTME: Durable cross-chain delivery index keyed by the source CCTP messageHash
// (keccak256(messageBytes)). Both relay modes write it (mock cctp-relay + real iris-relay); the
// GET /cctp-status/:messageHash endpoint reads it so the frontend can confirm a cross-chain
// shield/unshield delivery precisely (authoritative destTxHash) instead of content-sniffing logs.
// ABOUTME: Persistence reuses the atomic, schema-versioned JsonStateStore (single record file). A
// miss is fine — the frontend falls back to its on-chain destination scan — so writes are
// best-effort and the relay hot path is never blocked on them.

import * as path from "path";
import { JsonStateStore } from "../lib/json-state-store";

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface DeliveryRecord {
  /** Lowercased keccak256(messageBytes) of the SOURCE CCTP message. */
  messageHash: string;
  status: DeliveryStatus;
  /** Destination mint tx hash — REQUIRED (by the frontend contract) when status === 'delivered'. */
  destTxHash?: string;
  /** Burn amount in raw USDC (from the CCTP BurnMessage), when cheaply available. */
  amount?: string;
  /** Fee taken on the destination, when available. */
  feeExecuted?: string;
  /** Human reason when status === 'failed'. */
  error?: string;
  /** Unix ms of the last update. Drives TTL eviction. */
  updatedAt: number;
}

interface DeliveryData {
  records: DeliveryRecord[];
  updatedAt: number;
  version: typeof SCHEMA_VERSION;
}

const SCHEMA_VERSION = 1 as const;
const RECORDS_KEY = "records";
/** Retain past the cross-chain lifecycle cap (~60 min) plus margin, then evict to stay bounded. */
const DEFAULT_TTL_MS = 90 * 60 * 1000;
const RELAYER_STATE_DIR = path.join(__dirname, "..", "state");

const VALID_STATUSES: ReadonlySet<string> = new Set<DeliveryStatus>([
  "pending",
  "delivered",
  "failed",
]);

/**
 * Cross-chain delivery status index. The two relay modules (`cctp-relay` mock + `iris-relay` real)
 * call `markPending` / `markDelivered` / `markFailed`; `http-api` calls `get`. Terminal states
 * (`delivered`/`failed`) are never reverted to `pending`. All keys are lowercased.
 */
export class CctpDeliveryStore {
  private records: Map<string, DeliveryRecord> = new Map();
  private readonly store: JsonStateStore<DeliveryData>;
  private readonly ttlMs: number;
  /** Most recent persist promise — `flush()` awaits it so callers/tests can confirm a durable write. */
  private lastWrite: Promise<void> = Promise.resolve();

  constructor(baseDir: string = RELAYER_STATE_DIR, ttlMs: number = DEFAULT_TTL_MS) {
    this.store = new JsonStateStore<DeliveryData>({
      baseDir,
      filenamePrefix: "cctp-delivery",
      expectedVersion: SCHEMA_VERSION,
      validate,
    });
    this.ttlMs = ttlMs;
  }

  /** Load persisted records (evicting any past TTL) so delivery status survives a restart. */
  async initialize(): Promise<void> {
    let data: DeliveryData | null;
    try {
      data = await this.store.read(RECORDS_KEY);
    } catch (err: any) {
      console.error(
        `[cctp-delivery] failed to read store (${err.message}). Starting empty — the frontend will fall back to its on-chain scan until the index refills.`,
      );
      return;
    }
    if (!data) return;
    const cutoff = Date.now() - this.ttlMs;
    let loaded = 0;
    let evicted = 0;
    for (const r of data.records) {
      if (r.updatedAt < cutoff) {
        evicted++;
        continue;
      }
      this.records.set(r.messageHash, r);
      loaded++;
    }
    console.log(
      `[cctp-delivery] loaded ${loaded} record(s)${evicted > 0 ? `, evicted ${evicted} expired` : ""}.`,
    );
    if (evicted > 0) await this.persist();
  }

  /** Read a record by messageHash (case-insensitive). Undefined → the endpoint 404s. */
  get(messageHash: string): DeliveryRecord | undefined {
    return this.records.get(messageHash.toLowerCase());
  }

  /** Mark a message in-flight. No-op if a terminal status is already recorded. */
  markPending(messageHash: string, fields: { amount?: string } = {}): void {
    const key = messageHash.toLowerCase();
    const existing = this.records.get(key);
    if (existing && existing.status !== "pending") return; // don't revert delivered/failed
    this.records.set(key, {
      messageHash: key,
      status: "pending",
      amount: fields.amount ?? existing?.amount,
      updatedAt: Date.now(),
    });
    void this.persist();
  }

  /** Mark a message delivered with its destination tx hash. Idempotent. */
  markDelivered(
    messageHash: string,
    destTxHash: string,
    fields: { amount?: string; feeExecuted?: string } = {},
  ): void {
    const key = messageHash.toLowerCase();
    const existing = this.records.get(key);
    this.records.set(key, {
      messageHash: key,
      status: "delivered",
      destTxHash,
      amount: fields.amount ?? existing?.amount,
      feeExecuted: fields.feeExecuted ?? existing?.feeExecuted,
      updatedAt: Date.now(),
    });
    void this.persist();
  }

  /** Mark a message permanently failed (destination mint reverted / given up). */
  markFailed(messageHash: string, error: string): void {
    const key = messageHash.toLowerCase();
    const existing = this.records.get(key);
    this.records.set(key, {
      messageHash: key,
      status: "failed",
      error,
      amount: existing?.amount,
      updatedAt: Date.now(),
    });
    void this.persist();
  }

  /** Evict records older than the TTL. Call periodically + at startup. */
  async sweep(): Promise<void> {
    const cutoff = Date.now() - this.ttlMs;
    let evicted = 0;
    for (const [k, r] of this.records) {
      if (r.updatedAt < cutoff) {
        this.records.delete(k);
        evicted++;
      }
    }
    if (evicted > 0) {
      console.log(`[cctp-delivery] swept ${evicted} expired record(s).`);
      await this.persist();
    }
  }

  /** Test/inspection helper. */
  size(): number {
    return this.records.size;
  }

  /** Await the most recent persist — the mark* methods fire-and-forget, so callers that need the
   *  write to be durable (e.g. graceful shutdown, tests) await this. */
  async flush(): Promise<void> {
    await this.lastWrite;
  }

  private persist(): Promise<void> {
    this.lastWrite = (async () => {
      try {
        await this.store.write(RECORDS_KEY, {
          records: Array.from(this.records.values()),
          updatedAt: Date.now(),
          version: SCHEMA_VERSION,
        });
      } catch (err: any) {
        console.error(
          `[cctp-delivery] failed to persist (${err.message}). In-memory state is correct; next write retries.`,
        );
      }
    })();
    return this.lastWrite;
  }
}

function validate(parsed: unknown, key: string, path: string): DeliveryData {
  const candidate = parsed as { records?: unknown; updatedAt?: unknown };
  if (!Array.isArray(candidate.records)) {
    throw new Error(
      `cctp-delivery-store: invalid 'records' at ${path}. Expected an array. Delete to reset.`,
    );
  }
  if (
    typeof candidate.updatedAt !== "number" ||
    !Number.isInteger(candidate.updatedAt) ||
    candidate.updatedAt < 0
  ) {
    throw new Error(`cctp-delivery-store: invalid 'updatedAt' at ${path}. Delete to reset.`);
  }
  const records = candidate.records.map((raw, idx) => validateRecord(raw, path, idx));
  return { records, updatedAt: candidate.updatedAt, version: SCHEMA_VERSION };
}

function validateRecord(raw: unknown, path: string, idx: number): DeliveryRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`cctp-delivery-store: records[${idx}] at ${path} is not an object.`);
  }
  const r = raw as Partial<DeliveryRecord>;
  if (typeof r.messageHash !== "string" || r.messageHash.length === 0) {
    throw new Error(`cctp-delivery-store: records[${idx}].messageHash at ${path} is not a non-empty string.`);
  }
  if (!VALID_STATUSES.has(r.status as string)) {
    throw new Error(`cctp-delivery-store: records[${idx}].status '${r.status}' at ${path} is not valid.`);
  }
  if (typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt)) {
    throw new Error(`cctp-delivery-store: records[${idx}].updatedAt at ${path} is not a finite number.`);
  }
  // Optional string fields — validate only if present.
  for (const field of ["destTxHash", "amount", "feeExecuted", "error"] as const) {
    if (r[field] !== undefined && typeof r[field] !== "string") {
      throw new Error(`cctp-delivery-store: records[${idx}].${field} at ${path} is set but not a string.`);
    }
  }
  return r as DeliveryRecord;
}
