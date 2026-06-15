// ABOUTME: Process-wide per-chain nonce coordinator. One EOA signs on every chain for BOTH the
// privacy relay and the CCTP relay; without a single nonce authority the two paths race on the
// same account and silently replace each other's transactions in the mempool.
// ABOUTME: WHY: wallet-manager fetched `getTransactionCount('pending')` per submit while
// iris-relay/cctp-relay each kept their own locally-incremented counter — three views of one
// nonce stream. This serializes the allocate→broadcast window per chain so the views collapse
// into one, and re-seeds from the provider on demand (reset) after nonce-class errors.

/**
 * Minimal provider surface the coordinator needs. Structurally satisfied by ethers v6
 * `JsonRpcProvider` — kept narrow so the lib stays decoupled from ethers for unit testing.
 */
export interface NonceProvider {
  getTransactionCount(address: string, blockTag?: string): Promise<number>;
}

/**
 * Coordinates nonce allocation across every code path that submits transactions from the shared
 * relayer EOA. Keyed by chainId: nonce streams are independent per chain (the same address tracks
 * its own nonce on each chain), so cross-chain submissions never block one another, but two
 * submissions to the SAME chain serialize through that chain's critical section.
 *
 * Contract:
 *   - `withNonce(chainId, provider, address, fn)` seeds the chain's counter from
 *     `getTransactionCount(address, 'pending')` on first use (or after a `reset`), runs `fn` with
 *     the allocated nonce, and increments ONLY when `fn` resolves. A broadcast that resolves has
 *     reserved its nonce in the mempool; a `fn` that throws did not consume the nonce, so the
 *     next caller reuses the same value.
 *   - `reset(chainId)` drops the cached counter so the next `withNonce` re-seeds from the
 *     provider. Call it after a `withNonce` rejection caused by a nonce-class error (the provider
 *     is the source of truth once our local view has drifted) or on stuck-tx detection.
 */
export class NonceCoordinator {
  /** chainId → next nonce to hand out. Absent = needs seeding from the provider. */
  private nonces: Map<number, number> = new Map();
  /**
   * chainId → tail of the per-chain critical-section promise chain. Each `withNonce` appends to
   * the tail so seed+fn+increment runs atomically with respect to other calls on the same chain.
   * The stored tail never rejects (outcomes are swallowed) so one caller's failure can't poison
   * the chain for the next caller.
   */
  private tails: Map<number, Promise<void>> = new Map();

  /**
   * Allocate a nonce for `chainId`, run `fn` with it, and advance the counter on success.
   * Serialized per chain — concurrent calls for the same chain queue; calls for different chains
   * proceed in parallel.
   */
  withNonce<T>(
    chainId: number,
    provider: NonceProvider,
    address: string,
    fn: (nonce: number) => Promise<T>,
  ): Promise<T> {
    const prev = this.tails.get(chainId) ?? Promise.resolve();
    // Chain the critical section after the previous holder regardless of whether it resolved or
    // rejected — `prev` is already a non-rejecting tail, but guard both settle paths defensively.
    const result = prev.then(
      () => this.critical(chainId, provider, address, fn),
      () => this.critical(chainId, provider, address, fn),
    );
    // Store a tail that the NEXT caller waits on. It must never reject (or the next caller's
    // `.then` rejection handler would fire spuriously) and must not surface as an unhandled
    // rejection — `result` itself is returned to and handled by the current caller.
    this.tails.set(
      chainId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /**
   * Drop the cached nonce for `chainId`. The next `withNonce` re-seeds from
   * `getTransactionCount('pending')`. Intended to be called when no `withNonce` for that chain is
   * mid-flight (i.e. from the caller's catch after a `withNonce` rejection) — because critical
   * sections are serialized, the subsequent queued call re-seeds cleanly.
   */
  reset(chainId: number): void {
    this.nonces.delete(chainId);
  }

  /** The per-chain critical section: seed-if-needed → run fn → increment-on-success. */
  private async critical<T>(
    chainId: number,
    provider: NonceProvider,
    address: string,
    fn: (nonce: number) => Promise<T>,
  ): Promise<T> {
    if (!this.nonces.has(chainId)) {
      const seeded = await provider.getTransactionCount(address, "pending");
      this.nonces.set(chainId, seeded);
    }
    const nonce = this.nonces.get(chainId)!;
    // If fn throws, we do NOT advance — the nonce was not consumed and the next caller reuses it.
    const out = await fn(nonce);
    this.nonces.set(chainId, nonce + 1);
    return out;
  }

  /** Test-only: read the cached nonce for a chain (undefined when unseeded). */
  _cachedNonce(chainId: number): number | undefined {
    return this.nonces.get(chainId);
  }
}
