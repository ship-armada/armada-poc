// ABOUTME: Loads crowdfund deployment addresses from the deployment JSON files.
// ABOUTME: Fetches from the Vite dev server plugin that serves ../deployments/.
import type { CrowdfundDeployment } from '@/types/crowdfund'
import { getDeploymentFileName } from './network'

let cachedDeployment: CrowdfundDeployment | null = null

export async function loadDeployment(): Promise<CrowdfundDeployment> {
  if (cachedDeployment) return cachedDeployment

  const fileName = getDeploymentFileName()
  const response = await fetch(`/api/deployments/${fileName}`)

  if (!response.ok) {
    throw new Error(
      `Deployment file not found: ${fileName}. Run 'npm run setup' (local) or 'npm run deploy:crowdfund:sepolia' (Sepolia) first.`
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
