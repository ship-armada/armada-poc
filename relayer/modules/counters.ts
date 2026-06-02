/**
 * Counters Module
 *
 * In-process counters surfaced via the /health endpoint. Intentionally minimal — no Prometheus
 * shape, no labels (we'd add labels by composing them into the key string), no histograms or
 * gauges. The point is to give operators a triage view on `curl /health | jq .counters`:
 *
 *   - `feeVerifierRejects.FEE_INSUFFICIENT` — proof's broadcaster output below advertised
 *   - `feeVerifierRejects.INVALID_DATA`     — unknown selector / decode error
 *   - `submitSuccess.transact`              — vanilla transact()
 *   - `submitSuccess.lendAndShield`         — yield deposit (A4)
 *   - `submitSuccess.redeemAndShield`       — yield withdraw (A4)
 *   - `submitSuccess.atomicCrossChainUnshield` — xchain unshield (A5)
 *   - `submitFail.<selectorName>.<errorCode>` — wallet-broadcast / gas / RPC failures by kind
 *
 * Counters reset on process restart — they are point-in-time signal, not historical.
 * Prometheus-shape `/metrics` is tracked as Phase 3C of the relayer hardening doc.
 */

export class Counters {
  private values: Map<string, number> = new Map();

  /** Increment `key` by 1. Creates the key at 1 if it doesn't exist. */
  inc(key: string): void {
    this.values.set(key, (this.values.get(key) ?? 0) + 1);
  }

  /** Snapshot the current counter values for read-only consumption (e.g., /health response). */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.values) out[k] = v;
    return out;
  }
}
