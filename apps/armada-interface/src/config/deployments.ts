// ABOUTME: Loads privacy-pool deployment manifests for hub + each client chain at app start.
// ABOUTME: Schema typed against actual manifest shapes; fetched via the serveDeployments() Vite dev plugin.

import { getNetworkConfig, type ChainIdentity } from './network'

/** Hub privacy-pool deployment shape (privacy-pool-hub*.json). */
export interface PrivacyPoolHubDeployment {
  chainId: number
  domain: number
  deployer: string
  contracts: {
    privacyPool: string
    merkleModule: string
    verifierModule: string
    shieldModule: string
    transactModule: string
    hookRouter: string
    /**
     * Phase B2 — permit-based gasless `GaslessShieldWrapper` for hub gasless shield. Optional
     * because manifests predating B2 don't carry it; B3's shield handler falls back to
     * direct-submit (the Phase A path) when this is absent.
     */
    gaslessShieldWrapper?: string
  }
  cctp: {
    tokenMessenger: string
    messageTransmitter: string
    usdc: string
  }
  /**
   * Block number the PrivacyPool router was deployed at. Used to bound the SDK's
   * initial historical scan — without it the engine starts from block 0 (Sepolia isn't in the
   * SDK's hardcoded start-block table) and burns hundreds of getLogs calls walking empty
   * pre-deploy chain history. Optional for backward compat with older manifests.
   */
  deployBlock?: number
  timestamp: string
}

/** Client privacy-pool deployment shape (privacy-pool-client*.json). */
export interface PrivacyPoolClientDeployment {
  chainId: number
  domain: number
  deployer: string
  contracts: {
    privacyPoolClient: string
    hookRouter: string
    /**
     * Phase B2 — permit-based gasless `GaslessShieldWrapperClient` for cross-chain gasless
     * shield originating on this client. Same optional-with-fallback rationale as the hub's
     * `gaslessShieldWrapper`.
     */
    gaslessShieldWrapperClient?: string
  }
  cctp: {
    tokenMessenger: string
    messageTransmitter: string
    usdc: string
  }
  hub: {
    domain: number
    privacyPool: string
  }
  /** Block the PrivacyPoolClient was deployed at. Optional; not consumed today (only the hub
   *  chain is scanned), but kept on the type for parity + future use. */
  deployBlock?: number
  timestamp: string
}

export interface ResolvedDeployments {
  hub: PrivacyPoolHubDeployment
  clients: PrivacyPoolClientDeployment[]
}

/**
 * Manifest naming convention per `config/networks.ts`:
 *   local:    privacy-pool-hub.json, privacy-pool-client.json, privacy-pool-clientB.json
 *   sepolia:  privacy-pool-hub-sepolia.json, etc.
 *
 * The 2nd client uses the suffix "clientB" (not "client2"); this is historical.
 */
function manifestName(role: 'hub' | 'client' | 'clientB'): string {
  const cfg = getNetworkConfig()
  const suffix = cfg.mode === 'sepolia' ? '-sepolia' : ''
  return `privacy-pool-${role}${suffix}.json`
}

async function fetchManifest<T>(name: string): Promise<T> {
  const res = await fetch(`/api/deployments/${name}`)
  if (!res.ok) {
    throw new Error(
      `Deployment manifest not found: ${name}. Run \`npm run setup\` from the project root first.`,
    )
  }
  return (await res.json()) as T
}

let cached: ResolvedDeployments | null = null

export async function loadDeployments(): Promise<ResolvedDeployments> {
  if (cached) return cached

  const cfg = getNetworkConfig()
  const hub = await fetchManifest<PrivacyPoolHubDeployment>(manifestName('hub'))

  // Two clients today (clientA + clientB). Mapped to the network config's `clients[]` order.
  const clientNames: ReadonlyArray<'client' | 'clientB'> = ['client', 'clientB']
  const clients: PrivacyPoolClientDeployment[] = []
  for (const role of clientNames.slice(0, cfg.clients.length)) {
    clients.push(await fetchManifest<PrivacyPoolClientDeployment>(manifestName(role)))
  }

  cached = { hub, clients }
  return cached
}

export function getCachedDeployments(): ResolvedDeployments | null {
  return cached
}

/** Map a chain id to its deployment manifest (hub or one of the clients). */
export function findDeploymentForChain(
  deployments: ResolvedDeployments,
  chainId: number,
): PrivacyPoolHubDeployment | PrivacyPoolClientDeployment | undefined {
  if (deployments.hub.chainId === chainId) return deployments.hub
  return deployments.clients.find(c => c.chainId === chainId)
}

/** Type guard. */
export function isHubDeployment(
  d: PrivacyPoolHubDeployment | PrivacyPoolClientDeployment,
): d is PrivacyPoolHubDeployment {
  return 'privacyPool' in d.contracts
}

/** Helper: get the USDC address on a given chain. */
export function getUsdcAddress(deployments: ResolvedDeployments, chain: ChainIdentity): string | undefined {
  return findDeploymentForChain(deployments, chain.chainId)?.cctp.usdc
}

/**
 * Yield deployment manifest (`yield-hub.json` / `yield-hub-sepolia.json`). Separate from the
 * privacy-pool manifests because yield is an optional layer — not every deployment runs it.
 *
 * `armadaYieldVault` issues shielded ayUSDC shares; `armadaYieldAdapter` is the relay-adapt
 * target that `lendAndShield` / `redeemAndShield` call. Both addresses are required for the
 * yield-deposit / yield-withdraw handlers.
 */
export interface YieldDeployment {
  chainId: number
  contracts: {
    armadaYieldVault: string
    armadaYieldAdapter: string
  }
  config: {
    usdc: string
    mockAaveSpoke: string
    reserveId: number
    yieldFeeBps: number
    treasury: string
  }
  timestamp: string
}

let yieldCached: YieldDeployment | null = null

/**
 * Fetch the yield deployment manifest. Returns null if the manifest isn't present (e.g., a
 * deployment that doesn't include yield contracts). Cached in memory after the first call;
 * callers can rely on subsequent calls being cheap.
 */
export async function loadYieldDeployment(): Promise<YieldDeployment | null> {
  if (yieldCached) return yieldCached
  const cfg = getNetworkConfig()
  const suffix = cfg.mode === 'sepolia' ? '-sepolia' : ''
  const name = `yield-hub${suffix}.json`
  try {
    const res = await fetch(`/api/deployments/${name}`)
    if (!res.ok) return null
    yieldCached = (await res.json()) as YieldDeployment
    return yieldCached
  } catch {
    return null
  }
}

export interface FeeModuleDeployment {
  chainId: number
  contracts: {
    feeModuleProxy: string
  }
}

let feeModuleCached: `0x${string}` | null | undefined

/** ArmadaFeeModule proxy on the hub chain — used for on-chain shield fee quotes. */
export async function loadFeeModuleAddress(): Promise<`0x${string}` | null> {
  if (feeModuleCached !== undefined) return feeModuleCached
  const cfg = getNetworkConfig()
  const suffix = cfg.mode === 'sepolia' ? '-sepolia' : ''
  const name = `fee-module-hub${suffix}.json`
  try {
    const res = await fetch(`/api/deployments/${name}`)
    if (!res.ok) {
      feeModuleCached = null
      return null
    }
    const json = (await res.json()) as FeeModuleDeployment
    const addr = json.contracts?.feeModuleProxy
    feeModuleCached =
      addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as `0x${string}`) : null
    return feeModuleCached
  } catch {
    feeModuleCached = null
    return null
  }
}
