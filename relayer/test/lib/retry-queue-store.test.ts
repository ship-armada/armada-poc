// ABOUTME: Tests for RetryQueueStore — durable backing for the mock CCTP relay's retry queue.
// ABOUTME: WHY: a restart while a failed CCTP message is queued for retry must not lose it (the
// source-chain burn is final, the scan cursor has already advanced past it). These tests pin the
// round-trip (including the bigint nonce serialised as a string) and loud-fail-on-corruption.

import { expect } from "chai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RetryQueueStore,
  RETRY_QUEUE_KEY,
  type PersistedRetryEntry,
} from "../../lib/retry-queue-store";

function makeEntry(nonce: string): PersistedRetryEntry {
  return {
    event: {
      nonce,
      sourceDomain: 0,
      destinationDomain: 1,
      sender: "0x" + "11".repeat(32),
      recipient: "0x" + "22".repeat(32),
      destinationCaller: "0x" + "00".repeat(32),
      minFinalityThreshold: 1000,
      messageBody: "0xdeadbeef",
      rawMessage: "0xcafe",
      txHash: "0x" + "ab".repeat(32),
      blockNumber: 42,
    },
    attempts: 2,
    nextRetryAt: 1_700_000_000_000,
  };
}

describe("RetryQueueStore", function () {
  let dir: string;

  beforeEach(async function () {
    dir = await mkdtemp(join(tmpdir(), "retry-queue-store-"));
  });

  afterEach(async function () {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null on cold start (no file)", async function () {
    // WHY: a fresh relayer has no persisted queue — null signals "start empty", same contract as
    // the sibling stores.
    const store = new RetryQueueStore(dir);
    expect(await store.read()).to.equal(null);
  });

  it("round-trips entries including a large bigint-as-string nonce", async function () {
    // WHY: the in-memory nonce is a bigint; JSON can't encode bigint, so cctp-relay serialises it
    // as a decimal string. A nonce beyond Number.MAX_SAFE_INTEGER must survive the round-trip
    // byte-exact or the restored message would relay against the wrong on-chain nonce.
    const store = new RetryQueueStore(dir);
    const bigNonce = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    await store.write([makeEntry(bigNonce), makeEntry("7")]);

    const data = await store.read();
    expect(data).to.not.equal(null);
    expect(data!.entries.length).to.equal(2);
    expect(data!.entries[0].event.nonce).to.equal(bigNonce);
    expect(BigInt(data!.entries[0].event.nonce)).to.equal(BigInt(bigNonce));
    expect(data!.entries[1].event.nonce).to.equal("7");
    expect(data!.entries[0].attempts).to.equal(2);
  });

  it("writing an empty array clears the queue", async function () {
    const store = new RetryQueueStore(dir);
    await store.write([makeEntry("1")]);
    await store.write([]);
    const data = await store.read();
    expect(data!.entries).to.deep.equal([]);
  });

  it("throws on a corrupt entry rather than silently dropping it", async function () {
    // WHY: a corrupted queue file must fail loudly (operator deletes it to reset) rather than
    // silently feed undefined fields into the relay loop — the same loud-fail principle as the
    // cursor/pending stores.
    const store = new RetryQueueStore(dir);
    const path = join(dir, `cctp-retry-${RETRY_QUEUE_KEY}.json`);
    await writeFile(
      path,
      JSON.stringify({ entries: [{ attempts: "two", nextRetryAt: 0, event: {} }], updatedAt: 0, version: 1 }),
      "utf8",
    );
    let threw = false;
    try {
      await store.read();
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});
