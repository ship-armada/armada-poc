/**
 * Verification Key Loading Utilities
 *
 * Loads verification keys from railgun-circuit-test-artifacts package
 * and formats them for the RailgunSmartWallet contract.
 */

// Use require for CommonJS module
// eslint-disable-next-line @typescript-eslint/no-var-requires
const artifacts = require("railgun-circuit-test-artifacts");

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
 * Testing subset of circuit configurations
 * These cover the most common use cases for shield/transfer/unshield
 */
export const TESTING_ARTIFACT_CONFIGS: ArtifactConfig[] = [
  { nullifiers: 1, commitments: 1 },  // Cross-contract: lend/redeem (1 unshield -> 1 shield)
  { nullifiers: 1, commitments: 2 },  // Shield: 1 input -> 2 outputs
  { nullifiers: 2, commitments: 2 },  // Simple transfer
  { nullifiers: 2, commitments: 3 },  // Transfer with change
  { nullifiers: 8, commitments: 4 },  // Medium consolidation
];

/**
 * Get all available artifact configurations
 */
export function listArtifacts(): ArtifactConfig[] {
  return artifacts.listArtifacts();
}

/**
 * Get verification key for a specific circuit configuration
 */
export function getVKey(nullifiers: number, commitments: number): VKey {
  return artifacts.getVKey(nullifiers, commitments);
}

/**
 * Get full artifact (zkey, wasm, vkey) for a specific circuit configuration
 */
export function getArtifact(nullifiers: number, commitments: number): {
  zkey: Uint8Array;
  wasm: Uint8Array;
  vkey: VKey;
} {
  return artifacts.getArtifact(nullifiers, commitments);
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
 */
export async function loadVerificationKeys(
  contract: {
    setVerificationKey: (
      nullifiers: number,
      commitments: number,
      vkey: SolidityVerifyingKey
    ) => Promise<{ wait: () => Promise<void> }>;
  },
  configs: ArtifactConfig[] = TESTING_ARTIFACT_CONFIGS,
  logProgress: boolean = true
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
      solidityVKey
    );
    await tx.wait();
  }

  if (logProgress) {
    console.log(`  Done! Loaded ${configs.length} verification keys.`);
  }
}
