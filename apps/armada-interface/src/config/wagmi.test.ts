// ABOUTME: Tests for buildTransports (P1-18) — a chain with multiple configured RPC URLs gets a viem `fallback` transport; a single-URL chain gets a plain `http` transport.

import { describe, it, expect, vi } from 'vitest'

// Stub getDefaultConfig so importing wagmi.ts doesn't spin up WalletConnect/RainbowKit on load.
vi.mock('@rainbow-me/rainbowkit', () => ({ getDefaultConfig: () => ({}) }))
// Pin network config so the module-load `getNetworkConfig()` is deterministic + side-effect-free.
vi.mock('./network', () => ({
  isLocalMode: () => true,
  getNetworkConfig: () => ({
    hub: { chainId: 31337, name: 'Hub', rpcUrls: ['http://primary', 'http://fallback'] },
    clients: [{ chainId: 31338, name: 'Client A', rpcUrls: ['http://only'] }],
  }),
}))

import { buildTransports } from './wagmi'
import type { Chain } from 'wagmi/chains'

const HUB = { id: 31337, name: 'Hub' } as unknown as Chain
const CLIENT = { id: 31338, name: 'Client A' } as unknown as Chain

/** Invoke a viem transport to read its discriminating `config.type`. */
function transportType(transport: ReturnType<typeof buildTransports>[number]): string {
  return transport({}).config.type
}

describe('buildTransports (P1-18)', () => {
  it('uses a fallback transport for a chain with multiple configured RPC URLs', () => {
    const transports = buildTransports(
      [HUB],
      [{ chainId: 31337, name: 'Hub', rpcUrls: ['http://primary', 'http://fallback'] }],
    )
    expect(transportType(transports[31337]!)).toBe('fallback')
  })

  it('uses a plain http transport for a chain with a single configured RPC URL', () => {
    const transports = buildTransports(
      [CLIENT],
      [{ chainId: 31338, name: 'Client A', rpcUrls: ['http://only'] }],
    )
    expect(transportType(transports[31338]!)).toBe('http')
  })

  it('builds exactly one transport per chain', () => {
    const transports = buildTransports([HUB, CLIENT], [
      { chainId: 31337, name: 'Hub', rpcUrls: ['http://primary', 'http://fallback'] },
      { chainId: 31338, name: 'Client A', rpcUrls: ['http://only'] },
    ])
    expect(Object.keys(transports).sort()).toEqual(['31337', '31338'])
  })
})
