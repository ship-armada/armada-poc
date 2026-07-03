/**
 * Armada Circuit Artifact Provider
 *
 * Serves compiled Armada circuit artifacts (WASM/ZKEY/VKEY) to the Railgun engine,
 * replacing the unlicensed railgun-circuit-test-artifacts package.
 *
 * Build artifacts live in /Users/andrewburger/armada/armada-circuits/build/<N>x<M>/
 * and are produced by:
 *   cd armada-circuits && npm run compile && npm run setup:dev
 *
 * This module exposes the same interface as railgun-circuit-test-artifacts:
 *   getArtifact(nullifiers, commitments) → { wasm, zkey, vkey }
 *   getVKey(nullifiers, commitments) → vkey
 *   listArtifacts() → [{ nullifiers, commitments }, ...]
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Path to armada-circuits build output ───────────────────
// Relative to this file: ../../armada-circuits/build/
const CIRCUITS_BUILD = path.resolve(__dirname, '../../..', 'armada-circuits', 'build');

// ── Shapes produced by armada-circuits/scripts/compile.sh ──
export const ARMADA_SHAPES: Array<{ nullifiers: number; commitments: number }> = [
  { nullifiers: 1, commitments: 1 },
  { nullifiers: 1, commitments: 2 },
  { nullifiers: 1, commitments: 3 },
  { nullifiers: 2, commitments: 1 },
  { nullifiers: 2, commitments: 2 },
  { nullifiers: 2, commitments: 3 },
  { nullifiers: 3, commitments: 1 },
  { nullifiers: 3, commitments: 2 },
  { nullifiers: 3, commitments: 3 },
  { nullifiers: 4, commitments: 1 },
  { nullifiers: 4, commitments: 2 },
  { nullifiers: 4, commitments: 3 },
  { nullifiers: 5, commitments: 1 },
  { nullifiers: 5, commitments: 2 },
  { nullifiers: 6, commitments: 1 },
  { nullifiers: 6, commitments: 2 },
  { nullifiers: 7, commitments: 1 },
  { nullifiers: 8, commitments: 1 },
  { nullifiers: 8, commitments: 4 },
];

// ── Cache ──────────────────────────────────────────────────
interface CachedArtifact {
  wasm: Uint8Array;
  zkey: Uint8Array;
  vkey: any;
}

const cache = new Map<string, CachedArtifact>();

function shapeKey(n: number, m: number): string {
  return `${n}x${m}`;
}

function shapeDir(n: number, m: number): string {
  return path.join(CIRCUITS_BUILD, shapeKey(n, m));
}

/**
 * Load circuit artifacts for the given shape.
 * Returns { wasm, zkey, vkey } as in-memory bytes/objects.
 */
export function getArtifact(nullifiers: number, commitments: number): CachedArtifact {
  const key = shapeKey(nullifiers, commitments);

  const cached = cache.get(key);
  if (cached) return cached;

  const dir = shapeDir(nullifiers, commitments);
  const wasmFile = path.join(dir, `main_${key}_js`, `main_${key}.wasm`);
  const zkeyFile = path.join(dir, 'final.zkey');
  const vkeyFile = path.join(dir, 'vkey.json');

  if (!fs.existsSync(zkeyFile)) {
    throw new Error(
      `Armada circuit artifacts not found for shape ${key}. ` +
      `Run: cd armada-circuits && npm run compile && npm run setup:dev. ` +
      `Expected: ${zkeyFile}`
    );
  }

  const wasm = fs.readFileSync(wasmFile);
  const zkey = fs.readFileSync(zkeyFile);
  const vkey = JSON.parse(fs.readFileSync(vkeyFile, 'utf-8'));

  const artifact: CachedArtifact = { wasm, zkey, vkey };
  cache.set(key, artifact);
  return artifact;
}

/**
 * Get just the verification key for a shape.
 */
export function getVKey(nullifiers: number, commitments: number): any {
  return getArtifact(nullifiers, commitments).vkey;
}

/**
 * List all available circuit shapes.
 */
export function listArtifacts(): Array<{ nullifiers: number; commitments: number }> {
  return [...ARMADA_SHAPES];
}
