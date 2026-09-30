/**
 * Verification Key Loading Utilities
 *
 * Loads verification keys from Armada's own compiled circuits
 * and formats them for the PrivacyPool contract.
 */

// Armada's own circuit artifacts (replaces unlicensed railgun-circuit-test-artifacts)
import * as armadaArtifacts from './sdk/armada-artifacts';

export interface VKey {
  protocol: string;
  curve: string;
  nPublic: number;
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  vk_alphabeta_12: string[][];
  IC: string[][];
}

export interface ArtifactConfig {
  nullifiers: number;
  commitments: number;
}

export interface G1Point {
  x: bigint;
  y: bigint;
}

export interface G2Point {
  x: [bigint, bigint];
  y: [bigint, bigint];
}

export interface SolidityVerifyingKey {
  artifactsIPFSHash: string;
  alpha1: G1Point;
  beta2: G2Point;
  gamma2: G2Point;
  delta2: G2Point;
  ic: G1Point[];
}

/**
 * Circuit configurations the deployment script registers on PrivacyPool.
 *
 * Railgun's `transact()` proof shape is `(nullifiers, commitments)` — how many input notes
 * the proof spends, and how many output commitments it produces. The contract stores one
 * verification key per (N, M) pair (see VerifierModule); a proof with a shape that isn't
 * registered reverts with `"PrivacyPool: Verification key not set"`.
 *
 * What's needed in practice:
 *  - SHIELD always emits `(1, 2)` — preimage + dummy padding.
 *  - LEND/REDEEM (cross-contract) emits `(1, 1)` — one nullifier, one change.
 *  - TRANSFER with change emits `(N, 2)` — N spent + recipient + change.
 *  - UNSHIELD WITH CONSOLIDATION emits `(N, 1)` — N spent + change (no zero-output shapes
 *    exist in Railgun's circuit set, even when the unshield consumes the exact amount).
 *  - MULTI-RECIPIENT transfer emits `(N, 3)` — uncommon today, cheap insurance to register.
 *
 * The grouping comments below mirror the operation each pair enables. If a user op generates
 * a shape that isn't here, they'll hit `"Verification key not set"` and the op can't proceed
 * without a redeploy or a one-shot register-against-the-live-contract pass (see
 * `scripts/register_missing_vkeys.ts`).
 */
export const TESTING_ARTIFACT_CONFIGS: ArtifactConfig[] = [
  // Original baseline set — used by the first POC deployments.
  { nullifiers: 1, commitments: 1 },  // Cross-contract: lend/redeem (1 unshield -> 1 shield)
  { nullifiers: 1, commitments: 2 },  // Shield: 1 input -> 2 outputs
  { nullifiers: 2, commitments: 2 },  // Simple transfer
  { nullifiers: 2, commitments: 3 },  // Transfer with change
  { nullifiers: 8, commitments: 4 },  // Medium consolidation

  // Consolidation unshields — (N notes spent, 1 change). Triggered whenever the SDK has to
  // combine multiple smaller notes to satisfy a withdrawal/transfer amount. Without these,
  // users with fragmented UTXO sets (which happens fast in normal use — every change output
  // counts) hit "Verification key not set" the moment their largest single note can't cover
  // the requested amount alone.
  { nullifiers: 2, commitments: 1 },
  { nullifiers: 3, commitments: 1 },
  { nullifiers: 4, commitments: 1 },
  { nullifiers: 5, commitments: 1 },
  { nullifiers: 6, commitments: 1 },
  { nullifiers: 7, commitments: 1 },
  { nullifiers: 8, commitments: 1 },

  // Transfer with change variants — (N notes spent, 1 recipient + 1 change).
  { nullifiers: 3, commitments: 2 },
  { nullifiers: 4, commitments: 2 },
  { nullifiers: 5, commitments: 2 },
  { nullifiers: 6, commitments: 2 },

  // Fan-out / multi-recipient cases — (N, 3). Less common but trivially cheap to register
  // alongside the rest; saves a future redeploy if the SDK ever emits one of these.
  { nullifiers: 1, commitments: 3 },
  { nullifiers: 3, commitments: 3 },
  { nullifiers: 4, commitments: 3 },
];

/**
 * Get all available artifact configurations
 */
export function listArtifacts(): ArtifactConfig[] {
  return armadaArtifacts.listArtifacts();
}

/**
 * Get verification key for a specific circuit configuration
 */
export function getVKey(nullifiers: number, commitments: number): VKey {
  return armadaArtifacts.getVKey(nullifiers, commitments);
}

