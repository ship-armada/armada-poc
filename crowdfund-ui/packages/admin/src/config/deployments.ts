// ABOUTME: Loads crowdfund deployment addresses from deployment JSON files.
// ABOUTME: Fetches from the Vite dev server plugin that serves deployments/.

import { getDeploymentFileName, getHubChainId, assertDeploymentChainId } from './network'

export interface CrowdfundDeployment {
  chainId: number
  deployer: string
  deployBlock?: number
  contracts: {
    armToken: string
    usdc: string
    crowdfund: string
    treasury?: string
    governor?: string
  }
  config: {
    baseSale: string
    maxSale: string
    minSale: string
    armPrice: string
    armFunded: string
  }
  timestamp: string
}

let cachedDeployment: CrowdfundDeployment | null = null

export async function loadDeployment(): Promise<CrowdfundDeployment> {
  if (cachedDeployment) return cachedDeployment

  const fileName = getDeploymentFileName()
  const response = await fetch(`/api/deployments/${fileName}`)

  if (!response.ok) {
    throw new Error(
      `Deployment file not found: ${fileName}. Run 'npm run setup' from project root first.`,
    )
  }

  const deployment = (await response.json()) as CrowdfundDeployment
  // Fail loud if the manifest is for a different chain than this build targets —
  // otherwise we'd talk to one network's addresses while the wallet expects another.
  assertDeploymentChainId(deployment.chainId, getHubChainId(), fileName)

  cachedDeployment = deployment
  return cachedDeployment
}

export function getCachedDeployment(): CrowdfundDeployment | null {
  return cachedDeployment
}
