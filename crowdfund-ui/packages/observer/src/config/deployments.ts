// ABOUTME: Loads crowdfund deployment addresses from deployment JSON files.
// ABOUTME: Fetches from the Vite dev server plugin that serves deployments/.

import { getDeploymentFileName } from './network'

export interface CrowdfundDeployment {
  chainId: number
  deployer: string
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
      `Deployment file not found: ${fileName}. Run 'npm run setup' (local) or 'npm run deploy:crowdfund:sepolia' (Sepolia) first.`,
    )
  }

  cachedDeployment = (await response.json()) as CrowdfundDeployment
  return cachedDeployment
}

export function getCachedDeployment(): CrowdfundDeployment | null {
  return cachedDeployment
}

export function clearDeploymentCache(): void {
  cachedDeployment = null
}
