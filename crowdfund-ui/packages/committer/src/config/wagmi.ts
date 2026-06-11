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

// In dev, fall back to a placeholder project id so the app boots without a
// real WalletConnect id. In PROD we never ship the placeholder (it silently
// breaks WalletConnect) — startup validateEnv() hard-fails a build that is
// missing VITE_WALLETCONNECT_PROJECT_ID before this config is ever used.
const walletConnectProjectId =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ||
  (import.meta.env.PROD ? '' : 'armada-dev-placeholder')

export const wagmiConfig = getDefaultConfig({
  appName: 'Armada Crowdfund',
  projectId: walletConnectProjectId,
  chains: chains as any,
  transports: {
    [hubChainId]: http(rpcUrls[0]),
  },
})
