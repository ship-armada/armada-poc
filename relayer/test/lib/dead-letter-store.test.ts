// ABOUTME: Tests for DeadLetterStore — durable per-chain records for permanently-failed CCTP
// messages, surfaced as /health deadLetterCount.
// ABOUTME: WHY: a dead-lettered message means USDC may be stranded; the record must survive
// restarts (so operators can find + manually relay it) and reject corruption loudly rather than
// silently dropping the only evidence the message existed.

import { expect } from "chai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeadLetterStore,
  type DeadLetterRecord,
} from "../../lib/dead-letter-store";

function makeRecord(id: string, reason: DeadLetterRecord["reason"]): DeadLetterRecord {
  return {
    id,
    sourceTxHash: "0x" + "ab".repeat(32),
    rawMessage: "0xcafebabe",
    reason,
    sourceDomain: 0,
    destinationDomain: 1,
    at: 1_700_000_000_000,
  };
}

describe("DeadLetterStore", function () {
  let dir: string;

  beforeEach(async function () {
    dir = await mkdtemp(join(tmpdir(), "dead-letter-store-"));
  });

  afterEach(async function () {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null for a chain with no records (cold start)", async function () {
    const store = new DeadLetterStore(dir);
    expect(await store.read("hub")).to.equal(null);
  });

  it("round-trips records per chain and keeps chains independent", async function () {
    // WHY: deadLetterCount in /health is reported per source chain, so records must not bleed
    // across chain files.
    const store = new DeadLetterStore(dir);
    await store.write("hub", [makeRecord("0-1", "retries-exhausted")]);
    await store.write("clienta", [
      makeRecord("1-2", "expired"),
      makeRecord("1-3", "fee-too-low"),
    ]);

    expect((await store.read("hub"))!.records).to.have.length(1);
    expect((await store.read("hub"))!.records[0].reason).to.equal("retries-exhausted");
    expect((await store.read("clienta"))!.records).to.have.length(2);
  });

  it("rejects a record with an unknown reason rather than accepting garbage", async function () {
    // WHY: reason drives operator triage; an unrecognised reason signals a writer/version bug and
    // should fail loudly so it's caught, not silently surfaced in dashboards.
    const store = new DeadLetterStore(dir);
    const path = join(dir, "deadletter-hub.json");
    await writeFile(
      path,
      JSON.stringify({
        records: [{ ...makeRecord("0-1", "retries-exhausted"), reason: "who-knows" }],
        updatedAt: 0,
        version: 1,
      }),
      "utf8",
    );
    let threw = false;
    try {
      await store.read("hub");
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});
