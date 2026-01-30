/**
 * SDK Network Loading and Merkle Tree Sync
 *
 * Integrates with the SDK's network management for:
 * - Loading deployed contract addresses
 * - Setting up merkle tree syncing from on-chain events
 * - Scanning for shielded balances
 *
 * This replaces manual merkle tree management with SDK's proper implementation.
 */

import {
  RailgunEngine,
  PollingJsonRpcProvider,
  createPollingJsonRpcProviderForListeners,
  TXIDVersion,
  TokenBalances,
} from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';
import { ethers, FallbackProvider, JsonRpcProvider } from 'ethers';
import { getEngine } from './init';
import { HUB_CHAIN, CLIENT_CHAIN, HUB_RPC, CLIENT_RPC, DEPLOYMENT_BLOCK } from './chain-config';
import * as fs from 'fs';
import * as path from 'path';

// ============ Types ============

export interface DeploymentInfo {
  chainId: number;
  deployer: string;
  contracts: {
    poseidonT3: string;
    poseidonT4: string;
    proxyAdmin: string;
    treasuryImpl: string;
    treasuryProxy: string;
    railgunImpl: string;
    railgunProxy: string;
  };
  config: {
    shieldFee: number;
    unshieldFee: number;
    nftFee: number;
    testingMode: boolean;
    verificationKeysLoaded: string[];
  };
  timestamp: string;
}

export interface NetworkLoadResult {
  chain: Chain;
  railgunProxy: string;
  deploymentBlock: number;
  fees: {
    shield: bigint;
    unshield: bigint;
  };
}

// ============ Deployment Loading ============

const DEPLOYMENTS_DIR = path.join(__dirname, '../../deployments');

/**
 * Load deployment info from file
 *
 * @param filename - Deployment file name (without .json)
 */
export function loadDeployment(filename: string): DeploymentInfo {
  const filepath = path.join(DEPLOYMENTS_DIR, `${filename}.json`);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Deployment file not found: ${filepath}`);
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

/**
 * Get Railgun proxy address from deployment
 */
export function getRailgunProxyAddress(filename: string = 'railgun'): string {
  const deployment = loadDeployment(filename);
  return deployment.contracts.railgunProxy;
}

/**
 * List available deployments
 */
export function listDeployments(): string[] {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(DEPLOYMENTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}

// ============ Provider Creation ============

/**
 * Create a FallbackProvider for a chain
 *
 * @param rpcUrl - RPC URL to connect to
 * @param chainId - Chain ID
 */
export function createProvider(rpcUrl: string, chainId: number): FallbackProvider {
  const provider = new JsonRpcProvider(rpcUrl, chainId, {
    staticNetwork: true,
  });

  // Create FallbackProvider with single provider
  return new FallbackProvider([provider], chainId);
}

/**
 * Create a PollingJsonRpcProvider for event listening
 *
 * This is required by the SDK for merkle tree event syncing.
 *
 * @param fallbackProvider - The fallback provider to wrap
 * @param chainId - Chain ID
 * @param pollingInterval - Polling interval in ms (default: 2000 for local devnet)
 */
export async function createPollingProvider(
  fallbackProvider: FallbackProvider,
  chainId: number,
  pollingInterval: number = 2000
): Promise<PollingJsonRpcProvider> {
  return createPollingJsonRpcProviderForListeners(
    fallbackProvider,
    chainId,
    pollingInterval
  );
}

// ============ Network Loading ============

/**
 * Load network into engine for merkle tree syncing
 *
 * This connects the engine to the deployed Railgun contracts
 * and begins syncing the merkle tree from on-chain events.
 *
 * Note: Our POC uses V2 contracts only, so V3 addresses are set to zero.
 *
 * @param chain - Chain configuration
 * @param railgunProxyAddress - Address of RailgunSmartWallet proxy
 * @param relayAdaptAddress - Address of RelayAdapt (optional, use zero for POC)
 * @param rpcUrl - RPC URL for the chain
 * @param deploymentBlock - Block number when contracts were deployed
 */
export async function loadNetworkIntoEngine(
  chain: Chain,
  railgunProxyAddress: string,
  relayAdaptAddress: string = ethers.ZeroAddress,
  rpcUrl: string,
  deploymentBlock: number = 0
): Promise<NetworkLoadResult> {
  const engine = getEngine();

  console.log(`Loading network for chain ${chain.type}:${chain.id}...`);
  console.log(`  Railgun proxy: ${railgunProxyAddress}`);
  console.log(`  RPC: ${rpcUrl}`);
  console.log(`  Deployment block: ${deploymentBlock}`);

  // Create providers
  const fallbackProvider = createProvider(rpcUrl, chain.id);
  const pollingProvider = await createPollingProvider(fallbackProvider, chain.id);

  // Deployment blocks for each TXID version
  const deploymentBlocks: Record<TXIDVersion, number> = {
    [TXIDVersion.V2_PoseidonMerkle]: deploymentBlock,
    [TXIDVersion.V3_PoseidonMerkle]: deploymentBlock, // Not used for V2-only
  };

  // Load network into engine
  // V3 addresses are set to zero since we're using V2 contracts only
  await engine.loadNetwork(
    chain,
    railgunProxyAddress,      // V2 RailgunSmartWallet proxy
    relayAdaptAddress,        // V2 RelayAdapt (optional)
    ethers.ZeroAddress,       // V3 PoseidonMerkleAccumulator (not used)
    ethers.ZeroAddress,       // V3 PoseidonMerkleVerifier (not used)
    ethers.ZeroAddress,       // V3 TokenVault (not used)
    fallbackProvider,
    pollingProvider,
    deploymentBlocks,
    undefined,                // POI launch block (not used)
    false                     // supportsV3 = false for V2-only
  );

  console.log(`  Network loaded successfully`);

  // Get fees from contract
  const { RailgunVersionedSmartContracts } = await import('@railgun-community/engine');
  const fees = await RailgunVersionedSmartContracts.fees(
    TXIDVersion.V2_PoseidonMerkle,
    chain
  );

  console.log(`  Shield fee: ${fees.shield} basis points`);
  console.log(`  Unshield fee: ${fees.unshield} basis points`);

  return {
    chain,
    railgunProxy: railgunProxyAddress,
    deploymentBlock,
    fees: {
      shield: fees.shield,
      unshield: fees.unshield,
    },
  };
}

/**
 * Load hub chain network from deployment file
 *
 * Convenience function for loading the hub chain using
 * the saved deployment info.
 */
export async function loadHubNetwork(): Promise<NetworkLoadResult> {
  const deployment = loadDeployment('railgun');

  if (deployment.chainId !== HUB_CHAIN.id) {
    throw new Error(
      `Deployment chain ID (${deployment.chainId}) doesn't match HUB_CHAIN (${HUB_CHAIN.id})`
    );
  }

  return loadNetworkIntoEngine(
    HUB_CHAIN,
    deployment.contracts.railgunProxy,
    ethers.ZeroAddress, // No RelayAdapt in our deployment
    HUB_RPC,
    DEPLOYMENT_BLOCK
  );
}

