// ABOUTME: Tests for the in-process token-bucket RateLimiter + clientKey helper.
// ABOUTME: WHY: the public /relay endpoint costs SNARK decryption + an RPC per call; the limiter is
// the only thing bounding anonymous request cost. These tests pin burst, refill, per-key
// isolation, idle pruning, and the opt-in X-Forwarded-For trust (spoofable unless RELAYER_TRUST_PROXY).

import { expect } from "chai";
import { RateLimiter, clientKey, type RateLimitedRequest } from "../../lib/rate-limiter";

describe("RateLimiter", function () {
  it("allows up to capacity then blocks until refill", function () {
    // WHY: the burst allowance is `capacity`; the (capacity+1)th request in the same instant must
    // be rejected, and a later request must be allowed once enough time has refilled a token.
    let t = 1_000_000;
    const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1, now: () => t });

    expect(limiter.allow("ip1")).to.equal(true);
    expect(limiter.allow("ip1")).to.equal(true);
    expect(limiter.allow("ip1")).to.equal(true);
    expect(limiter.allow("ip1")).to.equal(false); // bucket empty

    t += 1000; // 1s → +1 token at refillPerSec=1
    expect(limiter.allow("ip1")).to.equal(true);
    expect(limiter.allow("ip1")).to.equal(false);
  });

  it("isolates buckets per key", function () {
    // WHY: one abusive client must not consume another client's budget.
    let t = 0;
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1, now: () => t });
    expect(limiter.allow("a")).to.equal(true);
    expect(limiter.allow("a")).to.equal(false);
    expect(limiter.allow("b")).to.equal(true); // b has its own full bucket
  });

  it("caps refill at capacity (no unbounded accumulation while idle)", function () {
    let t = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
    limiter.allow("a"); // consume 1 → 1 left
    t += 100_000; // long idle — would over-refill if uncapped
    expect(limiter.allow("a")).to.equal(true);
    expect(limiter.allow("a")).to.equal(true);
    expect(limiter.allow("a")).to.equal(false); // only capacity (2), not 100k, tokens
  });

  it("prunes idle full buckets so memory is bounded by active clients", function () {
    // WHY: a bucket that has refilled to capacity is indistinguishable from a fresh one, so it can
    // be dropped. Without pruning the map would grow once per unique IP forever.
    let t = 0;
    const limiter = new RateLimiter({
      capacity: 1,
      refillPerSec: 1,
      now: () => t,
      pruneIntervalMs: 1000,
    });
    limiter.allow("a");
    limiter.allow("b");
    expect(limiter.size()).to.equal(2);
    t += 5000; // both refill to capacity AND the prune interval elapses
    limiter.allow("c"); // triggers maybePrune → a and b are dropped, c added
    expect(limiter.size()).to.equal(1);
  });
});

describe("clientKey", function () {
  const base = (overrides: Partial<RateLimitedRequest>): RateLimitedRequest => ({
    ip: "10.0.0.1",
    socket: { remoteAddress: "10.0.0.9" },
    headers: {},
    ...overrides,
  });

  it("uses the socket/ip key and IGNORES X-Forwarded-For when trustProxy is off", function () {
    // WHY: trusting XFF blindly lets any client spoof their rate-limit key by sending a header.
    const req = base({ headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(clientKey(req, false)).to.equal("10.0.0.1");
  });

  it("honours the first X-Forwarded-For hop when trustProxy is on", function () {
    const req = base({ headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } });
    expect(clientKey(req, true)).to.equal("1.2.3.4");
  });

  it("falls back to the socket address when ip is absent", function () {
    const req = base({ ip: undefined });
    expect(clientKey(req, false)).to.equal("10.0.0.9");
  });
});
