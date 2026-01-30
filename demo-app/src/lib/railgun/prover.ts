/**
 * Railgun Prover Initialization
 *
 * Initializes the Groth16 prover for browser-based proof generation.
 * This is REQUIRED before any transfer or unshield operations.
 *
 * See: https://docs.railgun.org/developer-guide/wallet/getting-started/6.-load-a-groth16-prover-for-each-platform
 */

import { getProver } from '@railgun-community/wallet';

// Track initialization state
let isProverInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the Groth16 prover for browser
 *
 * Uses snarkjs for WASM-based proof generation.
 * Must be called after engine initialization, before any transfers or unshields.
 */
export async function initializeProver(): Promise<void> {
  if (isProverInitialized) {
    console.log('[prover] Already initialized');
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = doInitProver();

  try {
    await initPromise;
    isProverInitialized = true;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

async function doInitProver(): Promise<void> {
  console.log('[prover] Initializing Groth16 prover with snarkjs...');

  // Dynamic import of snarkjs to avoid bundling issues
  const snarkjs = await import('snarkjs');

  // Get the prover instance from the engine and set snarkjs as the implementation
  const prover = getProver();
  prover.setSnarkJSGroth16(snarkjs.groth16 as any);

  console.log('[prover] Prover initialized successfully');
}

/**
 * Check if prover is initialized
 */
export function isProverReady(): boolean {
  return isProverInitialized;
}

/**
 * Reset prover state (for testing/retry)
 */
export function resetProver(): void {
  isProverInitialized = false;
  initPromise = null;
}
