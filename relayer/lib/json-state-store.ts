/**
 * ABOUTME: Generic atomic per-key JSON state store — one file per key at <baseDir>/<prefix>-<key>.json
 * with tmpfile+rename atomic writes, schema versioning, and ENOENT-as-null reads. Cursor store and
 * pending-message store both layer on top of this primitive.
 * ABOUTME: WHY: extracted from the original CursorStore so the pending-message persistence (Phase
 * 2) doesn't duplicate the atomic-write plumbing. One canonical path for "file must be either
 * old-intact or new-fully-present, never torn" — fewer chances to get it wrong twice.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Options for the generic store. The schema-versioning hooks live here so consumers can evolve
 * their payload format independently — bump `expectedVersion` + add a migrate function and old
 * files migrate forward at read time.
 */
export interface JsonStateStoreOptions<T> {
  baseDir: string;
  /** Filename prefix, e.g. "cursor" or "pending". Final file: `<baseDir>/<prefix>-<key>.json`. */
  filenamePrefix: string;
  /** Schema version this consumer expects to read/write. */
  expectedVersion: number;
  /**
   * Optional migrator — receives a parsed payload from disk with `payload.version < expectedVersion`,
   * returns the migrated payload at expectedVersion. If omitted, an older version throws.
   */
  migrate?: (oldPayload: unknown, oldVersion: number) => T;
  /** Validate the payload shape (post-migration). Throw with a useful message on bad input. */
  validate: (payload: unknown, key: string, path: string) => T;
}

/**
 * Per-key atomic JSON state store. Each `key` (typically a chain name) gets its own file —
 * isolation between keys means a write for chain A can never block or interfere with a read for
 * chain B. The atomic-write pattern is tmpfile + rename: a `kill -9` mid-write leaves either the
 * old file intact or the new one fully present, never a torn file.
 */
export class JsonStateStore<T> {
  constructor(private readonly opts: JsonStateStoreOptions<T>) {}

  /**
   * Per-key write serialisation. Concurrent `write(key, ...)` calls for the SAME key chain onto
   * one another so their tmpfile+rename pairs can't interleave (an interleave could rename a
   * stale or half-written snapshot over a newer one — a lost update). Different keys never block
   * each other.
   */
  private writeTails: Map<string, Promise<void>> = new Map();
  /** Monotonic counter to make each in-flight tmp filename unique even within one process. */
  private writeSeq = 0;

  /**
   * Read the payload for `key`. Returns null when the file does not exist (cold start case) —
   * the caller decides whether to bootstrap from defaults or fail loudly. Throws on malformed
   * JSON, validation failure, or unsupported version without a migrate path: don't silently
   * use empty defaults because a manual edit corrupted the file.
   */
  async read(key: string): Promise<T | null> {
    const path = this.pathFor(key);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      return this.coerceVersion(parsed, key, path);
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  /**
   * Atomically persist `payload`. Writes to `<path>.<pid>.tmp` then renames over the canonical
   * path. On rename failure the tmp is unlinked (best effort — orphan tmp on next attempt would
   * be PID-suffixed and overwritten anyway).
   *
   * The payload's `version` field is stamped from `opts.expectedVersion` — callers don't manage
   * the version themselves.
   */
  async write(key: string, payload: T): Promise<void> {
    // Serialise writes per key: append this write to the key's tail so two concurrent writes for
    // the same key run strictly one-after-another. `prev` is awaited with its rejection swallowed
    // (the previous write's error is surfaced to ITS own caller, not this one). The stored tail is
    // likewise non-rejecting so a failed write doesn't poison the chain for the next writer.
    const prev = this.writeTails.get(key) ?? Promise.resolve();
    const run = prev.then(
      () => this.writeNow(key, payload),
      () => this.writeNow(key, payload),
    );
    this.writeTails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** The actual atomic tmpfile+rename write. Always invoked under the per-key serialisation. */
  private async writeNow(key: string, payload: T): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const versioned = { ...payload, version: this.opts.expectedVersion };
    // Tmp name is unique per write (pid + monotonic counter), so even if serialisation were ever
    // bypassed, two in-flight writes can't clobber each other's tmp file mid-rename.
    const tmpPath = `${path}.${process.pid}.${this.writeSeq++}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(versioned, null, 2)}\n`, "utf8");
    try {
      await rename(tmpPath, path);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        // ignored — orphan tmp is uniquely named; a later run won't collide with it
      }
      throw err;
    }
  }

  /**
   * Resolve version then validate. If the payload's version matches expected, validate directly.
   * If older AND a migrator exists, migrate then validate. Otherwise throw — refusing to load an
   * unsupported version is the difference between "operator notices early" and "data corruption
   * propagates silently."
   */
  private coerceVersion(parsed: unknown, key: string, path: string): T {
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(
        `${this.opts.filenamePrefix}-store: malformed payload for key '${key}' at ${path}. Expected an object.`,
      );
    }
    const version = (parsed as { version?: unknown }).version;
    if (typeof version !== "number" || !Number.isInteger(version)) {
      throw new Error(
        `${this.opts.filenamePrefix}-store: missing or invalid version in payload for key '${key}' at ${path}.`,
      );
    }
    if (version === this.opts.expectedVersion) {
      return this.opts.validate(parsed, key, path);
    }
    if (version < this.opts.expectedVersion && this.opts.migrate) {
      const migrated = this.opts.migrate(parsed, version);
      return this.opts.validate(migrated, key, path);
    }
    throw new Error(
      `${this.opts.filenamePrefix}-store: unsupported version ${version} for key '${key}' at ${path} (expected ${this.opts.expectedVersion}). Delete the file or add a migration.`,
    );
  }

  /**
   * File path for a key. Sanitises the name (slashes, whitespace, capitalisation) so a
   * config-driven key cannot escape baseDir via path traversal.
   */
  private pathFor(key: string): string {
    const safe = key.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    return join(this.opts.baseDir, `${this.opts.filenamePrefix}-${safe}.json`);
  }
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}