// ============ Merkle Tree Scanning ============

/**
 * Trigger a merkle tree scan for a chain
 *
 * This scans for on-chain commitment events and updates
 * the local merkle tree state.
 *
 * @param chain - Chain to scan
 */
export async function scanMerkletree(chain: Chain): Promise<void> {
  const engine = getEngine();

  console.log(`Scanning merkle tree for chain ${chain.type}:${chain.id}...`);

  // The engine automatically scans when network is loaded
  // For manual scanning, we can trigger a full rescan
  // walletIdFilter = undefined means scan all wallets
  await engine.fullRescanUTXOMerkletreesAndWallets(chain, undefined);

  console.log(`  Scan complete`);
}

/**
 * Get current merkle root from engine
 *
 * @param chain - Chain to get root for
 * @param treeNumber - Tree number (default: 0)
 */
export async function getMerkleRoot(
  chain: Chain,
  treeNumber: number = 0
): Promise<string | undefined> {
  const engine = getEngine();

  // Get the UTXO merkletree for this chain
  const merkletree = engine.getUTXOMerkletree(TXIDVersion.V2_PoseidonMerkle, chain);
  if (!merkletree) {
    return undefined;
  }

  const root = await merkletree.getRoot(treeNumber);
  return root;
}

/**
 * Get merkle proof for a commitment
 *
 * @param chain - Chain
 * @param treeNumber - Tree number
 * @param leafIndex - Leaf index in tree
 */
export async function getMerkleProof(
  chain: Chain,
  treeNumber: number,
  leafIndex: number
): Promise<{ root: string; elements: string[]; indices: string } | undefined> {
  const engine = getEngine();

  const merkletree = engine.getUTXOMerkletree(TXIDVersion.V2_PoseidonMerkle, chain);
  if (!merkletree) {
    return undefined;
  }

  const proof = await merkletree.getMerkleProof(treeNumber, leafIndex);
  return proof;
}

// ============ Balance Scanning ============

/**
 * Scan balances for a wallet on a chain
 *
 * This decrypts commitment events to find notes belonging
 * to the wallet and calculates spendable balance.
 *
 * @param walletId - Wallet ID
 * @param chain - Chain to scan
 */
export async function scanWalletBalances(
  walletId: string,
  chain: Chain
): Promise<void> {
  const engine = getEngine();

  console.log(`Scanning balances for wallet ${walletId.slice(0, 16)}...`);

  // Get wallet
  const wallet = engine.wallets[walletId];
  if (!wallet) {
    throw new Error(`Wallet not found: ${walletId}`);
  }

  // Trigger balance scan via full rescan
  // The wallet automatically scans when merkletree is loaded
  // Filter to only scan this wallet
  await engine.fullRescanUTXOMerkletreesAndWallets(chain, [walletId]);

  console.log(`  Balance scan complete`);
}

/**
 * Get token balances for a wallet
 *
 * Returns TokenBalances which is a map of tokenHash -> TreeBalance
 * where TreeBalance contains { balance: bigint, utxos: UTXO[] }
 *
 * @param walletId - Wallet ID
 * @param chain - Chain
 * @param onlySpendable - If true, only return spendable balances
 */
export async function getWalletBalances(
  walletId: string,
  chain: Chain,
  onlySpendable: boolean = false
): Promise<TokenBalances> {
  const engine = getEngine();

  const wallet = engine.wallets[walletId];
  if (!wallet) {
    throw new Error(`Wallet not found: ${walletId}`);
  }

  // Get balances from wallet
  const balances = await wallet.getTokenBalances(
    TXIDVersion.V2_PoseidonMerkle,
    chain,
    onlySpendable
  );

  return balances;
}
