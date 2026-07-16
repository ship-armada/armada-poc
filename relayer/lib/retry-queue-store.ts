// ABOUTME: Durable persistence for the mock CCTP relay's failed-message retry queue, so a restart
// while a relay is queued for retry doesn't permanently strand the message (the source-chain burn
// is final; losing the retry entry means the user's USDC never arrives).
// ABOUTME: Thin wrapper over the same JsonStateStore primitive CursorStore/PendingStateStore use —
// one file at relayer/state/cctp-retry-queue.json, atomic writes, schema-versioned. The message's
// bigint nonce is serialised as a decimal string (JSON has no bigint).

import { JsonStateStore } from "./json-state-store";

const RETRY_QUEUE_SCHEMA_VERSION = 1 as const;

/** Single key — the retry queue is a process-global list, not per-chain. */
export const RETRY_QUEUE_KEY = "queue";

/**
 * Persisted form of a parsed MessageSent event. Mirrors cctp-relay's in-memory `MessageEvent`
 * with `nonce` serialised as a decimal string. Everything needed to re-attempt the relay (or
 * dead-letter the message) on a later boot is captured here.
 */
export interface PersistedMessageEvent {
  nonce: string;
  sourceDomain: number;
  destinationDomain: number;
  sender: string;
  recipient: string;
  destinationCaller: string;
  minFinalityThreshold: number;
  messageBody: string;
  rawMessage: string;
  txHash: string;
  blockNumber: number;
}

export interface PersistedRetryEntry {
  event: PersistedMessageEvent;
  /** Retry attempts already made (1-based, as enqueued by cctp-relay's backoff scheduler). */
  attempts: number;
  /** Unix ms — the entry is not retried before this time. */
  nextRetryAt: number;
}

export interface RetryQueueData {
  entries: PersistedRetryEntry[];
  updatedAt: number;
  version: typeof RETRY_QUEUE_SCHEMA_VERSION;
}

/**
 * Filesystem-backed retry queue. Mutation pattern matches the sibling stores: load on init →
 * mutate the in-memory queue → write the whole snapshot back, awaiting the write before the
 * mutating operation returns so a crash can't lose the change.
 */
export class RetryQueueStore {
  private readonly inner: JsonStateStore<RetryQueueData>;

  constructor(baseDir: string) {
    this.inner = new JsonStateStore<RetryQueueData>({
      baseDir,
      filenamePrefix: "cctp-retry",
      expectedVersion: RETRY_QUEUE_SCHEMA_VERSION,
      validate,
    });
  }

  async read(): Promise<RetryQueueData | null> {
    return this.inner.read(RETRY_QUEUE_KEY);
  }

  async write(entries: PersistedRetryEntry[]): Promise<void> {
    await this.inner.write(RETRY_QUEUE_KEY, {
      entries,
      updatedAt: Date.now(),
      version: RETRY_QUEUE_SCHEMA_VERSION,
    });
  }
}

function validate(parsed: unknown, key: string, path: string): RetryQueueData {
  const candidate = parsed as { entries?: unknown; updatedAt?: unknown };
  if (!Array.isArray(candidate.entries)) {
    throw new Error(
      `cctp-retry-store: invalid 'entries' field at ${path}. Expected an array. Delete to reset.`,
    );
  }
  if (
    typeof candidate.updatedAt !== "number" ||
    !Number.isInteger(candidate.updatedAt) ||
    candidate.updatedAt < 0
  ) {
    throw new Error(
      `cctp-retry-store: invalid 'updatedAt' field at ${path}. Expected a non-negative integer. Delete to reset.`,
    );
  }
  const entries = candidate.entries.map((raw, idx) => validateEntry(raw, path, idx));
  return { entries, updatedAt: candidate.updatedAt, version: RETRY_QUEUE_SCHEMA_VERSION };
}

function validateEntry(raw: unknown, path: string, idx: number): PersistedRetryEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`cctp-retry-store: entries[${idx}] at ${path} is not an object.`);
  }
  const r = raw as Partial<PersistedRetryEntry>;
  if (typeof r.attempts !== "number" || !Number.isFinite(r.attempts) || r.attempts < 0) {
    throw new Error(`cctp-retry-store: entries[${idx}].attempts at ${path} is not a valid number.`);
  }
  if (typeof r.nextRetryAt !== "number" || !Number.isFinite(r.nextRetryAt)) {
    throw new Error(`cctp-retry-store: entries[${idx}].nextRetryAt at ${path} is not a valid number.`);
  }
  const event = validateEvent(r.event, path, idx);
  return { event, attempts: r.attempts, nextRetryAt: r.nextRetryAt };
}

function validateEvent(raw: unknown, path: string, idx: number): PersistedMessageEvent {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`cctp-retry-store: entries[${idx}].event at ${path} is not an object.`);
  }
  const e = raw as Partial<PersistedMessageEvent>;
  const strings: (keyof PersistedMessageEvent)[] = [
    "nonce",
    "sender",
    "recipient",
    "destinationCaller",
    "messageBody",
    "rawMessage",
    "txHash",
  ];
  for (const field of strings) {
    if (typeof e[field] !== "string") {
      throw new Error(
        `cctp-retry-store: entries[${idx}].event.${String(field)} at ${path} is not a string.`,
      );
    }
  }
  const numbers: (keyof PersistedMessageEvent)[] = [
    "sourceDomain",
    "destinationDomain",
    "minFinalityThreshold",
    "blockNumber",
  ];
  for (const field of numbers) {
    if (typeof e[field] !== "number" || !Number.isFinite(e[field] as number)) {
      throw new Error(
        `cctp-retry-store: entries[${idx}].event.${String(field)} at ${path} is not a finite number.`,
      );
    }
  }
  return e as PersistedMessageEvent;
}
