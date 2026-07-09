// ABOUTME: Tests for JsonStateStore's per-key write serialisation + atomic tmpfile+rename.
// ABOUTME: WHY: the iris/cctp relays persist pending state and cursors through this store. Two
// concurrent writes for the same key that interleave their tmpfile+rename pairs could rename a
// stale snapshot over a newer one (lost update) — the exact failure this serialisation prevents.

import { expect } from "chai";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStateStore } from "../../lib/json-state-store";

interface Payload {
  value: number;
}

function makeStore(dir: string): JsonStateStore<Payload> {
  return new JsonStateStore<Payload>({
    baseDir: dir,
    filenamePrefix: "test",
    expectedVersion: 1,
    validate: (payload): Payload => {
      const p = payload as { value?: unknown };
      if (typeof p.value !== "number") {
        throw new Error("invalid payload: value must be a number");
      }
      // Pass the parsed object through (it carries the stamped `version`), mirroring how the real
      // CursorStore / PendingStateStore validators return the whole object.
      return payload as Payload;
    },
  });
}

describe("JsonStateStore", function () {
  let dir: string;

  beforeEach(async function () {
    dir = await mkdtemp(join(tmpdir(), "json-state-store-"));
  });

  afterEach(async function () {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a written payload and stamps the version", async function () {
    const store = makeStore(dir);
    await store.write("hub", { value: 42 });
    expect(await store.read("hub")).to.deep.equal({ value: 42, version: 1 });
  });

  it("serialises concurrent writes to the same key — last write wins, no torn file", async function () {
    // WHY: fire many overlapping writes for one key. Without per-key serialisation their
    // tmpfile→rename pairs interleave and an earlier-issued write can land last (lost update) or a
    // half-written file can be renamed into place. With serialisation the final on-disk value must
    // be the last write issued, and it must be valid (round-trips through validate()).
    const store = makeStore(dir);
    const writes: Promise<void>[] = [];
    for (let i = 1; i <= 25; i++) {
      writes.push(store.write("hub", { value: i }));
    }
    await Promise.all(writes);

    // The last write issued (value 25) must be the durable one — serialisation preserves order.
    expect(await store.read("hub")).to.deep.equal({ value: 25, version: 1 });

    // No orphan tmp files left behind.
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).to.deep.equal([]);
    expect(files).to.deep.equal(["test-hub.json"]);
  });

  it("keeps writes for different keys independent", async function () {
    // WHY: per-key serialisation must not become a global lock — separate keys write their own
    // files and must not clobber or block each other.
    const store = makeStore(dir);
    await Promise.all([
      store.write("hub", { value: 1 }),
      store.write("clienta", { value: 2 }),
      store.write("clientb", { value: 3 }),
    ]);
    expect(await store.read("hub")).to.deep.equal({ value: 1, version: 1 });
    expect(await store.read("clienta")).to.deep.equal({ value: 2, version: 1 });
    expect(await store.read("clientb")).to.deep.equal({ value: 3, version: 1 });
  });

  it("a failed write does not poison subsequent writes to the same key", async function () {
    // WHY: the per-key tail must keep serialising even after one write rejects. If a failure broke
    // the chain, every later write for that key would hang or reject. validate() runs on READ, so
    // we force a write failure by serialising an unserialisable payload (a BigInt JSON can't
    // encode), then confirm a normal write afterwards still lands.
    const store = makeStore(dir);
    const bad = store
      .write("hub", { value: 1n as unknown as number })
      .catch(() => "failed");
    const good = store.write("hub", { value: 7 });
    const [badResult] = await Promise.all([bad, good]);
    expect(badResult).to.equal("failed");
    expect(await store.read("hub")).to.deep.equal({ value: 7, version: 1 });
  });
});
