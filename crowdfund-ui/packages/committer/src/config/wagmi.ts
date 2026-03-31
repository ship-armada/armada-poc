// ABOUTME: wagmi + RainbowKit configuration for wallet connection.
// ABOUTME: Defines supported chains, RPC transports, and wallet connectors.

import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { http } from 'wagmi'
import { sepolia, hardhat } from 'wagmi/chains'
import { getHubRpcUrls, getHubChainId, isLocalMode } from './network'

// Define the local Anvil chain — uses wagmi's hardhat chain as a base,
// but overrides the RPC URL to match our local config.
const anvilChain = {
  ...hardhat,
  id: 31337 as const,
  name: 'Anvil (Local)',
  rpcUrls: {
    default: { http: ['http://localhost:8545'] },
  },
} as const

const hubChainId = getHubChainId()
const chains = isLocalMode() ? [anvilChain] : [sepolia]
const rpcUrls = getHubRpcUrls()

export const wagmiConfig = getDefaultConfig({
  appName: 'Armada Crowdfund',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'armada-dev-placeholder',
  chains: chains as any,
  transports: {
    [hubChainId]: http(rpcUrls[0]),
  },
})
