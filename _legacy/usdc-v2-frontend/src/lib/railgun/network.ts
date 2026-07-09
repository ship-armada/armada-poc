/**
 * Network Loader for Railgun POC (Native CCTP Architecture)
 *
 * Always uses NetworkName.Hardhat from the SDK's built-in NETWORK_CONFIG.
 * In Sepolia mode, we patch the Hardhat entry's chain.id to 11155111 so
 * networkForChain() resolves correctly. We avoid using NetworkName.EthereumSepolia
 * because its QuickSync service downloads ~4000+ commitments from the real
 * Railgun deployment, which corrupts the merkle tree for our POC contract.
 *
 * The PrivacyPool contract serves as the Railgun proxy in this architecture.
 */

import { ethers } from 'ethers'
import { loadProvider } from '@railgun-community/wallet'
import { NETWORK_CONFIG } from '@railgun-community/shared-models'
import { loadDeployments, getHubChain, getYieldDeployment } from '@/config/deployments'
import {
  getDeploymentBlock,
  getHubChainId,
  getRailgunNetworkName,
  getRailgunNetworkNameString,
  getSdkPollInterval,
  isSepoliaMode,
} from '@/config/networkConfig'

// Track loaded networks
let hubNetworkLoaded = false
let networkConfigPatched = false

// Hub chain ID from network config (matches SDK's NETWORK_CONFIG)
const HUB_CHAIN_ID = getHubChainId()

// Store adapt contract address (ArmadaYieldAdapter) for yield flows / getHubChainConfig
let cachedRelayAdaptContract: string | undefined

function patchNetworkConfig(
  networkConfig: Record<string, unknown>,
  railgunProxy: string,
  relayAdaptContract?: string,
): boolean {
  const networkKey = getRailgunNetworkNameString()
  const targetNetwork = networkConfig?.[networkKey] as Record<string, unknown>
  if (!targetNetwork) return false

  targetNetwork.proxyContract = railgunProxy
  targetNetwork.relayAdaptContract = relayAdaptContract ?? ethers.ZeroAddress
  targetNetwork.relayAdaptHistory = relayAdaptContract ? [relayAdaptContract] : ['']
  targetNetwork.deploymentBlock = getDeploymentBlock()
  targetNetwork.poseidonMerkleAccumulatorV3Contract = ethers.ZeroAddress
  targetNetwork.poseidonMerkleVerifierV3Contract = ethers.ZeroAddress
  targetNetwork.tokenVaultV3Contract = ethers.ZeroAddress
  targetNetwork.deploymentBlockPoseidonMerkleAccumulatorV3 = 0
  targetNetwork.supportsV3 = false
  targetNetwork.poi = undefined

  // In Sepolia mode we use NetworkName.Hardhat (to avoid QuickSync pulling real
  // Railgun data) but patch its chain.id so the SDK's networkForChain() resolves
  // correctly for the actual Sepolia chain ID (11155111).
  //
  // We also MUST neutralize the real Ethereum_Sepolia entry by changing its
  // chain.id to something unused. Otherwise two NETWORK_CONFIG entries have
  // chain ID 11155111, and networkForChain() finds Ethereum_Sepolia first,
  // triggering its QuickSync and looking for a provider we never registered.
  if (isSepoliaMode()) {
    const hubChainId = getHubChainId()
    targetNetwork.chain = { type: 0, id: hubChainId }
    console.log(`[network] Patched Hardhat chain.id to ${hubChainId} for Sepolia mode`)

    // Neutralize the real Ethereum_Sepolia entry so it doesn't conflict
    const sepoliaEntry = networkConfig?.['Ethereum_Sepolia'] as Record<string, unknown> | undefined
    if (sepoliaEntry) {
      sepoliaEntry.chain = { type: 0, id: -1 }
      console.log('[network] Neutralized Ethereum_Sepolia entry to prevent QuickSync conflict')
    }
  }

  // Cache for getHubChainConfig
  cachedRelayAdaptContract = relayAdaptContract

  return true
}

async function patchNetworkConfigForHub(): Promise<void> {
  if (networkConfigPatched) return

  const hubChain = getHubChain()
  // In native CCTP architecture, PrivacyPool serves as the Railgun proxy
  const privacyPool = hubChain.contracts?.privacyPool
  // ArmadaYieldAdapter serves as adapt contract for lend/redeem (SDK relayAdaptContract field)
  const yieldDeployment = getYieldDeployment()
  const adaptContract = yieldDeployment?.contracts?.armadaYieldAdapter

  if (!privacyPool) {
    console.warn('[network] Missing privacyPool in hub deployment')
    return
  }

  const networkKey = getRailgunNetworkNameString()
  const patched = patchNetworkConfig(
    NETWORK_CONFIG as unknown as Record<string, unknown>,
    privacyPool,
    adaptContract,
  )

  networkConfigPatched = patched
  console.log(`[network] Patched ${networkKey} network config for POC deployment`)
  if (adaptContract) {
    console.log('[network] ArmadaYieldAdapter configured:', adaptContract)
  }

  // Debug: Verify the patch took effect
  const verifyNetwork = (NETWORK_CONFIG as Record<string, Record<string, unknown>>)[networkKey]
  console.log(`[network] Verification - NETWORK_CONFIG.${networkKey}.relayAdaptContract:`, verifyNetwork?.relayAdaptContract)
  console.log(`[network] Verification - NETWORK_CONFIG.${networkKey}.proxyContract:`, verifyNetwork?.proxyContract)
}

/**
 * Load the hub network using SDK's built-in network config
 *
 * Always uses NetworkName.Hardhat (with patched chain.id in Sepolia mode).
 */
export async function loadHubNetwork(): Promise<void> {
  if (hubNetworkLoaded) {
    console.log('[network] Hub network already loaded')
    return
  }

  // Ensure deployments are loaded
  await loadDeployments()
  const hubChain = getHubChain()
  await patchNetworkConfigForHub()
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

  const networkName = getRailgunNetworkName()
  const pollInterval = getSdkPollInterval()
  console.log(`[network] Loading hub network as ${getRailgunNetworkNameString()} (chain ID ${HUB_CHAIN_ID})`)
  console.log('[network] Connecting to RPC:', hubChain.rpcUrl)

  // Create fallback provider config for our hub chain
  // The SDK's loadProvider will handle creating the actual providers
  // Note: total weight must be >= 2 for fallback quorum
  const fallbackProviderConfig = {
    chainId: HUB_CHAIN_ID,
    providers: [
      {
        provider: hubChain.rpcUrl,
        priority: 1,
        weight: 2, // Weight >= 2 required for single provider
        maxLogsPerBatch: 10,
        stallTimeout: isSepoliaMode() ? 10000 : 2500,
      },
    ],
  }

  try {
    const result = await loadProvider(
      fallbackProviderConfig,
      networkName,
      pollInterval,
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
 * Get the hub chain configuration (using SDK-compatible chain ID)
 */
export function getHubChainConfig(): { type: number; id: number; relayAdaptContract?: string } {
  return { type: 0, id: HUB_CHAIN_ID, relayAdaptContract: cachedRelayAdaptContract }
}

/**
 * Check if hub network is loaded
 */
export function isHubNetworkLoaded(): boolean {
  return hubNetworkLoaded
}
