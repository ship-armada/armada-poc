/**
 * Network Configuration
 *
 * Central module for all network-dependent values.
 * Reads VITE_NETWORK env var: 'local' (default) or 'sepolia'.
 *
 * Usage: VITE_NETWORK=sepolia npm run dev
 */

import { NetworkName } from '@railgun-community/shared-models'
import { ethers } from 'ethers'
import { getHookRouterFromDeployment } from './deployments'

export type NetworkMode = 'local' | 'sepolia'

const VITE_NETWORK = import.meta.env.VITE_NETWORK as string | undefined

export function getNetworkMode(): NetworkMode {
  if (VITE_NETWORK === 'sepolia') return 'sepolia'
  return 'local'
}

export function isSepoliaMode(): boolean {
  return getNetworkMode() === 'sepolia'
}

// ── Hub Chain ──

export function getHubChainId(): number {
  return isSepoliaMode() ? 11155111 : 31337
}

export function getHubRpcUrl(): string {
  return isSepoliaMode()
    ? ((import.meta.env.VITE_SEPOLIA_HUB_RPC as string) ||
        'https://ethereum-sepolia-rpc.publicnode.com')
    : 'http://localhost:8545'
}

export function getHubChainName(): string {
  return isSepoliaMode() ? 'Ethereum Sepolia' : 'Hub'
}

// ── Client Chains ──

export interface ClientChainDef {
  key: string
  name: string
  chainId: number
  rpcUrl: string
  cctpDomain: number
}

export function getClientChains(): ClientChainDef[] {
  if (isSepoliaMode()) {
    return [
      {
        key: 'client-a',
        name: 'Base Sepolia',
        chainId: 84532,
        rpcUrl:
          (import.meta.env.VITE_SEPOLIA_CLIENT_A_RPC as string) ||
          'https://base-sepolia-rpc.publicnode.com',
        cctpDomain: 6,
      },
      {
        key: 'client-b',
        name: 'Arbitrum Sepolia',
        chainId: 421614,
        rpcUrl:
          (import.meta.env.VITE_SEPOLIA_CLIENT_B_RPC as string) ||
          'https://arbitrum-sepolia-rpc.publicnode.com',
        cctpDomain: 3,
      },
    ]
  }
  return [
    {
      key: 'client-a',
      name: 'Client Chain A',
      chainId: 31338,
      rpcUrl: 'http://localhost:8546',
      cctpDomain: 101,
    },
    {
      key: 'client-b',
      name: 'Client Chain B',
      chainId: 31339,
      rpcUrl: 'http://localhost:8547',
      cctpDomain: 102,
    },
  ]
}

export function getClientRpcUrl(chainKey: string): string {
  const chain = getClientChains().find((c) => c.key === chainKey)
  if (!chain) throw new Error(`Unknown client chain key: ${chainKey}`)
  return chain.rpcUrl
}

// ── CCTP Domain Mapping ──

export function getHubCctpDomain(): number {
  return isSepoliaMode() ? 0 : 100
}

export function getChainToDomain(): Record<number, number> {
  if (isSepoliaMode()) {
    return {
      11155111: 0, // Ethereum Sepolia hub
      84532: 6, // Base Sepolia
      421614: 3, // Arbitrum Sepolia
    }
  }
  return {
    31337: 100,
    31338: 101,
    31339: 102,
  }
}

// ── Deployment File Names ──

export function getDeploymentFileName(baseName: string): string {
  if (isSepoliaMode()) {
    // 'hub-v3' -> 'hub-sepolia-v3', 'privacy-pool-hub' -> 'privacy-pool-hub-sepolia'
    const versionMatch = baseName.match(/^(.+)(-v\d+)$/)
    if (versionMatch) {
      return `${versionMatch[1]}-sepolia${versionMatch[2]}`
    }
    return `${baseName}-sepolia`
  }
  return baseName
}

