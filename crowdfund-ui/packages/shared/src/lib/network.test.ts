// ABOUTME: Tests for the shared network resolvers — mode, chain id, RPC, explorer,
// ABOUTME: indexer, manifest path across local / sepolia / mainnet and env precedence.

import { describe, it, expect } from 'vitest'
import {
  resolveNetworkMode,
  isLocalNetwork,
  chainIdForMode,
  networkLabelForChainId,
  resolveHubRpcUrls,
  resolveIndexerUrl,
  resolveDeploymentFileName,
  pollIntervalForMode,
  maxBlockRangeForMode,
  explorerUrlForMode,
  type NetworkEnv,
} from './network.js'

describe('resolveNetworkMode', () => {
  it('honours explicit VITE_NETWORK', () => {
    expect(resolveNetworkMode({ VITE_NETWORK: 'mainnet' })).toBe('mainnet')
    expect(resolveNetworkMode({ VITE_NETWORK: 'sepolia' })).toBe('sepolia')
    expect(resolveNetworkMode({ VITE_NETWORK: 'local' })).toBe('local')
  })

  it('trims whitespace around the value', () => {
    expect(resolveNetworkMode({ VITE_NETWORK: '  mainnet  ' })).toBe('mainnet')
  })

  it('defaults to local in dev when unset', () => {
    expect(resolveNetworkMode({})).toBe('local')
    expect(resolveNetworkMode({ PROD: false })).toBe('local')
    expect(resolveNetworkMode({ VITE_NETWORK: '   ' })).toBe('local')
  })

  it('defaults to sepolia in PROD when unset — never local, never mainnet', () => {
    expect(resolveNetworkMode({ PROD: true })).toBe('sepolia')
    expect(resolveNetworkMode({ PROD: true, VITE_NETWORK: '' })).toBe('sepolia')
  })

  it('treats an unrecognised value as unset (falls through to the default)', () => {
    expect(resolveNetworkMode({ VITE_NETWORK: 'goerli' })).toBe('local')
    expect(resolveNetworkMode({ VITE_NETWORK: 'goerli', PROD: true })).toBe('sepolia')
  })
})

describe('chainIdForMode / isLocalNetwork', () => {
  it('maps each mode to its chain id', () => {
    expect(chainIdForMode('local')).toBe(31337)
    expect(chainIdForMode('sepolia')).toBe(11155111)
    expect(chainIdForMode('mainnet')).toBe(1)
  })

  it('identifies local', () => {
    expect(isLocalNetwork('local')).toBe(true)
    expect(isLocalNetwork('sepolia')).toBe(false)
    expect(isLocalNetwork('mainnet')).toBe(false)
  })
})

describe('networkLabelForChainId', () => {
  it('labels known chains', () => {
    expect(networkLabelForChainId(1)).toBe('Ethereum')
    expect(networkLabelForChainId(11155111)).toBe('Sepolia')
    expect(networkLabelForChainId(31337)).toBe('the local network')
  })

  it('falls back for unknown chains', () => {
    expect(networkLabelForChainId(8453)).toBe('the correct network')
  })
})

