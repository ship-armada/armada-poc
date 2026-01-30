/**
 * SDK Engine Initialization
 *
 * Sets up RailgunEngine with:
 * - LevelDB storage for wallet data
 * - Artifact loading using test artifacts (for local devnet)
 * - Custom chain configuration
 * - Stub implementations for quick sync (not needed for local devnet)
 */

import {
  RailgunEngine,
  ArtifactGetter,
  TXIDVersion,
  AccumulatedEvents,
  QuickSyncEvents,
  QuickSyncRailgunTransactionsV2,
  MerklerootValidator,
  GetLatestValidatedRailgunTxid,
  PollingJsonRpcProvider,
} from '@railgun-community/engine';
import {
  Artifact,
  assertArtifactExists,
  Chain,
  isDefined,
} from '@railgun-community/shared-models';
// @ts-ignore - leveldown types
import leveldown from 'leveldown';
import * as path from 'path';
import * as fs from 'fs';
import { HUB_CHAIN, HUB_RPC, CLIENT_RPC, DEPLOYMENT_BLOCK } from './chain-config';
import { ethers, FallbackProvider } from 'ethers';

// @ts-ignore - test artifacts package
import { getArtifact } from 'railgun-circuit-test-artifacts';

// ============ Storage Configuration ============

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'railgun-db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============ Engine Instance ============

let engine: RailgunEngine | undefined;

/**
 * Get the initialized engine instance
 */
export function getEngine(): RailgunEngine {
  if (!engine) {
    throw new Error('Engine not initialized. Call initializeEngine() first.');
  }
  return engine;
}

/**
 * Check if engine is initialized
 */
export function hasEngine(): boolean {
  return isDefined(engine);
}

// ============ Artifact Getter ============

/**
 * Artifact cache to avoid reloading
 */
const artifactCache: Map<string, Artifact> = new Map();

/**
 * Get artifacts for circuit with given nullifiers and commitments
 * Uses the test artifacts package for our local devnet
 */
async function getArtifacts(inputs: {
  nullifiers: bigint[];
  commitmentsOut: bigint[];
}): Promise<Artifact> {
  const nullifiers = inputs.nullifiers.length;
  const commitments = inputs.commitmentsOut.length;

  const key = `${nullifiers}x${commitments}`;

  // Check cache first
  const cached = artifactCache.get(key);
  if (cached) {
    return cached;
  }

  console.log(`Loading artifacts for circuit ${key}...`);

  try {
    // Get from test artifacts package
    const testArtifact = getArtifact(nullifiers, commitments);

    const artifact: Artifact = {
      wasm: testArtifact.wasm,
      zkey: testArtifact.zkey,
      vkey: testArtifact.vkey,
      dat: undefined, // Not needed for our circuits
    };

    artifactCache.set(key, artifact);
    return artifact;
  } catch (error) {
    throw new Error(
      `Failed to load artifacts for ${key}. ` +
        `Available circuits: 1x2, 2x2, 2x3, 8x4. Error: ${error}`
    );
  }
}

/**
 * Get artifacts for POI (Proof of Innocence)
 * Not used in our POC, but required by the interface
 */
async function getArtifactsPOI(
  maxInputs: number,
  maxOutputs: number
): Promise<Artifact> {
  // POI not used in local devnet
  throw new Error('POI artifacts not available in local devnet');
}

/**
 * Artifact getter implementation for local devnet
 */
const artifactGetter: ArtifactGetter = {
  assertArtifactExists,
  getArtifacts,
  getArtifactsPOI,
};

// ============ Quick Sync Stubs ============

/**
 * Quick sync for commitment events - stub for local devnet
 * In production, this would fetch historical events from a graph node
 */
const quickSyncEvents: QuickSyncEvents = async (
  txidVersion: TXIDVersion,
  chain: Chain,
  startingBlock: number
): Promise<AccumulatedEvents> => {
  // Local devnet doesn't need quick sync - we scan from block 0
  return {
    commitmentEvents: [],
    unshieldEvents: [],
    nullifierEvents: [],
  };
};

/**
 * Quick sync for Railgun transactions V2 - stub for local devnet
 */
const quickSyncRailgunTransactionsV2: QuickSyncRailgunTransactionsV2 = async (
  chain: Chain,
  latestGraphID: string | undefined
): Promise<any[]> => {
  // Not used in local devnet
  return [];
};

