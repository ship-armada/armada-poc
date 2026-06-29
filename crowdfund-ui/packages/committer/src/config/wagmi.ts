// ABOUTME: wagmi + RainbowKit configuration for wallet connection.
// ABOUTME: Defines supported chains, RPC transports, and wallet connectors.

import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { http, fallback } from 'wagmi'
import { mainnet, sepolia, hardhat } from 'wagmi/chains'
import { getHubRpcUrls, getHubChainId, getNetworkMode } from './network'

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
// Register only the active hub chain so the wallet prompts to the right network.
const mode = getNetworkMode()
const hubChain = mode === 'local' ? anvilChain : mode === 'mainnet' ? mainnet : sepolia
const chains = [hubChain]
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
  // Use every configured RPC URL with ordered fallback so a single dead/throttled
  // endpoint doesn't break wallet reads — mirrors the events path's createProvider.
  transports: {
    [hubChainId]: fallback(rpcUrls.map((url) => http(url))),
  },
})
