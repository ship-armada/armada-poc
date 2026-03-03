// ABOUTME: Creates ethers.js Contract instances for crowdfund, USDC, and ARM.
// ABOUTME: Handles both read-only (provider) and write (signer) connections.
import { Contract, type Provider, type Signer } from 'ethers'
import { CROWDFUND_ABI, ERC20_ABI, MOCK_USDC_ABI } from '@/config/abi'
import type { CrowdfundDeployment } from '@/types/crowdfund'
import { isLocalMode } from '@/config/network'

export function getCrowdfundContract(
  deployment: CrowdfundDeployment,
  signerOrProvider: Signer | Provider,
): Contract {
  return new Contract(deployment.contracts.crowdfund, CROWDFUND_ABI, signerOrProvider)
}

export function getUsdcContract(
  deployment: CrowdfundDeployment,
  signerOrProvider: Signer | Provider,
): Contract {
  const abi = isLocalMode() ? MOCK_USDC_ABI : ERC20_ABI
  return new Contract(deployment.contracts.usdc, abi, signerOrProvider)
}

export function getArmContract(
  deployment: CrowdfundDeployment,
  signerOrProvider: Signer | Provider,
): Contract {
  return new Contract(deployment.contracts.armToken, ERC20_ABI, signerOrProvider)
}
