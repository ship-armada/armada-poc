// ABOUTME: Tiny in-process token-bucket rate limiter + Express middleware. The relayer's HTTP API
// is public and unauthenticated; each /relay costs SNARK-ciphertext decryption + an estimateGas
// RPC, so an unbounded request rate is a cheap DoS / cost-amplification vector.
// ABOUTME: No external dependency (express-rate-limit etc.) — a token bucket per client key with
// lazy pruning of idle buckets is all this needs. Pure core (injectable clock) so it's unit-tested
// without timers or a live server.

/** Minimal request shape the middleware reads — keeps this decoupled from express's types. */
export interface RateLimitedRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}

export interface RateLimiterOptions {
  /** Max burst — a fresh key starts with this many tokens. */
  capacity: number;
  /** Sustained refill rate in tokens per second. */
  refillPerSec: number;
  /** Injectable clock (ms). Defaults to Date.now. Parameterised so tests are deterministic. */
  now?: () => number;
  /** How often (ms) to sweep idle full buckets out of the map. Default 5 min. */
  pruneIntervalMs?: number;
}

/**
 * Token-bucket limiter keyed by an arbitrary string (here, client IP). Each `allow()` refills the
 * bucket by elapsed-time × rate (capped at capacity) and consumes one token; returns false when
 * the bucket is empty. Idle buckets that have refilled to capacity are pruned, so memory is bounded
 * by the number of *currently active* clients, not all clients ever seen.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly pruneIntervalMs: number;
  private lastPrune: number;

  constructor(opts: RateLimiterOptions) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.now = opts.now ?? Date.now;
    this.pruneIntervalMs = opts.pruneIntervalMs ?? 5 * 60 * 1000;
    this.lastPrune = this.now();
  }

  /** Consume one token for `key`. Returns true if allowed, false if the bucket is empty. */
  allow(key: string): boolean {
    const now = this.now();
    this.maybePrune(now);
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = (now - b.last) / 1000;
      b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
      b.last = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Test/inspection helper — number of buckets currently tracked. */
  size(): number {
    return this.buckets.size;
  }

  /** Drop buckets that have refilled to capacity and are therefore indistinguishable from fresh. */
  private maybePrune(now: number): void {
    if (now - this.lastPrune < this.pruneIntervalMs) return;
    this.lastPrune = now;
    for (const [k, b] of this.buckets) {
      const refilled = Math.min(this.capacity, b.tokens + ((now - b.last) / 1000) * this.refillPerSec);
      if (refilled >= this.capacity) this.buckets.delete(k);
    }
  }
}

/**
 * Resolve the client key for rate limiting. When `trustProxy` is on we honour the FIRST hop in
 * `X-Forwarded-For` (the original client behind a known reverse proxy); otherwise we use the direct
 * socket address. Trusting XFF blindly would let any client spoof their key, so it's opt-in via
 * `RELAYER_TRUST_PROXY`.
 */
export function clientKey(req: RateLimitedRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const value = Array.isArray(xff) ? xff[0] : xff;
    if (typeof value === "string" && value.length > 0) {
      const first = value.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}
