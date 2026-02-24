/**
 * Deployment Configuration Loader
 *
 * Loads deployment information for hub and client chains from JSON files.
 * Used to get contract addresses for PrivacyPool, MockUSDC, etc.
 */

// ============ Types ============

export interface ContractDeployment {
  privacyPool?: string
  privacyPoolClient?: string
  mockUSDC?: string
  faucet?: string
  usdc?: string
  messageTransmitter?: string
  tokenMessenger?: string
  armadaYieldAdapter?: string
}

export interface ChainConfig {
  id: number
  name: string
  rpcUrl: string
  contracts?: ContractDeployment
}

export interface HubDeployment {
  chainId: number
  contracts: {
    privacyPool?: string
    merkleModule?: string
    verifierModule?: string
    shieldModule?: string
    transactModule?: string
  }
  cctp?: {
    usdc?: string
    messageTransmitter?: string
    tokenMessenger?: string
  }
}

export interface CCTPDeployment {
  chainId: number
  domain: number
  contracts: {
    usdc: string
    messageTransmitter: string
    tokenMessenger: string
    faucet?: string
  }
}

export interface YieldDeployment {
  chainId: number
  deployer: string
  contracts: {
    armadaTreasury: string
    armadaYieldVault: string
    armadaYieldAdapter: string
  }
  config: {
    usdc: string
    mockAaveSpoke: string
    reserveId: number
    yieldFeeBps: number
  }
  timestamp: string
}

export interface AaveDeployment {
  chainId: number
  contracts: {
    mockAaveSpoke: string
  }
  reserves: {
    usdc: {
      reserveId: number
      underlyingAsset: string
      apyBps: number
    }
  }
}

export interface ClientDeployment {
  chainId: number
  domain: number
  contracts: {
    privacyPoolClient: string
  }
  cctp?: {
    usdc?: string
    messageTransmitter?: string
    tokenMessenger?: string
  }
  hub?: {
    domain: number
    privacyPool: string
  }
}

import {
  getHubChainId,
  getHubRpcUrl,
  getHubChainName,
  getClientChains,
  getDeploymentFileName,
} from './networkConfig'

// ============ State ============

let deploymentsLoaded = false
let hubDeployment: HubDeployment | null = null
let hubCCTPDeployment: CCTPDeployment | null = null
let yieldDeployment: YieldDeployment | null = null
let aaveDeployment: AaveDeployment | null = null
let clientDeployments: Map<string, ClientDeployment> = new Map()
let clientCCTPDeployments: Map<string, CCTPDeployment> = new Map()

// ============ Loading Functions ============

// Client chain keys to load
const CLIENT_CHAIN_KEYS = ['client-a', 'client-b']

/**
 * Load deployment files from the API
 */
export async function loadDeployments(): Promise<void> {
  if (deploymentsLoaded) {
    return
  }

  console.log('[deployments] Loading deployment files...')

  try {
    // Load privacy pool hub deployment
    const hubRes = await fetch(`/api/deployments/${getDeploymentFileName('privacy-pool-hub')}.json`)
    if (hubRes.ok) {
      hubDeployment = await hubRes.json()
      console.log('[deployments] Loaded privacy-pool-hub.json')
    } else {
      console.warn('[deployments] privacy-pool-hub.json not found')
    }

    // Load hub CCTP deployment (for USDC address)
    const hubCCTPRes = await fetch(`/api/deployments/${getDeploymentFileName('hub-v3')}.json`)
    if (hubCCTPRes.ok) {
      hubCCTPDeployment = await hubCCTPRes.json()
      console.log('[deployments] Loaded hub-v3.json')
    } else {
      console.warn('[deployments] hub-v3.json not found')
    }

    // Load yield deployment (for yield vault, adapter, treasury)
    const yieldRes = await fetch(`/api/deployments/${getDeploymentFileName('yield-hub')}.json`)
    if (yieldRes.ok) {
      yieldDeployment = await yieldRes.json()
      console.log('[deployments] Loaded yield-hub.json')
    } else {
      console.warn('[deployments] yield-hub.json not found')
    }

    // Load Aave mock deployment (for MockAaveSpoke)
    const aaveRes = await fetch(`/api/deployments/${getDeploymentFileName('aave-mock-hub')}.json`)
    if (aaveRes.ok) {
      aaveDeployment = await aaveRes.json()
      console.log('[deployments] Loaded aave-mock-hub.json')
    } else {
      console.warn('[deployments] aave-mock-hub.json not found')
    }

    // Load client chain deployments
    for (const chainKey of CLIENT_CHAIN_KEYS) {
      // Determine deployment file name based on chain key
      const privacyPoolBase = chainKey === 'client-a'
        ? 'privacy-pool-client'
        : 'privacy-pool-clientB'
      const cctpBase = chainKey === 'client-a'
        ? 'client-v3'
        : 'clientB-v3'
      const privacyPoolFile = `${getDeploymentFileName(privacyPoolBase)}.json`
      const cctpFile = `${getDeploymentFileName(cctpBase)}.json`

      // Load privacy pool client deployment
      const clientRes = await fetch(`/api/deployments/${privacyPoolFile}`)
      if (clientRes.ok) {
        const deployment = await clientRes.json()
        clientDeployments.set(chainKey, deployment)
        console.log(`[deployments] Loaded ${privacyPoolFile}`)
      } else {
        console.warn(`[deployments] ${privacyPoolFile} not found`)
      }

      // Load client CCTP deployment
      const clientCCTPRes = await fetch(`/api/deployments/${cctpFile}`)
      if (clientCCTPRes.ok) {
        const deployment = await clientCCTPRes.json()
        clientCCTPDeployments.set(chainKey, deployment)
        console.log(`[deployments] Loaded ${cctpFile}`)
      } else {
        console.warn(`[deployments] ${cctpFile} not found`)
      }
    }

    deploymentsLoaded = true
    console.log('[deployments] Deployments loaded successfully')
  } catch (error) {
    console.error('[deployments] Failed to load deployments:', error)
    throw error
  }
}

