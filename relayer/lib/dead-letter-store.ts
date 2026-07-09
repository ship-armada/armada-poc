// ABOUTME: Durable dead-letter records for CCTP messages the relayer has permanently given up on
// (retries exhausted, attestation expired, or fee too low). Without a durable record these
// vanish into a log line — invisible to any automated monitor and unrecoverable after restart.
// ABOUTME: Per-source-chain file at relayer/state/deadletter-<chain>.json, atomic + versioned,
// over the same JsonStateStore primitive the cursor/pending/retry stores use.

import { JsonStateStore } from "./json-state-store";

const DEAD_LETTER_SCHEMA_VERSION = 1 as const;

/** Why a message was dead-lettered. Surfaced in logs + /health for operator triage. */
export type DeadLetterReason = "retries-exhausted" | "expired" | "fee-too-low";

export interface DeadLetterRecord {
  /** Canonical message id — iris uses the dedupKey `${sourceTxHash}:${logIndex}`, cctp uses `${sourceDomain}-${nonce}`. */
  id: string;
  sourceTxHash: string;
  /** Full message bytes, retained so an operator can manually relay the message later. */
  rawMessage: string;
  reason: DeadLetterReason;
  sourceDomain: number;
  destinationDomain: number;
  /** Unix ms the message was dead-lettered. */
  at: number;
}

export interface DeadLetterData {
  records: DeadLetterRecord[];
  updatedAt: number;
  version: typeof DEAD_LETTER_SCHEMA_VERSION;
}

/**
 * Filesystem-backed per-source-chain dead-letter log. Same load→mutate-in-memory→write-whole
 * pattern as the sibling stores; the caller awaits the write so a crash can't lose a record.
 */
export class DeadLetterStore {
  private readonly inner: JsonStateStore<DeadLetterData>;

  constructor(baseDir: string) {
    this.inner = new JsonStateStore<DeadLetterData>({
      baseDir,
      filenamePrefix: "deadletter",
      expectedVersion: DEAD_LETTER_SCHEMA_VERSION,
      validate,
    });
  }

  async read(chainName: string): Promise<DeadLetterData | null> {
    return this.inner.read(chainName);
  }

  async write(chainName: string, records: DeadLetterRecord[]): Promise<void> {
    await this.inner.write(chainName, {
      records,
      updatedAt: Date.now(),
      version: DEAD_LETTER_SCHEMA_VERSION,
    });
  }
}

const VALID_REASONS: ReadonlySet<string> = new Set<DeadLetterReason>([
  "retries-exhausted",
  "expired",
  "fee-too-low",
]);

function validate(parsed: unknown, chainName: string, path: string): DeadLetterData {
  const candidate = parsed as { records?: unknown; updatedAt?: unknown };
  if (!Array.isArray(candidate.records)) {
    throw new Error(
      `dead-letter-store: invalid 'records' for chain '${chainName}' at ${path}. Expected an array. Delete to reset.`,
    );
  }
  if (
    typeof candidate.updatedAt !== "number" ||
    !Number.isInteger(candidate.updatedAt) ||
    candidate.updatedAt < 0
  ) {
    throw new Error(
      `dead-letter-store: invalid 'updatedAt' for chain '${chainName}' at ${path}. Delete to reset.`,
    );
  }
  const records = candidate.records.map((raw, idx) => validateRecord(raw, chainName, path, idx));
  return { records, updatedAt: candidate.updatedAt, version: DEAD_LETTER_SCHEMA_VERSION };
}

function validateRecord(
  raw: unknown,
  chainName: string,
  path: string,
  idx: number,
): DeadLetterRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`dead-letter-store: records[${idx}] for '${chainName}' at ${path} is not an object.`);
  }
  const r = raw as Partial<DeadLetterRecord>;
  const strings: (keyof DeadLetterRecord)[] = ["id", "sourceTxHash", "rawMessage", "reason"];
  for (const field of strings) {
    if (typeof r[field] !== "string") {
      throw new Error(
        `dead-letter-store: records[${idx}].${String(field)} for '${chainName}' at ${path} is not a string.`,
      );
    }
  }
  if (!VALID_REASONS.has(r.reason as string)) {
    throw new Error(
      `dead-letter-store: records[${idx}].reason '${r.reason}' for '${chainName}' at ${path} is not a known reason.`,
    );
  }
  const numbers: (keyof DeadLetterRecord)[] = ["sourceDomain", "destinationDomain", "at"];
  for (const field of numbers) {
    if (typeof r[field] !== "number" || !Number.isFinite(r[field] as number)) {
      throw new Error(
        `dead-letter-store: records[${idx}].${String(field)} for '${chainName}' at ${path} is not a finite number.`,
      );
    }
  }
  return r as DeadLetterRecord;
}
