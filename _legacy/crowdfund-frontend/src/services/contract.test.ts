// ABOUTME: Tests for contract factory functions.
// ABOUTME: Validates correct address binding and ABI selection based on network mode.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/config/network', () => ({
  isLocalMode: vi.fn(),
  POLL_INTERVAL_MS: 5000,
  NETWORK_CONFIG: { rpcUrl: 'http://localhost:8545', chainId: 31337, name: 'Local' },
}))

import { isLocalMode } from '@/config/network'
import { getCrowdfundContract, getUsdcContract, getArmContract } from './contract'
import type { CrowdfundDeployment } from '@/types/crowdfund'
import { JsonRpcProvider } from 'ethers'

const mockDeployment: CrowdfundDeployment = {
  chainId: 31337,
  deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  contracts: {
    crowdfund: '0x1111111111111111111111111111111111111111',
    usdc: '0x2222222222222222222222222222222222222222',
    armToken: '0x3333333333333333333333333333333333333333',
  },
  config: {
    baseSale: '1200000000000',
    maxSale: '1800000000000',
    minSale: '1000000000000',
    armPrice: '1000000',
    armFunded: '1800000000000000000000000',
  },
  timestamp: '2025-01-01T00:00:00Z',
}

// Use a dummy provider (not connected to a real node)
const mockProvider = new JsonRpcProvider('http://localhost:8545')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getCrowdfundContract', () => {
  it('creates a contract at the crowdfund address', () => {
    const contract = getCrowdfundContract(mockDeployment, mockProvider)
    expect(contract.target).toBe(mockDeployment.contracts.crowdfund)
  })

  it('includes known crowdfund functions in the ABI', () => {
    const contract = getCrowdfundContract(mockDeployment, mockProvider)
    expect(contract.interface.getFunction('finalize')).toBeTruthy()
    expect(contract.interface.getFunction('commit')).toBeTruthy()
  })
})

describe('getUsdcContract', () => {
  it('uses MOCK_USDC_ABI in local mode', () => {
    vi.mocked(isLocalMode).mockReturnValue(true)
    const contract = getUsdcContract(mockDeployment, mockProvider)

    expect(contract.target).toBe(mockDeployment.contracts.usdc)
    // Mock ABI includes the mint function
    expect(contract.interface.getFunction('mint')).toBeTruthy()
  })

  it('uses ERC20_ABI in non-local mode', () => {
    vi.mocked(isLocalMode).mockReturnValue(false)
    const contract = getUsdcContract(mockDeployment, mockProvider)

    expect(contract.target).toBe(mockDeployment.contracts.usdc)
    // Standard ERC20 does not have mint
    expect(contract.interface.getFunction('mint')).toBeNull()
  })

  it('always binds to the USDC address from deployment', () => {
    vi.mocked(isLocalMode).mockReturnValue(true)
    const contract = getUsdcContract(mockDeployment, mockProvider)
    expect(contract.target).toBe('0x2222222222222222222222222222222222222222')
  })
})

describe('getArmContract', () => {
  it('creates a contract at the armToken address', () => {
    const contract = getArmContract(mockDeployment, mockProvider)
    expect(contract.target).toBe(mockDeployment.contracts.armToken)
  })

  it('uses the ERC20 ABI', () => {
    const contract = getArmContract(mockDeployment, mockProvider)
    // Verify standard ERC20 functions exist
    expect(contract.interface.getFunction('balanceOf')).toBeTruthy()
    expect(contract.interface.getFunction('approve')).toBeTruthy()
  })
})