/**
 * Merkleroot validation - always valid for local devnet
 */
const validateRailgunTxidMerkleroot: MerklerootValidator = async (
  txidVersion: TXIDVersion,
  chain: Chain,
  tree: number,
  index: number,
  merkleroot: string
): Promise<boolean> => {
  // In local devnet, we trust all merkleroots
  return true;
};

/**
 * Get latest validated Railgun txid - stub for local devnet
 */
const getLatestValidatedRailgunTxid: GetLatestValidatedRailgunTxid = async (
  txidVersion: TXIDVersion,
  chain: Chain
): Promise<{
  txidIndex: number | undefined;
  merkleroot: string | undefined;
}> => {
  // Not used in local devnet
  return {
    txidIndex: undefined,
    merkleroot: undefined,
  };
};

// ============ Engine Initialization ============

/**
 * Debug logger for engine events
 */
const engineDebugger = {
  log: (msg: string) => {
    if (process.env.DEBUG_ENGINE) {
      console.log(`[Engine] ${msg}`);
    }
  },
  error: (error: Error) => {
    console.error(`[Engine Error] ${error.message}`);
  },
  verboseScanLogging: false,
};

/**
 * Initialize the Railgun Engine for local devnet
 *
 * @param walletSource - Name for wallet source (max 16 chars, lowercase)
 * @returns Initialized RailgunEngine instance
 */
export async function initializeEngine(
  walletSource: string = 'cctppoc'
): Promise<RailgunEngine> {
  if (engine) {
    console.log('Engine already initialized');
    return engine;
  }

  console.log('Initializing Railgun Engine...');
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  Wallet source: ${walletSource}`);

  // Create LevelDB instance
  const db = leveldown(DB_PATH);

  // Initialize engine
  engine = await RailgunEngine.initForWallet(
    walletSource,
    db,
    artifactGetter,
    quickSyncEvents,
    quickSyncRailgunTransactionsV2,
    validateRailgunTxidMerkleroot,
    getLatestValidatedRailgunTxid,
    engineDebugger,
    false // skipMerkletreeScans
  );

  console.log('Engine initialized successfully');

  return engine;
}

/**
 * Load network into engine
 * Must be called after initializeEngine()
 *
 * Note: This is a simplified version for local devnet.
 * The full loadNetwork requires V3 contract addresses and polling providers.
 * For our POC, we don't need the full network loading - we interact
 * with contracts directly via ethers.
 *
 * @param chain - Chain to load
 * @param railgunProxyAddress - Address of RailgunSmartWallet proxy
 */
export async function loadNetwork(
  chain: Chain,
  railgunProxyAddress: string
): Promise<void> {
  const eng = getEngine();

  console.log(`Loading network for chain ${chain.id}...`);
  console.log(`  Railgun proxy: ${railgunProxyAddress}`);

  // Get RPC URL for chain
  const rpcUrl = chain.id === HUB_CHAIN.id ? HUB_RPC : CLIENT_RPC;

  // Create provider
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Create deployment blocks record
  const deploymentBlocks: Record<TXIDVersion, number> = {
    [TXIDVersion.V2_PoseidonMerkle]: DEPLOYMENT_BLOCK,
    [TXIDVersion.V3_PoseidonMerkle]: DEPLOYMENT_BLOCK,
  };

  // Note: The full loadNetwork requires:
  // - PollingJsonRpcProvider (for event listening)
  // - V3 contract addresses (PoseidonMerkleAccumulator, PoseidonMerkleVerifier, TokenVault)
  // - RelayAdapt address
  //
  // For our POC, we'll skip full network loading and use direct contract calls.
  // The engine is still useful for wallet creation and key derivation.

  console.log(`  Note: Skipping full network load (not needed for POC wallet operations)`);
  console.log(`Network setup complete for chain ${chain.id}`);
}

/**
 * Shutdown the engine
 */
export async function shutdownEngine(): Promise<void> {
  if (engine) {
    await engine.unload();
    engine = undefined;
    console.log('Engine shut down');
  }
}

/**
 * Clear the database (for fresh start)
 */
export function clearDatabase(): void {
  if (fs.existsSync(DB_PATH)) {
    fs.rmSync(DB_PATH, { recursive: true, force: true });
    console.log('Database cleared');
  }
}
