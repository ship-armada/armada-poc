// ABOUTME: Tests for NonceCoordinator — seed-once, serialize-per-chain, no-increment-on-throw,
// reset-reseeds, and cross-chain independence.
// ABOUTME: WHY: this lib is the single nonce authority for an EOA shared by the privacy relay and
// the CCTP relay. A double-allocation here means one path replaces the other's tx in the
// mempool and a user's transaction silently never mines — the exact bug it exists to prevent.

import { expect } from "chai";
import { NonceCoordinator, type NonceProvider } from "../../lib/nonce-coordinator";

/**
 * Controllable stub provider. Records how many times the nonce was queried and from which
 * blockTag, and returns a configurable value (mutable so tests can simulate the on-chain nonce
 * moving between seeds).
 */
class StubProvider implements NonceProvider {
  public calls: Array<{ address: string; blockTag?: string }> = [];
  constructor(public nextNonce: number) {}
  async getTransactionCount(address: string, blockTag?: string): Promise<number> {
    this.calls.push({ address, blockTag });
    return this.nextNonce;
  }
}

const ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** Defer to the next microtask/macrotask so interleaved async work can run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("NonceCoordinator", function () {
  it("seeds from getTransactionCount('pending') once, then increments locally", async function () {
    // WHY: round-tripping the provider for every submit is both slow and the source of the
    // Sepolia load-balancer drift bug — a fresh 'pending' query can hit a backend that hasn't
    // seen our last broadcast. We seed once and track locally thereafter.
    const provider = new StubProvider(5);
    const coord = new NonceCoordinator();
    const seen: number[] = [];

    for (let i = 0; i < 3; i++) {
      await coord.withNonce(1, provider, ADDR, async (nonce) => {
        seen.push(nonce);
      });
    }

    expect(seen).to.deep.equal([5, 6, 7]);
    expect(provider.calls.length).to.equal(1);
    expect(provider.calls[0].blockTag).to.equal("pending");
  });

  it("serializes concurrent calls on the same chain — no two callers get the same nonce", async function () {
    // WHY: the privacy relay and CCTP relay can both submit to the same chain in the same tick.
    // Without serialization both read the same nonce and one tx replaces the other. We fire many
    // overlapping calls and assert every allocated nonce is distinct and contiguous.
    const provider = new StubProvider(100);
    const coord = new NonceCoordinator();
    const allocated: number[] = [];

    const tasks = Array.from({ length: 10 }, () =>
      coord.withNonce(1, provider, ADDR, async (nonce) => {
        // Simulate a broadcast that takes a variable amount of time — the window where the
        // unserialized version would let another caller read the same stale nonce.
        await tick();
        allocated.push(nonce);
      }),
    );
    await Promise.all(tasks);

    const sorted = [...allocated].sort((a, b) => a - b);
    expect(sorted).to.deep.equal([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    // Seeded exactly once despite 10 concurrent callers.
    expect(provider.calls.length).to.equal(1);
  });

  it("does NOT advance the nonce when fn throws — the next caller reuses it", async function () {
    // WHY: a broadcast that rejects (revert during estimation, RPC error) did not consume the
    // nonce. Advancing anyway would leave a permanent gap that wedges every later tx on the chain.
    const provider = new StubProvider(42);
    const coord = new NonceCoordinator();

    let failedNonce = -1;
    try {
      await coord.withNonce(1, provider, ADDR, async (nonce) => {
        failedNonce = nonce;
        throw new Error("broadcast rejected");
      });
      expect.fail("withNonce should have propagated the fn rejection");
    } catch (err) {
      expect((err as Error).message).to.equal("broadcast rejected");
    }
    expect(failedNonce).to.equal(42);

    let nextNonce = -1;
    await coord.withNonce(1, provider, ADDR, async (nonce) => {
      nextNonce = nonce;
    });
    // Reused, not gapped.
    expect(nextNonce).to.equal(42);
    // Still only seeded once — a throw doesn't force a re-seed on its own (caller decides via reset).
    expect(provider.calls.length).to.equal(1);
  });

  it("reset() forces a re-seed from the provider on the next call", async function () {
    // WHY: after a nonce-class error (e.g. 'nonce too low' because another process advanced the
    // account) our local view is stale and the provider is the source of truth. reset() drops the
    // cache so the next withNonce re-reads it.
    const provider = new StubProvider(10);
    const coord = new NonceCoordinator();

    await coord.withNonce(1, provider, ADDR, async () => {});
    expect(coord._cachedNonce(1)).to.equal(11);

    // The chain advanced underneath us (another submitter), provider now reports a higher nonce.
    provider.nextNonce = 20;
    coord.reset(1);

    let reseeded = -1;
    await coord.withNonce(1, provider, ADDR, async (nonce) => {
      reseeded = nonce;
    });
    expect(reseeded).to.equal(20);
    expect(provider.calls.length).to.equal(2);
  });

  it("keeps per-chain counters independent (no cross-chain blocking or sharing)", async function () {
    // WHY: nonce streams are per-chain on the same address. Chain 1's counter must never leak
    // into chain 2, and a slow broadcast on chain 1 must not stall chain 2's allocation.
    const p1 = new StubProvider(1);
    const p2 = new StubProvider(500);
    const coord = new NonceCoordinator();

    const c1: number[] = [];
    const c2: number[] = [];
    await Promise.all([
      coord.withNonce(1, p1, ADDR, async (n) => {
        await tick();
        c1.push(n);
      }),
      coord.withNonce(2, p2, ADDR, async (n) => {
        c2.push(n);
      }),
      coord.withNonce(1, p1, ADDR, async (n) => {
        c1.push(n);
      }),
      coord.withNonce(2, p2, ADDR, async (n) => {
        c2.push(n);
      }),
    ]);

    expect([...c1].sort((a, b) => a - b)).to.deep.equal([1, 2]);
    expect([...c2].sort((a, b) => a - b)).to.deep.equal([500, 501]);
  });

  it("recovers the chain after a failure — a rejected call doesn't poison later callers", async function () {
    // WHY: the per-chain tail must keep serializing even after one critical section rejects. If a
    // failure broke the promise chain, every subsequent submit on that chain would hang or throw.
    const provider = new StubProvider(7);
    const coord = new NonceCoordinator();

    const results: Array<{ ok: boolean; nonce: number }> = [];
    await Promise.allSettled([
      coord
        .withNonce(1, provider, ADDR, async (n) => {
          throw Object.assign(new Error("boom"), { nonce: n });
        })
        .catch((e) => results.push({ ok: false, nonce: e.nonce })),
      coord
        .withNonce(1, provider, ADDR, async (n) => {
          results.push({ ok: true, nonce: n });
        }),
    ]);

    // First reserved 7 and failed (no consume); second reused 7 and succeeded.
    expect(results.find((r) => !r.ok)?.nonce).to.equal(7);
    expect(results.find((r) => r.ok)?.nonce).to.equal(7);
    expect(coord._cachedNonce(1)).to.equal(8);
  });
});
