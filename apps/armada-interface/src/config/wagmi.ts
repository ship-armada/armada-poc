// ABOUTME: wagmi + RainbowKit configuration — multi-chain (hub + clients) derived from network.ts.
// ABOUTME: Local mode registers Anvil chains; sepolia mode registers Sepolia + Base/Arb Sepolia.

import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { fallback, http } from 'viem'
import type { Transport } from 'viem'
import { sepolia, baseSepolia, arbitrumSepolia, hardhat } from 'wagmi/chains'
import type { Chain } from 'wagmi/chains'
import { getNetworkConfig, isLocalMode, type ChainIdentity } from './network'

const ANVIL_HUB: Chain = {
  ...hardhat,
  id: 31337,
  name: 'Anvil Hub',
  rpcUrls: { default: { http: ['http://localhost:8545'] } },
}

const ANVIL_CLIENT_A: Chain = {
  ...hardhat,
  id: 31338,
  name: 'Anvil Client A',
  rpcUrls: { default: { http: ['http://localhost:8546'] } },
}

const ANVIL_CLIENT_B: Chain = {
  ...hardhat,
  id: 31339,
  name: 'Anvil Client B',
  rpcUrls: { default: { http: ['http://localhost:8547'] } },
}

function resolveChainsForMode(): readonly [Chain, ...Chain[]] {
  if (isLocalMode()) return [ANVIL_HUB, ANVIL_CLIENT_A, ANVIL_CLIENT_B]
  return [sepolia, baseSepolia, arbitrumSepolia]
}

// Exported for unit tests (single vs fallback transport selection). App code uses `wagmiConfig`.
export function buildTransports(chains: readonly Chain[], chainIdentities: readonly ChainIdentity[]) {
  const transports: Record<number, Transport> = {}
  for (const chain of chains) {
    const identity = chainIdentities.find(c => c.chainId === chain.id)
    const urls = identity?.rpcUrls ?? []
    // Each URL gets a 15s timeout so a black-holed endpoint fails over promptly instead of
    // hanging on viem's default. With ≥2 configured URLs, `fallback` rotates to the next on
    // error (P1-18). Single-URL chains (all of local; sepolia without VITE_SEPOLIA_RPC_FALLBACK)
    // keep single-transport behavior. No identity → viem's default public RPC for the chain.
    if (urls.length === 0) {
      transports[chain.id] = http()
    } else if (urls.length === 1) {
      transports[chain.id] = http(urls[0], { timeout: 15_000 })
    } else {
      transports[chain.id] = fallback(urls.map(u => http(u, { timeout: 15_000 })))
    }
  }
  return transports
}

const chains = resolveChainsForMode()
const cfg = getNetworkConfig()

export const wagmiConfig = getDefaultConfig({
  appName: 'Armada',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'armada-dev-placeholder',
  chains: chains as unknown as readonly [Chain, ...Chain[]],
  transports: buildTransports(chains, [cfg.hub, ...cfg.clients]),
  ssr: false,
})