/**
 * Get full artifact (zkey, wasm, vkey) for a specific circuit configuration
 */
export function getArtifact(nullifiers: number, commitments: number): {
  zkey: Uint8Array;
  wasm: Uint8Array;
  vkey: VKey;
} {
  return armadaArtifacts.getArtifact(nullifiers, commitments);
}

/**
 * Generate IPFS hash placeholder for artifact
 * In production, this would be the actual IPFS CID
 */
function getIPFSHash(nullifiers: number, commitments: number): string {
  // For POC, use a placeholder. In production, load from actual IPFS hashes.
  return `QmPOC_${nullifiers}x${commitments}`;
}

/**
 * Format verification key for Solidity contract
 *
 * The verification key format from snarkjs needs to be converted:
 * - G1 points: [x, y, z] -> { x: bigint, y: bigint } (z is always 1 in affine coords)
 * - G2 points: [[x0, x1], [y0, y1], [z0, z1]] -> { x: [x1, x0], y: [y1, y0] }
 *   Note: G2 point coordinates are swapped for Solidity's BN128 precompile
 */
export function formatVKeyForSolidity(
  vkey: VKey,
  nullifiers: number,
  commitments: number
): SolidityVerifyingKey {
  return {
    artifactsIPFSHash: getIPFSHash(nullifiers, commitments),
    alpha1: {
      x: BigInt(vkey.vk_alpha_1[0]),
      y: BigInt(vkey.vk_alpha_1[1]),
    },
    beta2: {
      // Note: coordinates are swapped for Solidity BN128 pairing
      x: [BigInt(vkey.vk_beta_2[0][1]), BigInt(vkey.vk_beta_2[0][0])],
      y: [BigInt(vkey.vk_beta_2[1][1]), BigInt(vkey.vk_beta_2[1][0])],
    },
    gamma2: {
      x: [BigInt(vkey.vk_gamma_2[0][1]), BigInt(vkey.vk_gamma_2[0][0])],
      y: [BigInt(vkey.vk_gamma_2[1][1]), BigInt(vkey.vk_gamma_2[1][0])],
    },
    delta2: {
      x: [BigInt(vkey.vk_delta_2[0][1]), BigInt(vkey.vk_delta_2[0][0])],
      y: [BigInt(vkey.vk_delta_2[1][1]), BigInt(vkey.vk_delta_2[1][0])],
    },
    ic: vkey.IC.map((icEl) => ({
      x: BigInt(icEl[0]),
      y: BigInt(icEl[1]),
    })),
  };
}

/**
 * Load verification keys into the RailgunSmartWallet contract
 *
 * @param contract - RailgunSmartWallet contract instance (attached to proxy)
 * @param configs - Array of circuit configurations to load (default: testing subset)
 * @param logProgress - Whether to log progress (default: true)
 * @param txOverrides - Optional callback returning tx overrides (e.g. nonce). Invoked once per
 *   tx. Threading this in lets callers integrate with their own nonce manager so subsequent
 *   deploy steps don't drift out of sync. Local/Anvil callers can omit it (ethers manages
 *   nonces automatically); public-testnet deploys with manual nonce tracking must pass it.
 */
export async function loadVerificationKeys(
  // Loosely-typed so this helper accepts both the typechain-generated contract type and the
  // minimal mock used in unit tests. The fourth argument carries ethers tx overrides.
  contract: {
    setVerificationKey: (
      nullifiers: number,
      commitments: number,
      vkey: SolidityVerifyingKey,
      ...rest: unknown[]
    ) => Promise<{ wait: () => Promise<unknown> }>;
  },
  configs: ArtifactConfig[] = TESTING_ARTIFACT_CONFIGS,
  logProgress: boolean = true,
  txOverrides?: () => Record<string, unknown>
): Promise<void> {
  if (logProgress) {
    console.log(`Loading ${configs.length} verification keys...`);
  }

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const vkey = getVKey(config.nullifiers, config.commitments);
    const solidityVKey = formatVKeyForSolidity(vkey, config.nullifiers, config.commitments);

    if (logProgress) {
      console.log(
        `  [${i + 1}/${configs.length}] Loading ${config.nullifiers}x${config.commitments}...`
      );
    }

    const tx = await contract.setVerificationKey(
      config.nullifiers,
      config.commitments,
      solidityVKey,
      txOverrides?.() ?? {}
    );
    await tx.wait();
  }

  if (logProgress) {
    console.log(`  Done! Loaded ${configs.length} verification keys.`);
  }
}
