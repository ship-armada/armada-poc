// ABOUTME: Tests for PendingStateStore — per-source-chain persistence of pending CCTP messages + the
// processed-dedup records (v3: { key, at } so entries can be pruned by age).
// ABOUTME: WHY: in-memory pendingMessages was the second silent-data-loss surface after the cursor. A
// restart between MessageSent discovery and Iris attestation completion would forget the in-flight
// message entirely; with persistence the next boot re-loads exactly the same state. The validation
// tests pin the format invariants so a corrupted file is caught loudly rather than rehydrated as
// garbage; the migration tests pin the v1/v2 → v3 forward paths.

import { expect } from "chai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PendingStateStore,
  type PersistedPendingMessage,
} from "../../lib/pending-state-store";

function samplePending(overrides: Partial<PersistedPendingMessage> = {}): PersistedPendingMessage {
  return {
    messageBytes: "0xabcd",
    messageHash: "0xhash1",
    dedupKey: "0xtx1:0",
    sourceDomain: 6,
    destinationDomain: 0,
    nonce: "0xnonce",
    sourceTxHash: "0xtx1",
    sourceBlock: 12345,
    detectedAt: 1_700_000_000_000,
    pollAttempts: 2,
    lastStatus: "pending",
    retryAttempts: 0,
    nextRetryAt: 0,
    ...overrides,
  };
}

/** Convenience — the processed arg is now a Map<dedupKey, unix-ms>. */
function processedMap(...keys: string[]): Map<string, number> {
  return new Map(keys.map((k, i) => [k, 1_700_000_000_000 + i]));
}

