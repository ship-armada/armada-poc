// ABOUTME: Network configuration for the governance test UI.
// ABOUTME: Handles local vs sepolia mode, RPC URLs, and deployment file resolution.

export type NetworkMode = 'local' | 'sepolia'

const VITE_NETWORK = import.meta.env.VITE_NETWORK as string | undefined

export function getNetworkMode(): NetworkMode {
  if (VITE_NETWORK === 'sepolia') return 'sepolia'
  return 'local'
}

export function isSepoliaMode(): boolean {
  return getNetworkMode() === 'sepolia'
}

export function getHubRpcUrl(): string {
  return isSepoliaMode()
    ? ((import.meta.env.VITE_SEPOLIA_HUB_RPC as string) ||
        'https://ethereum-sepolia-rpc.publicnode.com')
    : 'http://localhost:8545'
}

export function getHubChainId(): number {
  return isSepoliaMode() ? 11155111 : 31337
}

/**
 * Get the deployment file name with correct suffix for the current network mode.
 * Local: baseName as-is (e.g. 'governance-hub')
 * Sepolia: baseName + '-sepolia' (e.g. 'governance-hub-sepolia')
 * Handles versioned names like 'hub-v3' -> 'hub-sepolia-v3'
 */
export function getDeploymentFileName(baseName: string): string {
  if (isSepoliaMode()) {
    const versionMatch = baseName.match(/^(.+)(-v\d+)$/)
    if (versionMatch) {
      return `${versionMatch[1]}-sepolia${versionMatch[2]}`
    }
    return `${baseName}-sepolia`
  }
  return baseName
}

export interface GovernanceDeployment {
  chainId: number
  deployer: string
  contracts: {
    armToken: string
    votingLocker: string
    timelockController: string
    treasury: string
    governor: string
    steward: string
  }
  config: {
    timelockMinDelay: number
    stewardActionDelay: number
    totalSupply: string
    treasuryAllocation: string
  }
  timestamp: string
}

export interface HubDeployment {
  usdc: string
  [key: string]: unknown
}

/**
 * Fetch the governance deployment manifest for the current network.
 */
export async function fetchGovernanceDeployment(): Promise<GovernanceDeployment> {
  const fileName = getDeploymentFileName('governance-hub')
  const res = await fetch(`/api/deployments/${fileName}.json`)
  if (!res.ok) {
    throw new Error(
      `Failed to load governance deployment (${fileName}.json). ` +
      'Make sure contracts are deployed: npm run setup'
    )
  }
  return res.json()
}

/**
 * Fetch the USDC address from the hub CCTP deployment.
 */
export async function fetchUsdcAddress(): Promise<string> {
  const data = await fetchHubDeployment()
  return data.usdc || data.contracts?.usdc || data.contracts?.mockUSDC || ''
}

/**
 * Fetch the Faucet address from the hub CCTP deployment (local mode only).
 */
export async function fetchFaucetAddress(): Promise<string> {
  const data = await fetchHubDeployment()
  return data.contracts?.faucet || ''
}

/**
 * Fetch the hub CCTP deployment manifest.
 */
async function fetchHubDeployment(): Promise<Record<string, any>> {
  const fileName = getDeploymentFileName('hub-v3')
  const res = await fetch(`/api/deployments/${fileName}.json`)
  if (!res.ok) {
    throw new Error(
      `Failed to load hub deployment (${fileName}.json).`
    )
  }
  return res.json()
}