/**
 * Get hub chain configuration
 */
export function getHubChain(): ChainConfig {
  // Default hub chain config
  const config: ChainConfig = {
    id: getHubChainId(),
    name: getHubChainName(),
    rpcUrl: getHubRpcUrl(),
    contracts: {},
  }

  // Add PrivacyPool from hub deployment
  if (hubDeployment?.contracts?.privacyPool) {
    config.contracts!.privacyPool = hubDeployment.contracts.privacyPool
  }
  // Add ArmadaYieldAdapter from yield deployment
  if (yieldDeployment?.contracts?.armadaYieldAdapter) {
    config.contracts!.armadaYieldAdapter = yieldDeployment.contracts.armadaYieldAdapter
  }

  // Add USDC/CCTP contracts from hub-v3 deployment
  if (hubCCTPDeployment?.contracts) {
    config.contracts!.mockUSDC = hubCCTPDeployment.contracts.usdc
    config.contracts!.usdc = hubCCTPDeployment.contracts.usdc
    config.contracts!.messageTransmitter =
      hubCCTPDeployment.contracts.messageTransmitter
    config.contracts!.tokenMessenger =
      hubCCTPDeployment.contracts.tokenMessenger
    config.contracts!.faucet = hubCCTPDeployment.contracts.faucet
  }

  return config
}

/**
 * Check if deployments are loaded
 */
export function areDeploymentsLoaded(): boolean {
  return deploymentsLoaded
}

/**
 * Get raw hub deployment
 */
export function getHubDeployment(): HubDeployment | null {
  return hubDeployment
}

/**
 * Get raw hub CCTP deployment
 */
export function getHubCCTPDeployment(): CCTPDeployment | null {
  return hubCCTPDeployment
}

/**
 * Get client chain configuration by key
 */
export function getClientChain(chainKey: string): ChainConfig | null {
  const deployment = clientDeployments.get(chainKey)
  const cctpDeployment = clientCCTPDeployments.get(chainKey)

  if (!deployment) {
    return null
  }

  // Look up RPC URL and name from network config
  const clientChainDef = getClientChains().find((c) => c.key === chainKey)

  const config: ChainConfig = {
    id: deployment.chainId,
    name: clientChainDef?.name || (chainKey === 'client-a' ? 'Client Chain A' : 'Client Chain B'),
    rpcUrl: clientChainDef?.rpcUrl || 'http://localhost:8546',
    contracts: {
      privacyPoolClient: deployment.contracts.privacyPoolClient,
    },
  }

  // Add USDC from CCTP deployment or client deployment
  if (cctpDeployment?.contracts) {
    config.contracts!.usdc = cctpDeployment.contracts.usdc
    config.contracts!.mockUSDC = cctpDeployment.contracts.usdc
    config.contracts!.messageTransmitter = cctpDeployment.contracts.messageTransmitter
    config.contracts!.tokenMessenger = cctpDeployment.contracts.tokenMessenger
    config.contracts!.faucet = cctpDeployment.contracts.faucet
  } else if (deployment.cctp) {
    config.contracts!.usdc = deployment.cctp.usdc
    config.contracts!.mockUSDC = deployment.cctp.usdc
    config.contracts!.messageTransmitter = deployment.cctp.messageTransmitter
    config.contracts!.tokenMessenger = deployment.cctp.tokenMessenger
  }

  return config
}

/**
 * Get chain configuration by key (hub or client)
 */
export function getChainByKey(chainKey: string): ChainConfig | null {
  if (chainKey === 'hub') {
    return getHubChain()
  }
  return getClientChain(chainKey)
}

/**
 * Check if a chain key is the hub chain
 */
export function isHubChain(chainKey: string): boolean {
  return chainKey === 'hub'
}

/**
 * Get the raw client deployment
 */
export function getClientDeployment(chainKey: string): ClientDeployment | null {
  return clientDeployments.get(chainKey) || null
}

/**
 * Get yield deployment
 */
export function getYieldDeployment(): YieldDeployment | null {
  return yieldDeployment
}

/**
 * Get Aave deployment
 */
export function getAaveDeployment(): AaveDeployment | null {
  return aaveDeployment
}
