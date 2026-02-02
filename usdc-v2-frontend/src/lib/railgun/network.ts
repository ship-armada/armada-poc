/**
 * Network Loader for Railgun POC (Native CCTP Architecture)
 *
 * Uses the SDK's built-in Hardhat network configuration (chain ID 31337)
 * but points to our hub chain's RPC endpoint. The PrivacyPool contract
 * serves as the Railgun proxy in this architecture.
 *
 * IMPORTANT: The Railgun SDK's balance callbacks only work for networks
 * defined in NETWORK_CONFIG (they use networkForChain() to look up the
 * network, which returns undefined for custom chain IDs). By using the
 * built-in Hardhat network, we get full SDK compatibility.
 */

import { ethers } from 'ethers'
import { loadProvider } from '@railgun-community/wallet'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { loadDeployments, getHubChain } from '@/config/deployments'

// Track loaded networks
let hubNetworkLoaded = false
let hardhatConfigPatched = false

// Hardhat network chain ID (must match SDK's NETWORK_CONFIG)
const HARDHAT_CHAIN_ID = 31337

// Store RelayAdapt address for getHubChainConfig
let cachedRelayAdaptContract: string | undefined

function patchNetworkConfig(
  networkConfig: Record<string, unknown>,
  railgunProxy: string,
  relayAdaptContract?: string,
): boolean {
  const hardhatNetwork =
    (networkConfig?.Hardhat as Record<string, unknown>) ??
    (networkConfig?.[NetworkName.Hardhat] as Record<string, unknown>)
  if (!hardhatNetwork) return false

  hardhatNetwork.proxyContract = railgunProxy
  hardhatNetwork.relayAdaptContract = relayAdaptContract ?? ethers.ZeroAddress
  hardhatNetwork.relayAdaptHistory = relayAdaptContract ? [relayAdaptContract] : ['']
  hardhatNetwork.deploymentBlock = 0
  hardhatNetwork.poseidonMerkleAccumulatorV3Contract = ethers.ZeroAddress
  hardhatNetwork.poseidonMerkleVerifierV3Contract = ethers.ZeroAddress
  hardhatNetwork.tokenVaultV3Contract = ethers.ZeroAddress
  hardhatNetwork.deploymentBlockPoseidonMerkleAccumulatorV3 = 0
  hardhatNetwork.supportsV3 = false
  hardhatNetwork.poi = undefined

  // Cache for getHubChainConfig
  cachedRelayAdaptContract = relayAdaptContract

  return true
}

async function patchHardhatConfig(): Promise<void> {
  if (hardhatConfigPatched) return

  const hubChain = getHubChain()
  // In native CCTP architecture, PrivacyPool serves as the Railgun proxy
  const privacyPool = hubChain.contracts?.privacyPool
  const relayAdapt = hubChain.contracts?.relayAdapt

  if (!privacyPool) {
    console.warn('[network] Missing privacyPool in hub deployment')
    return
  }

  const patchedPrimary = patchNetworkConfig(
    NETWORK_CONFIG as unknown as Record<string, unknown>,
    privacyPool,
    relayAdapt,
  )

  hardhatConfigPatched = patchedPrimary
  console.log('[network] Patched Hardhat network config for POC deployment')
  if (relayAdapt) {
    console.log('[network] RelayAdapt configured:', relayAdapt)
  }

  // Debug: Verify the patch took effect
  const verifyNetwork = (NETWORK_CONFIG as Record<string, Record<string, unknown>>)['Hardhat']
  console.log('[network] Verification - NETWORK_CONFIG.Hardhat.relayAdaptContract:', verifyNetwork?.relayAdaptContract)
  console.log('[network] Verification - NETWORK_CONFIG.Hardhat.proxyContract:', verifyNetwork?.proxyContract)
}

/**
 * Load the hub network using SDK's built-in Hardhat network config
 *
 * This uses the Railgun SDK's loadProvider with NetworkName.Hardhat.
 * The SDK has hardcoded contract addresses for Hardhat that match our deployment.
 */
export async function loadHubNetwork(): Promise<void> {
  if (hubNetworkLoaded) {
    console.log('[network] Hub network already loaded')
    return
  }

  // Ensure deployments are loaded
  await loadDeployments()
  const hubChain = getHubChain()
  await patchHardhatConfig()
  // In native CCTP architecture, PrivacyPool serves as the Railgun proxy
  const privacyPool = hubChain.contracts?.privacyPool

  if (!privacyPool) {
    throw new Error('[network] Missing privacyPool in hub deployment')
  }

  const provider = new ethers.JsonRpcProvider(hubChain.rpcUrl)
  const code = await provider.getCode(privacyPool)
  if (!code || code === '0x') {
    throw new Error(
      `[network] No PrivacyPool code at ${privacyPool} on ${hubChain.rpcUrl}. ` +
        'Ensure the hub chain is running the POC deployment.',
    )
  }

  try {
    // PrivacyPool diagnostics - check shield fee
    const privacyPoolContract = new ethers.Contract(
      privacyPool,
      ['function shieldFee() view returns (uint120)'],
      provider,
    )
    const shieldFee = await privacyPoolContract.shieldFee()
    console.log('[network] PrivacyPool shieldFee()', shieldFee.toString())
  } catch (error) {
    console.warn('[network] Failed to read PrivacyPool diagnostics', error)
  }

  console.log('[network] Loading hub network as Hardhat (chain ID 31337)')
  console.log('[network] Connecting to RPC:', hubChain.rpcUrl)

  // Create fallback provider config for our hub chain
  // The SDK's loadProvider will handle creating the actual providers
  // Note: total weight must be >= 2 for fallback quorum
  const fallbackProviderConfig = {
    chainId: HARDHAT_CHAIN_ID, // Must be 31337 for Hardhat
    providers: [
      {
        provider: hubChain.rpcUrl,
        priority: 1,
        weight: 2, // Weight >= 2 required for single provider
        maxLogsPerBatch: 10,
        stallTimeout: 2500,
      },
    ],
  }

  try {
    const result = await loadProvider(
      fallbackProviderConfig,
      NetworkName.Hardhat,
      2000, // Poll every 2 seconds for local dev
    )

    console.log('[network] Hub network loaded successfully')
    console.log('[network] Fees:', result.feesSerialized)

    hubNetworkLoaded = true
  } catch (error) {
    console.error('[network] Failed to load hub network:', error)
    throw error
  }
}

/**
 * Get the hub chain configuration (using Hardhat chain ID for SDK compatibility)
 */
export function getHubChainConfig(): { type: number; id: number; relayAdaptContract?: string } {
  return { type: 0, id: HARDHAT_CHAIN_ID, relayAdaptContract: cachedRelayAdaptContract }
}

/**
 * Check if hub network is loaded
 */
export function isHubNetworkLoaded(): boolean {
  return hubNetworkLoaded
}