describe("PendingStateStore", function () {
  let dir: string;

  beforeEach(async function () {
    dir = await mkdtemp(join(tmpdir(), "pending-store-"));
  });

  afterEach(async function () {
    await rm(dir, { recursive: true, force: true });
  });

  describe("read/write round trip", function () {
    it("returns null when the file does not exist (cold start)", async function () {
      // WHY: cold-start contract matches CursorStore — null signals "no prior state, bootstrap
      // from empty pending + empty processed set."
      const store = new PendingStateStore(dir);
      expect(await store.read("base-sepolia")).to.equal(null);
    });

    it("round-trips an empty state (no pending messages, no processed entries)", async function () {
      const store = new PendingStateStore(dir);
      await store.write("hub", [], new Map());
      const got = await store.read("hub");
      expect(got?.pending).to.deep.equal([]);
      expect(got?.processed).to.deep.equal([]);
      expect(got?.updatedAt).to.be.a("number");
    });

    it("round-trips pending messages + processed records (key + timestamp)", async function () {
      const store = new PendingStateStore(dir);
      const pending = [
        samplePending({ messageHash: "0xa", sourceTxHash: "0xtxA" }),
        samplePending({ messageHash: "0xb", sourceTxHash: "0xtxB", pollAttempts: 5 }),
      ];
      await store.write("hub", pending, processedMap("0xdone1", "0xdone2"));

      const got = await store.read("hub");
      expect(got?.pending).to.have.lengthOf(2);
      expect(got?.pending[0]?.messageHash).to.equal("0xa");
      expect(got?.pending[1]?.pollAttempts).to.equal(5);
      expect(got?.processed.map((e) => e.key)).to.have.members(["0xdone1", "0xdone2"]);
      // Timestamps survive — they're what the pruner uses.
      expect(got?.processed.every((e) => typeof e.at === "number")).to.equal(true);
    });

    it("sorts processed records by key on write — stable file content across runs", async function () {
      const store = new PendingStateStore(dir);
      await store.write("hub", [], processedMap("0xb", "0xa", "0xc"));
      const got = await store.read("hub");
      expect(got?.processed.map((e) => e.key)).to.deep.equal(["0xa", "0xb", "0xc"]);
    });
  });

  describe("validation", function () {
    it("throws on a pending entry missing a required string field", async function () {
      const store = new PendingStateStore(dir);
      const path = join(dir, "pending-hub.json");
      await writeFile(
        path,
        JSON.stringify({
          pending: [{ messageHash: "0xa" /* missing the rest */ }],
          processed: [],
          updatedAt: 1,
          version: 3,
        }),
        "utf8",
      );
      try {
        await store.read("hub");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.match(/pending\[0\]/);
      }
    });

    it("throws when 'pending' is not an array", async function () {
      const store = new PendingStateStore(dir);
      const path = join(dir, "pending-hub.json");
      await writeFile(
        path,
        JSON.stringify({ pending: "oops", processed: [], updatedAt: 1, version: 3 }),
        "utf8",
      );
      try {
        await store.read("hub");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.match(/invalid 'pending'/);
      }
    });

    it("throws when a processed record has a non-string key", async function () {
      // WHY: the dedup set is keyed by string dedupKeys. A numeric/null key would break the
      // dedup semantics and could allow re-relay of an already-processed message.
      const store = new PendingStateStore(dir);
      const path = join(dir, "pending-hub.json");
      await writeFile(
        path,
        JSON.stringify({
          pending: [],
          processed: [{ key: "0xtx:0", at: 1 }, { key: 42, at: 1 }],
          updatedAt: 1,
          version: 3,
        }),
        "utf8",
      );
      try {
        await store.read("hub");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.match(/processed\[1\]\.key.*not a string/);
      }
    });

    it("throws when a processed record is missing its timestamp", async function () {
      const store = new PendingStateStore(dir);
      const path = join(dir, "pending-hub.json");
      await writeFile(
        path,
        JSON.stringify({
          pending: [],
          processed: [{ key: "0xtx:0" /* at missing */ }],
          updatedAt: 1,
          version: 3,
        }),
        "utf8",
      );
      try {
        await store.read("hub");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.match(/processed\[0\]\.at.*not a finite number/);
      }
    });

    it("throws on unsupported version (would need a migration)", async function () {
      const store = new PendingStateStore(dir);
      const path = join(dir, "pending-hub.json");
      await writeFile(
        path,
        JSON.stringify({ pending: [], processed: [], updatedAt: 1, version: 99 }),
        "utf8",
      );
      try {
        await store.read("hub");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.match(/unsupported version 99/);
      }
    });

    it("accepts Phase 2B submittedTxHash + submittedAt optional fields", async function () {
      const store = new PendingStateStore(dir);
      const pending = [
        samplePending({
          messageHash: "0xinflight",
          submittedTxHash: "0xdesttx123",
          submittedAt: 1_700_000_500_000,
        }),
      ];
      await store.write("hub", pending, new Map());
      const got = await store.read("hub");
      expect(got?.pending[0]?.submittedTxHash).to.equal("0xdesttx123");
      expect(got?.pending[0]?.submittedAt).to.equal(1_700_000_500_000);
    });

    it("rejects a half-populated submittedTxHash/submittedAt pair (corruption)", async function () {
      const store = new PendingStateStore(dir);
      const path = join(dir, "pending-hub.json");
      const halfPopulated = {
        messageBytes: "0xabcd",
        messageHash: "0xa",
        dedupKey: "0xtx:0",
        sourceDomain: 6,
        destinationDomain: 0,
        nonce: "0xn",
        sourceTxHash: "0xtx",
        sourceBlock: 1,
        detectedAt: 1,
        pollAttempts: 0,
        lastStatus: "new",
        retryAttempts: 0,
        nextRetryAt: 0,
        submittedTxHash: "0xhash",
        // submittedAt missing — corruption
      };
      await writeFile(
        path,
        JSON.stringify({ pending: [halfPopulated], processed: [], updatedAt: 1, version: 3 }),
        "utf8",
      );
      try {
        await store.read("hub");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.match(/submittedAt/);
      }
    });
  });

  describe("migration", function () {
    it("migrates a v1 file: back-fills dedupKey on pending, drops legacy processed[]", async function () {
      // WHY: v2 switched dedup from keccak256(messageBytes) to `${sourceTxHash}:${logIndex}` (a real
      // silent-data-loss fix — identical-amount unshields produced byte-identical messageBytes under
      // CCTP V2's zero source nonce). v1 processed hashes are incompatible with the new key → dropped.
      const store = new PendingStateStore(dir);
      const path = join(dir, "pending-hub.json");
      const legacyPending = {
        messageBytes: "0xabcd",
        messageHash: "0xlegacyhash",
        sourceDomain: 6,
        destinationDomain: 0,
        nonce: "0xn",
        sourceTxHash: "0xlegacytx",
        sourceBlock: 1,
        detectedAt: 1,
        pollAttempts: 0,
        lastStatus: "new",
        retryAttempts: 0,
        nextRetryAt: 0,
      };
      await writeFile(
        path,
        JSON.stringify({
          pending: [legacyPending],
          processed: ["0xprev_hash_a", "0xprev_hash_b"],
          updatedAt: 1,
          version: 1,
        }),
        "utf8",
      );
      const got = await store.read("hub");
      expect(got?.version).to.equal(3);
      expect(got?.pending).to.have.lengthOf(1);
      expect(got?.pending[0]?.dedupKey).to.equal("0xlegacytx:0");
      expect(got?.pending[0]?.messageHash).to.equal("0xlegacyhash");
      expect(got?.processed).to.deep.equal([]); // legacy hashes dropped
    });

    it("migrates a v2 file: wraps string[] processed entries as { key, at } with a load timestamp", async function () {
      // WHY: v3 added per-entry timestamps so processed records can be pruned by age. A v2 file's
      // bare dedupKey strings get stamped at load — correct enough, since a message delivered before
      // the migration is already past any re-discovery window.
      const store = new PendingStateStore(dir);
      const path = join(dir, "pending-hub.json");
      await writeFile(
        path,
        JSON.stringify({
          pending: [samplePending({ dedupKey: "0xtxV2:0" })],
          processed: ["0xkeyA", "0xkeyB"],
          updatedAt: 1,
          version: 2,
        }),
        "utf8",
      );
      const got = await store.read("hub");
      expect(got?.version).to.equal(3);
      expect(got?.pending[0]?.dedupKey).to.equal("0xtxV2:0"); // v2 already had dedupKey — preserved
      expect(got?.processed.map((e) => e.key)).to.deep.equal(["0xkeyA", "0xkeyB"]);
      expect(got?.processed.every((e) => typeof e.at === "number")).to.equal(true);
    });

    it("after migration, a re-persist stamps v3 — a second read does not re-trigger the migrator", async function () {
      const store = new PendingStateStore(dir);
      const path = join(dir, "pending-hub.json");
      await writeFile(
        path,
        JSON.stringify({ pending: [], processed: ["0xprev_hash"], updatedAt: 1, version: 2 }),
        "utf8",
      );
      const firstRead = await store.read("hub");
      expect(firstRead?.version).to.equal(3);
      // Persist back under v3 using the Map shape the live code uses.
      await store.write(
        "hub",
        firstRead!.pending,
        new Map(firstRead!.processed.map((e) => [e.key, e.at])),
      );
      const secondRead = await store.read("hub");
      expect(secondRead?.version).to.equal(3);
      expect(secondRead?.processed.map((e) => e.key)).to.deep.equal(["0xprev_hash"]);
    });
  });

  describe("per-chain isolation", function () {
    it("hub and base-sepolia have independent files", async function () {
      const store = new PendingStateStore(dir);
      await store.write("hub", [samplePending({ messageHash: "0xhub" })], processedMap("0xpHub"));
      await store.write("base-sepolia", [samplePending({ messageHash: "0xbase" })], processedMap("0xpBase"));

      const hub = await store.read("hub");
      const base = await store.read("base-sepolia");
      expect(hub?.pending[0]?.messageHash).to.equal("0xhub");
      expect(base?.pending[0]?.messageHash).to.equal("0xbase");
      expect(hub?.processed.map((e) => e.key)).to.deep.equal(["0xpHub"]);
      expect(base?.processed.map((e) => e.key)).to.deep.equal(["0xpBase"]);
    });
  });
});