// ── Railgun SDK Network ──
//
// IMPORTANT: Always use NetworkName.Hardhat regardless of mode.
// Using EthereumSepolia triggers the SDK's QuickSync service, which downloads
// ~4000+ historical commitments from the REAL Railgun Sepolia deployment.
// Those commitments don't match our POC contract's merkle tree, causing
// "Invalid merkleroot" errors. Hardhat has no QuickSync, so the SDK only
// scans events from our own PrivacyPool contract.
//
// To make networkForChain({type:0, id:11155111}) resolve correctly in Sepolia
// mode, we patch the Hardhat entry's chain.id in network.ts patchNetworkConfig().

export function getRailgunNetworkName(): NetworkName {
  return NetworkName.Hardhat
}

export function getRailgunNetworkNameString(): string {
  return 'Hardhat'
}

// ── CCTP Hook Router ──

export function getHookRouterAddress(destination: 'hub' | 'client' = 'hub'): string {
  return getHookRouterFromDeployment(destination) || ethers.ZeroAddress
}

// ── CCTP Finality Mode ──

/**
 * Whether CCTP fast finality mode is enabled.
 * When true, cross-chain operations use confirmed-level finality (~8-20s)
 * instead of finalized-level (~15-19 min), at a cost of 1-1.3 bps fee.
 */
export function isCCTPFastMode(): boolean {
  const mode = import.meta.env.VITE_CCTP_FINALITY_MODE as string | undefined
  if (mode === 'standard') return false
  // Default to fast in both local and sepolia modes
  return true
}

/**
 * Attestation polling timeout based on finality mode.
 * Fast mode: 3 minutes (attestation arrives in ~8-20 seconds).
 * Standard mode: 30 minutes (attestation arrives in ~15-19 minutes).
 */
export function getAttestationTimeoutMs(): number {
  return isCCTPFastMode() ? 180_000 : 1_800_000
}

/**
 * Relay detection timeout based on finality mode.
 * Fast mode: 3 minutes. Standard mode: 30 minutes.
 */
export function getRelayTimeoutMs(): number {
  return isCCTPFastMode() ? 180_000 : 1_800_000
}

// ── Relayer Config ──

export function getRelayerUrl(): string {
  return isSepoliaMode()
    ? ((import.meta.env.VITE_RELAYER_URL as string) || 'http://localhost:3001')
    : 'http://localhost:3001'
}

export function getRelayerAddress(): string {
  return isSepoliaMode()
    ? ((import.meta.env.VITE_RELAYER_ADDRESS as string) ||
        '0x98b1CBa0908C98c95c9C87D94e4fCdddc87C933d')
    : '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
}

export function getRelayerRailgunAddress(): string | undefined {
  if (isSepoliaMode()) {
    return (import.meta.env.VITE_RELAYER_RAILGUN_ADDRESS as string) || undefined
  }
  return '0zk1qyk9nn28x0u3rwn5pknglda68wrn7gw6anjw8gg94mcj6eq5u48tlrv7j6fe3z53lama02nutwtcqc979wnce0qwly4y7w4rls5cq040g7z8eagshxrw5ajy990'
}

// ── Chain List for UI ──

export function getAllDestinationChains(): {
  key: string
  chainId: number
  name: string
  isHub: boolean
}[] {
  const clients = getClientChains().map((c) => ({
    key: c.key,
    chainId: c.chainId,
    name: c.name,
    isHub: false,
  }))
  return [
    { key: 'hub', chainId: getHubChainId(), name: getHubChainName(), isHub: true },
    ...clients,
  ]
}

// ── Deployment Block ──
// Block at which our PrivacyPool was deployed. The SDK scans events starting
// from this block, so setting it correctly avoids scanning millions of empty blocks.

export function getDeploymentBlock(): number {
  return isSepoliaMode() ? 10321000 : 0
}

// ── Faucet ──

export function isFaucetEnabled(): boolean {
  return !isSepoliaMode()
}

// ── SDK polling interval ──

export function getSdkPollInterval(): number {
  return isSepoliaMode() ? 15000 : 2000
}
