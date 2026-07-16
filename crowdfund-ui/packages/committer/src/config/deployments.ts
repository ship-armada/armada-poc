// ABOUTME: Loads crowdfund deployment addresses from deployment JSON files.
// ABOUTME: Fetches from the Vite dev server plugin that serves deployments/.

import {
  getDeploymentFileName,
  getHubChainId,
  assertDeploymentChainId,
  assertExpectedAddress,
  getExpectedCrowdfundAddress,
} from './network'

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
  // Abort a hung request so deployment load can't freeze the flow indefinitely.
  const response = await fetch(`/api/deployments/${fileName}`, {
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error(
      `Deployment file not found: ${fileName}. Run 'npm run setup' from project root first.`,
    )
  }

  const deployment = (await response.json()) as CrowdfundDeployment
  // Fail loud if the manifest is for a different chain than this build targets —
  // otherwise we'd talk to one network's addresses while the wallet expects another.
  assertDeploymentChainId(deployment.chainId, getHubChainId(), fileName)

  // Verify the crowdfund address (the USDC approve/commit target) against a
  // trusted value supplied out-of-band via VITE_EXPECTED_CROWDFUND_ADDRESS.
  // Defends against a compromised/wrong manifest fetched from armada-deployments
  // redirecting every approval to an attacker address. Required on mainnet (see
  // validateEnv); on other networks it is checked only when the var is set.
  const expectedCrowdfund = getExpectedCrowdfundAddress()
  if (expectedCrowdfund) {
    assertExpectedAddress(
      deployment.contracts.crowdfund,
      expectedCrowdfund,
      'contracts.crowdfund',
      fileName,
    )
  }

  cachedDeployment = deployment
  return cachedDeployment
}

export function getCachedDeployment(): CrowdfundDeployment | null {
  return cachedDeployment
}
