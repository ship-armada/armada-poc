// ABOUTME: Tests for CctpDeliveryStore — the messageHash→delivery index behind GET /cctp-status.
// ABOUTME: WHY: the frontend polls this as the PRIMARY cross-chain delivery signal (404 → it falls
// back to an on-chain scan). These pin the status transitions, terminal-state immutability,
// case-insensitive lookup, restart durability, and TTL eviction the endpoint relies on.

import { expect } from "chai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CctpDeliveryStore,
  type DeliveryRecord,
} from "../../modules/cctp-delivery-store";

const HASH = "0x" + "ab".repeat(32);

describe("CctpDeliveryStore", function () {
  let dir: string;
  // Hoisted so afterEach can await any fire-and-forget persist before removing the dir — otherwise
  // a void persist racing the rm logs a (harmless) EINVAL and dirties the test output.
  let store: CctpDeliveryStore;

  beforeEach(async function () {
    dir = await mkdtemp(join(tmpdir(), "cctp-delivery-store-"));
    store = new CctpDeliveryStore(dir);
  });

  afterEach(async function () {
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined for an unknown hash (→ endpoint 404 → frontend scan fallback)", async function () {
    await store.initialize();
    expect(store.get(HASH)).to.equal(undefined);
  });

  it("records pending → delivered with the destination tx hash + amount", async function () {
    // WHY: the core contract — delivered MUST carry destTxHash (the frontend completes on it).
    await store.initialize();

    store.markPending(HASH, { amount: "1000000" });
    expect(store.get(HASH)?.status).to.equal("pending");
    expect(store.get(HASH)?.amount).to.equal("1000000");

    store.markDelivered(HASH, "0xdest123");
    const rec = store.get(HASH);
    expect(rec?.status).to.equal("delivered");
    expect(rec?.destTxHash).to.equal("0xdest123");
    expect(rec?.amount).to.equal("1000000"); // carried over from pending
  });

  it("records a failed delivery with an error reason", async function () {
    await store.initialize();
    store.markFailed(HASH, "dead-letter: retries-exhausted");
    expect(store.get(HASH)?.status).to.equal("failed");
    expect(store.get(HASH)?.error).to.equal("dead-letter: retries-exhausted");
  });

  it("never reverts a terminal status back to pending", async function () {
    // WHY: a late source-scan tick must not knock a delivered/failed message back to 'pending' and
    // make the frontend resume waiting on an already-resolved tx.
    await store.initialize();
    store.markDelivered(HASH, "0xdest");
    store.markPending(HASH);
    expect(store.get(HASH)?.status).to.equal("delivered");
    expect(store.get(HASH)?.destTxHash).to.equal("0xdest");
  });

  it("looks up case-insensitively", async function () {
    // WHY: the frontend sends keccak256 hex; we must match regardless of case.
    await store.initialize();
    store.markDelivered(HASH.toUpperCase(), "0xdest");
    expect(store.get(HASH.toLowerCase())?.status).to.equal("delivered");
  });

  it("survives a restart — a delivered record reloads from disk", async function () {
    // WHY: real-mode delivery confirmation can lag a deploy; the record must outlive a restart so a
    // post-restart poll still gets the authoritative destTxHash instead of 404.
    const first = new CctpDeliveryStore(dir);
    await first.initialize();
    first.markDelivered(HASH, "0xdest456", { amount: "500" });
    await first.flush(); // mark* is fire-and-forget; ensure the write landed before "restart"

    const afterRestart = new CctpDeliveryStore(dir);
    await afterRestart.initialize();
    const rec = afterRestart.get(HASH);
    expect(rec?.status).to.equal("delivered");
    expect(rec?.destTxHash).to.equal("0xdest456");
    expect(rec?.amount).to.equal("500");
  });

  it("evicts records older than the TTL on load", async function () {
    const now = Date.now();
    const old: DeliveryRecord = {
      messageHash: "0x" + "11".repeat(32),
      status: "delivered",
      destTxHash: "0xold",
      updatedAt: now - 10_000,
    };
    const fresh: DeliveryRecord = {
      messageHash: "0x" + "22".repeat(32),
      status: "pending",
      updatedAt: now,
    };
    await writeFile(
      join(dir, "cctp-delivery-records.json"),
      JSON.stringify({ records: [old, fresh], updatedAt: now, version: 1 }),
      "utf8",
    );

    store = new CctpDeliveryStore(dir, 1_000); // 1s TTL
    await store.initialize();
    expect(store.get(old.messageHash)).to.equal(undefined);
    expect(store.get(fresh.messageHash)?.status).to.equal("pending");
  });
});
