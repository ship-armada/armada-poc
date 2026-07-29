// ABOUTME: Network configuration for armada-interface — hub + client chain identities, RPC URLs, indexer/relayer/Iris endpoints.
// ABOUTME: Driven by VITE_NETWORK env var (local | sepolia). All multi-chain config flows from here.

export type NetworkMode = 'local' | 'sepolia'

export interface ChainIdentity {
  readonly chainId: number
  /** CCTP domain id (0 = Ethereum, 6 = Base, etc.). */
  readonly domain: number
  readonly name: string
  /** Ordered RPC URLs — first is primary, rest are fallbacks. */
  readonly rpcUrls: readonly string[]
  /** Block explorer base URL. Undefined for local Anvil. */
  readonly explorerUrl?: string
}

export interface NetworkConfig {
  readonly mode: NetworkMode
  readonly hub: ChainIdentity
  readonly clients: readonly ChainIdentity[]
  readonly relayerUrl: string
  readonly irisUrl: string
  readonly indexerUrl: string | null
  /** RPC + balance polling cadence. Shorter on local, longer on testnet. */
  readonly pollIntervalMs: number
  /**
   * Max block span allowed in a single `eth_getLogs` request.
   *
   * Provider limits observed at time of writing:
   *   - Alchemy free tier: 10_000 blocks
   *   - Infura: 10_000 blocks (most methods)
   *   - publicnode.com endpoints: varies; some as low as 5_000
   *   - QuickNode free tier: 10_000
   *
   * 5_000 is half the common ceiling. The headroom covers (a) stricter-tier providers, (b)
   * filter complexity overhead some providers apply when topics/addresses match many logs, and
   * (c) future tightening without code change. Local Anvil has no cap, so we set a generous
   * value rather than disabling the chunker — keeps one code path for both environments.
   */
  readonly maxLogRange: number
}

export function getNetworkMode(): NetworkMode {
  return import.meta.env.VITE_NETWORK === 'sepolia' ? 'sepolia' : 'local'
}

export function isLocalMode(): boolean {
  return getNetworkMode() === 'local'
}

/**
 * Whether the UI should call the relayer HTTP API (`/fees`, `/relay`, `/health`, …). True when
 * the resolved `relayerUrl` is non-empty.
 *
 * Sepolia + unset `VITE_RELAYER_URL` now resolves to `''` → this is honestly `false` (P0-10), so
 * callers can disable gasless toggles, gate fee fetches, and render a "relayer not configured"
 * banner rather than firing requests at `localhost:3001`. Local mode keeps its `localhost:3001`
 * default (a relayer is expected to be running locally).
 */
export function isRelayerConfigured(): boolean {
  return getNetworkConfig().relayerUrl.length > 0
}

/**
 * Optional integrator address passed to `PrivacyPool.shield()` to route shield fees to a third
 * party. Defaults to ZeroAddress when unset or malformed (no fee-routing relationship).
 * Partners configure via `VITE_INTEGRATOR_ADDRESS` without touching code.
 */
export function getIntegratorAddress(): `0x${string}` {
  const raw = import.meta.env.VITE_INTEGRATOR_ADDRESS as string | undefined
  if (raw && /^0x[0-9a-fA-F]{40}$/.test(raw)) return raw as `0x${string}`
  return '0x0000000000000000000000000000000000000000'
}

// Local CCTP domains match config/networks.ts (HUB=100, CLIENT_A=101, CLIENT_B=102).
// Real CCTP domains (e.g. Ethereum=0, Base=6) are reserved for the `sepolia` mode.
const LOCAL_HUB: ChainIdentity = {
  chainId: 31337,
  domain: 100,
  name: 'Anvil Hub (local)',
  rpcUrls: ['http://localhost:8545'],
} as const

const LOCAL_CLIENT_A: ChainIdentity = {
  chainId: 31338,
  domain: 101,
  name: 'Anvil Client A (local)',
  rpcUrls: ['http://localhost:8546'],
} as const

const LOCAL_CLIENT_B: ChainIdentity = {
  chainId: 31339,
  domain: 102,
  name: 'Anvil Client B (local)',
  rpcUrls: ['http://localhost:8547'],
} as const