describe('resolveHubRpcUrls', () => {
  it('returns localhost for local mode', () => {
    expect(resolveHubRpcUrls({ VITE_NETWORK: 'local' })).toEqual(['http://localhost:8545'])
  })

  it('prefers VITE_HUB_RPC and appends the fallback when present', () => {
    const env: NetworkEnv = {
      VITE_NETWORK: 'mainnet',
      VITE_HUB_RPC: 'https://primary.example',
      VITE_HUB_RPC_FALLBACK: 'https://fallback.example',
    }
    expect(resolveHubRpcUrls(env)).toEqual(['https://primary.example', 'https://fallback.example'])
  })

  it('omits the fallback when only the primary is set', () => {
    expect(resolveHubRpcUrls({ VITE_NETWORK: 'mainnet', VITE_HUB_RPC: 'https://primary.example' }))
      .toEqual(['https://primary.example'])
  })

  it('falls back to the legacy VITE_SEPOLIA_RPC names in sepolia mode', () => {
    const env: NetworkEnv = {
      VITE_NETWORK: 'sepolia',
      VITE_SEPOLIA_RPC: 'https://legacy-primary.example',
      VITE_SEPOLIA_RPC_FALLBACK: 'https://legacy-fallback.example',
    }
    expect(resolveHubRpcUrls(env)).toEqual([
      'https://legacy-primary.example',
      'https://legacy-fallback.example',
    ])
  })

  it('lets VITE_HUB_RPC win over the legacy name in sepolia mode', () => {
    const env: NetworkEnv = {
      VITE_NETWORK: 'sepolia',
      VITE_HUB_RPC: 'https://new.example',
      VITE_SEPOLIA_RPC: 'https://legacy.example',
    }
    expect(resolveHubRpcUrls(env)).toEqual(['https://new.example'])
  })

  it('does NOT read the legacy sepolia name on mainnet (wrong-chain guard)', () => {
    const env: NetworkEnv = { VITE_NETWORK: 'mainnet', VITE_SEPOLIA_RPC: 'https://sepolia.example' }
    // Falls through to the mainnet default, never the sepolia URL.
    expect(resolveHubRpcUrls(env)).toEqual(['https://ethereum-rpc.publicnode.com'])
  })

  it('uses the per-network public default when no env URL is set', () => {
    expect(resolveHubRpcUrls({ VITE_NETWORK: 'sepolia' }))
      .toEqual(['https://ethereum-sepolia-rpc.publicnode.com'])
    expect(resolveHubRpcUrls({ VITE_NETWORK: 'mainnet' }))
      .toEqual(['https://ethereum-rpc.publicnode.com'])
  })
})

describe('resolveIndexerUrl', () => {
  it('is null in local mode regardless of env', () => {
    expect(resolveIndexerUrl({ VITE_NETWORK: 'local', VITE_CROWDFUND_INDEXER_URL: 'https://x' }))
      .toBeNull()
  })

  it('returns the configured URL on non-local networks, else null', () => {
    expect(resolveIndexerUrl({ VITE_NETWORK: 'mainnet', VITE_CROWDFUND_INDEXER_URL: 'https://api' }))
      .toBe('https://api')
    expect(resolveIndexerUrl({ VITE_NETWORK: 'mainnet' })).toBeNull()
  })
})

describe('resolveDeploymentFileName', () => {
  it('uses the unsuffixed file in local mode', () => {
    expect(resolveDeploymentFileName({ VITE_NETWORK: 'local' })).toBe('crowdfund-hub.json')
  })

  it('builds an instance path scoped by mode when an instance is set', () => {
    expect(resolveDeploymentFileName({ VITE_NETWORK: 'mainnet', VITE_DEPLOYMENT_INSTANCE: 'launch1' }))
      .toBe('instances/launch1/mainnet/crowdfund.json')
    expect(resolveDeploymentFileName({ VITE_NETWORK: 'sepolia', VITE_DEPLOYMENT_INSTANCE: 'medi2' }))
      .toBe('instances/medi2/sepolia/crowdfund.json')
  })

  it('trims the instance name', () => {
    expect(resolveDeploymentFileName({ VITE_NETWORK: 'mainnet', VITE_DEPLOYMENT_INSTANCE: '  launch1  ' }))
      .toBe('instances/launch1/mainnet/crowdfund.json')
  })

  it('falls back to the legacy per-mode file when no instance is set', () => {
    expect(resolveDeploymentFileName({ VITE_NETWORK: 'sepolia' })).toBe('crowdfund-hub-sepolia.json')
    expect(resolveDeploymentFileName({ VITE_NETWORK: 'mainnet' })).toBe('crowdfund-hub-mainnet.json')
  })
})

describe('poll interval / block range / explorer', () => {
  it('polls faster on local than on live networks', () => {
    expect(pollIntervalForMode('local')).toBe(5_000)
    expect(pollIntervalForMode('sepolia')).toBe(15_000)
    expect(pollIntervalForMode('mainnet')).toBe(15_000)
  })

  it('uses a small block range locally and a wide one on live networks', () => {
    expect(maxBlockRangeForMode('local')).toBe(10)
    expect(maxBlockRangeForMode('mainnet')).toBe(2_000)
  })

  it('maps each mode to its explorer (none for local)', () => {
    expect(explorerUrlForMode('mainnet')).toBe('https://etherscan.io')
    expect(explorerUrlForMode('sepolia')).toBe('https://sepolia.etherscan.io')
    expect(explorerUrlForMode('local')).toBeUndefined()
  })
})
