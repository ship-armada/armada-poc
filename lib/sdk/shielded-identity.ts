// ABOUTME: Backend-selectable shielded-identity derivation — routes 0zk address derivation to the
// ABOUTME: stock Railgun engine or the new @armada/sdk, chosen by the SDK_BACKEND env flag (default stock).

export type SdkBackend = 'stock' | 'armada';

/** The active backend, from SDK_BACKEND (default 'stock' — nothing changes until we opt in). */
export function selectedBackend(): SdkBackend {
  return process.env.SDK_BACKEND === 'armada' ? 'armada' : 'stock';
}

/**
 * Derive a wallet's 0zk shielded address from its 32-byte rootSecret.
 *
 * The armada backend uses `@armada/sdk`'s `deriveKeyset` (byte-identical to the stock engine per
 * Phase 0 Spike 1 + the keyset differential vectors). The stock path is not wired here yet — the
 * captured keyset vectors serve as the stock ground truth for the parity seam; the live stock-engine
 * derivation stays in `lib/sdk/wallet.ts` until the full facade cutover.
 */
export async function deriveShieldedAddress(
  rootSecret: Uint8Array,
  backend: SdkBackend = selectedBackend(),
): Promise<string> {
  if (backend === 'armada') {
    // Lazy import so the stock path never loads the SDK (or triggers its WASM init). deriveKeyset
    // initialises poseidon internally (WASM, or a byte-identical JS fallback if not yet ready).
    const { deriveKeyset } = await import('@armada/sdk');
    return (await deriveKeyset(rootSecret)).railgunAddress;
  }
  // TODO(Phase 2 integration): wire the stock-engine 0zk derivation through this facade too, so both
  // backends run side-by-side. For now the parity seam compares the armada backend to the
  // stock-captured keyset vectors (scripts/capture/vectors/keyset-vectors.json).
  throw new Error('deriveShieldedAddress: stock backend not wired here yet (Phase 2 integration TODO)');
}