function sepoliaConfig(): NetworkConfig {
  const sepoliaRpcPrimary = (import.meta.env.VITE_SEPOLIA_RPC as string | undefined)
    ?? 'https://ethereum-sepolia-rpc.publicnode.com'
  const sepoliaRpcFallback = import.meta.env.VITE_SEPOLIA_RPC_FALLBACK as string | undefined

  // Base Sepolia + Arbitrum Sepolia are the production-style client chains per CCTP docs;
  // the exact pairing matches what the relayer + deployments expect.
  const baseSepoliaRpc = (import.meta.env.VITE_BASE_SEPOLIA_RPC as string | undefined)
    ?? 'https://sepolia.base.org'
  const arbSepoliaRpc = (import.meta.env.VITE_ARB_SEPOLIA_RPC as string | undefined)
    ?? 'https://sepolia-rollup.arbitrum.io/rpc'

  return {
    mode: 'sepolia',
    hub: {
      chainId: 11155111,
      domain: 0,
      name: 'Ethereum Sepolia',
      rpcUrls: sepoliaRpcFallback ? [sepoliaRpcPrimary, sepoliaRpcFallback] : [sepoliaRpcPrimary],
      explorerUrl: 'https://sepolia.etherscan.io',
    },
    clients: [
      {
        chainId: 84532,
        domain: 6,
        name: 'Base Sepolia',
        rpcUrls: [baseSepoliaRpc],
        explorerUrl: 'https://sepolia.basescan.org',
      },
      {
        chainId: 421614,
        domain: 3,
        name: 'Arbitrum Sepolia',
        rpcUrls: [arbSepoliaRpc],
        explorerUrl: 'https://sepolia.arbiscan.io',
      },
    ],
    // NO localhost fallback on sepolia (P0-10): a missing VITE_RELAYER_URL must yield '' so
    // `isRelayerConfigured()` is honestly false — not silently point the DEPLOYED app at the
    // visitor's own machine (and an http:// URL from an https:// page is blocked as mixed content
    // anyway). Set VITE_RELAYER_URL to the public HTTPS relayer for sepolia builds.
    relayerUrl: (import.meta.env.VITE_RELAYER_URL as string | undefined) ?? '',
    irisUrl: (import.meta.env.VITE_IRIS_URL as string | undefined) ?? 'https://iris-api-sandbox.circle.com',
    indexerUrl: (import.meta.env.VITE_INDEXER_URL as string | undefined) ?? null,
    pollIntervalMs: 15_000,
    maxLogRange: 5_000,
  }
}

function localConfig(): NetworkConfig {
  return {
    mode: 'local',
    hub: LOCAL_HUB,
    clients: [LOCAL_CLIENT_A, LOCAL_CLIENT_B],
    relayerUrl: (import.meta.env.VITE_RELAYER_URL as string | undefined) ?? 'http://localhost:3001',
    // Iris URL is unused in local mode (CCTP relays via mock module), but populate for type completeness.
    irisUrl: 'https://iris-api-sandbox.circle.com',
    // Honor VITE_INDEXER_URL so the watcher quick-sync path can be exercised against a locally-run
    // indexer (see the F5 local-testing recipe). Unset → null → engine slow scan (B4 invariant).
    indexerUrl: (import.meta.env.VITE_INDEXER_URL as string | undefined) ?? null,
    pollIntervalMs: 5_000,
    maxLogRange: 100_000,
  }
}

let cached: NetworkConfig | null = null

/** Returns the active network configuration. Memoised — the env doesn't change at runtime. */
export function getNetworkConfig(): NetworkConfig {
  if (cached) return cached
  cached = isLocalMode() ? localConfig() : sepoliaConfig()
  return cached
}

/** All known chains in priority order: hub first, then clients. Useful for multi-chain providers. */
export function getAllChainIdentities(): readonly ChainIdentity[] {
  const cfg = getNetworkConfig()
  return [cfg.hub, ...cfg.clients]
}

export function getChainById(chainId: number): ChainIdentity | undefined {
  return getAllChainIdentities().find(c => c.chainId === chainId)
}

export function getChainByDomain(domain: number): ChainIdentity | undefined {
  return getAllChainIdentities().find(c => c.domain === domain)
}
