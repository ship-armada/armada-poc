// ABOUTME: Tests for IdempotencyStore — durable /relay idempotency (key → broadcast hash).
// ABOUTME: WHY: the in-memory calldata dedup loses its state on every deploy/restart, so a client
// retry after a restart re-broadcasts = double spend. These tests pin the four guarantees that
// close that gap: one-broadcast-per-key, concurrent-safe, restart-durable, and TTL-bounded.

import { expect } from "chai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IdempotencyStore,
  type IdempotencyRecord,
} from "../../modules/idempotency-store";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A submit() that records its invocation count and returns a fixed hash. */
function spySubmit(txHash: string, chainId = 1) {
  const state = { calls: 0 };
  const fn = async () => {
    state.calls++;
    await tick();
    return { txHash, chainId };
  };
  return { fn, state };
}

describe("IdempotencyStore", function () {
  let dir: string;

  beforeEach(async function () {
    dir = await mkdtemp(join(tmpdir(), "idempotency-store-"));
  });

  afterEach(async function () {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs submit once on first call, then replays the same hash without re-submitting", async function () {
    // WHY: the core contract — a repeat POST with the same key must return the original broadcast's
    // hash and MUST NOT broadcast again (that would be the double-spend the key exists to prevent).
    const store = new IdempotencyStore(dir);
    await store.initialize();
    const submit = spySubmit("0xaaa1");

    const first = await store.submitOnce("key-1", submit.fn);
    expect(first.replayed).to.equal(false);
    expect(first.txHash).to.equal("0xaaa1");
    expect(submit.state.calls).to.equal(1);

    const second = await store.submitOnce("key-1", submit.fn);
    expect(second.replayed).to.equal(true);
    expect(second.txHash).to.equal("0xaaa1");
    expect(submit.state.calls).to.equal(1); // NOT called again
  });

  it("collapses concurrent same-key POSTs to exactly one broadcast", async function () {
    // WHY: two tabs / a double-click can POST the same key simultaneously before the first persists.
    // The in-flight lock must make the second await the first rather than broadcast in parallel.
    const store = new IdempotencyStore(dir);
    await store.initialize();
    const submit = spySubmit("0xbbb2");

    const [a, b] = await Promise.all([
      store.submitOnce("key-2", submit.fn),
      store.submitOnce("key-2", submit.fn),
    ]);

    expect(submit.state.calls).to.equal(1);
    expect(a.txHash).to.equal("0xbbb2");
    expect(b.txHash).to.equal("0xbbb2");
    // Exactly one of the two was the real broadcast; the other replayed the in-flight result.
    expect(a.replayed).to.not.equal(b.replayed);
  });

  it("survives a restart — a repeat POST after reloading from disk replays, no re-broadcast", async function () {
    // WHY: this is the whole point. The in-memory cache can't do this; a relayer deploy between the
    // original broadcast and the client's retry would re-broadcast. The on-disk record must dedup it.
    const first = new IdempotencyStore(dir);
    await first.initialize();
    await first.submitOnce("key-3", spySubmit("0xccc3").fn);

    // Simulate a restart: brand-new instance over the same state dir.
    const afterRestart = new IdempotencyStore(dir);
    await afterRestart.initialize();
    const submit = spySubmit("0xWRONG"); // would be returned ONLY if it (wrongly) re-broadcast
    const replay = await afterRestart.submitOnce("key-3", submit.fn);

    expect(submit.state.calls).to.equal(0); // never re-broadcast
    expect(replay.replayed).to.equal(true);
    expect(replay.txHash).to.equal("0xccc3"); // the original hash, from disk
  });

  it("does NOT persist a failed submit — a later retry with the same key may try again", async function () {
    // WHY: a submit that throws (gas estimation revert, fee rejected) broadcast nothing, so caching
    // it as 'done' would wedge the key forever. The error must propagate and the key stay free.
    const store = new IdempotencyStore(dir);
    await store.initialize();

    let threw = false;
    try {
      await store.submitOnce("key-4", async () => {
        throw new Error("gas estimation failed");
      });
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.equal("gas estimation failed");
    }
    expect(threw).to.equal(true);
    expect(store.get("key-4")).to.equal(undefined);

    // A retry now runs submit again and succeeds.
    const submit = spySubmit("0xddd4");
    const retry = await store.submitOnce("key-4", submit.fn);
    expect(submit.state.calls).to.equal(1);
    expect(retry.replayed).to.equal(false);
    expect(retry.txHash).to.equal("0xddd4");
  });

  it("evicts records older than the TTL on load", async function () {
    // WHY: bounds the store — without eviction it grows once per tx forever. A record past the TTL
    // is well beyond any tx lifecycle and safe to drop; a fresh one must remain.
    const now = Date.now();
    const old: IdempotencyRecord = {
      idempotencyKey: "old",
      txHash: "0xold",
      chainId: 1,
      status: "confirmed",
      createdAt: now - 10_000,
    };
    const fresh: IdempotencyRecord = {
      idempotencyKey: "fresh",
      txHash: "0xfresh",
      chainId: 1,
      status: "pending",
      createdAt: now,
    };
    await writeFile(
      join(dir, "idempotency-records.json"),
      JSON.stringify({ records: [old, fresh], updatedAt: now, version: 1 }),
      "utf8",
    );

    const store = new IdempotencyStore(dir, 1_000); // 1s TTL
    await store.initialize();
    expect(store.get("old")).to.equal(undefined);
    expect(store.get("fresh")?.txHash).to.equal("0xfresh");
  });

  it("backfills a terminal status onto the matching record (case-insensitive hash)", async function () {
    // WHY: a late repeat POST should report the real terminal status, not a stale "pending". The
    // /status handler calls this when it observes a confirmed/failed receipt.
    const store = new IdempotencyStore(dir);
    await store.initialize();
    await store.submitOnce("key-5", spySubmit("0xEEE5").fn);

    await store.updateStatusByTxHash("0xeee5", "confirmed"); // different case on purpose
    expect(store.get("key-5")?.status).to.equal("confirmed");
  });
});
