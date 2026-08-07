// ABOUTME: Read-path shadow differential — runs @armada/sdk alongside the stock Railgun engine for the
// ABOUTME: unlocked wallet and compares 0zk address + USDC balance + history, WITHOUT changing app behavior.

import {
  createArmadaSdk,
  IndexedDBStorageAdapter,
  getTokenDataERC20,
  getTokenDataHash,
  type ArmadaSdk,
  type ProverAdapter,
  type ArtifactSource,
} from '@armada/sdk'
import { getCachedDeployments, getUsdcAddress } from '../../config/deployments'
import { getNetworkConfig } from '../../config/network'
import * as keyManager from './keyManager'

// Read-only shadow: it only syncs + reads. Proving/artifacts are never exercised, so they throw if
// something unexpectedly reaches the spend path — a loud signal rather than silent wrong behavior.
const readOnlyProver: ProverAdapter = {
  prove: async () => {
    throw new Error('shadow-sdk: read-only shadow does not prove')
  },
  verify: async () => false,
  close: async () => {},
}
const readOnlyArtifacts: ArtifactSource = {
  resolve: async () => {
    throw new Error('shadow-sdk: read-only shadow does not resolve artifacts')
  },
}

export interface ShadowComparison {
  /** The SDK-derived 0zk equals the engine's — the load-bearing identity-parity check. */
  readonly addressMatch: boolean
  /** The SDK-scanned USDC balance equals the engine's. */
  readonly balanceMatch: boolean
  readonly sdkAddress: string
  readonly engineAddress: string
  readonly sdkUsdcBalance: bigint
  readonly engineUsdcBalance: bigint
  readonly historyCount: number
  readonly syncedThrough: number
}

/** Assemble the SDK config from the same deployment + network config the engine uses. */
function shadowConfig(): {
  pool: { chainId: number; poolAddress: `0x${string}`; deployBlock: number; usdcAddress: `0x${string}` }
  rpc: { urls: string[] }
} {
  const deployments = getCachedDeployments()
  if (deployments === null) throw new Error('shadow-sdk: deployments not loaded')
  const hub = getNetworkConfig().hub
  const poolAddress = deployments.hub.contracts.privacyPool as `0x${string}` | undefined
  const usdcAddress = getUsdcAddress(deployments, hub) as `0x${string}` | undefined
  if (!poolAddress || !usdcAddress) {
    throw new Error('shadow-sdk: hub deployment missing privacyPool or usdc')
  }
  return {
    pool: {
      chainId: hub.chainId,
      poolAddress,
      deployBlock: deployments.hub.deployBlock ?? 0,
      usdcAddress,
    },
    rpc: { urls: [...hub.rpcUrls] },
  }
}

type ShadowWallet = Awaited<ReturnType<ArmadaSdk['wallet']['fromRootSecret']>>

// A PERSISTENT SDK instance for the session — IndexedDB-backed, so the scan state survives across
// differential runs and page reloads (the first sync scans from deployBlock; later ones are
// incremental). Recreated when the unlocked wallet changes; closed on lock via `closeShadowSdk`.
let instance: { sdk: ArmadaSdk; wallet: ShadowWallet; address: string } | null = null

/** Separate IDB database from the engine's (`armada-shielded`) so the shadow never touches app state. */
const SHADOW_DB_NAME = 'armada-sdk-shadow'

async function ensureInstance(): Promise<{ sdk: ArmadaSdk; wallet: ShadowWallet; address: string }> {
  const engineAddress = keyManager.getRailgunAddress()
  if (instance !== null && instance.address === engineAddress) return instance

  if (instance !== null) await instance.sdk.close()

  const cfg = shadowConfig()
  const sdk = await createArmadaSdk({
    ...cfg,
    storage: new IndexedDBStorageAdapter(SHADOW_DB_NAME),
    prover: readOnlyProver,
    artifacts: readOnlyArtifacts,
  })
  const wallet = await sdk.wallet.fromRootSecret(keyManager.getRootSecret(), {
    creationBlock: keyManager.getCreationBlock() ?? 0,
  })
  instance = { sdk, wallet, address: engineAddress }
  return instance
}

/**
 * Sync the persistent SDK wallet (incremental, from its IndexedDB-persisted checkpoint) and compare
 * 0zk address + USDC balance + history count to the engine's. Reuses the instance across runs; the
 * caller reports the comparison. Read-only — never mutates app state.
 */
export async function runShadowDifferential(engineUsdcBalance: bigint): Promise<ShadowComparison> {
  const { wallet, address: engineAddress } = await ensureInstance()
  const cfg = shadowConfig()

  const { syncedThrough } = await wallet.sync()
  const usdcHash = getTokenDataHash(getTokenDataERC20(cfg.pool.usdcAddress))
  const balances = await wallet.balances()
  const usdc = balances.find(b => b.tokenHash === usdcHash)
  const sdkUsdcBalance = usdc ? usdc.spendable + usdc.pending : 0n
  const history = await wallet.history()

  return {
    addressMatch: wallet.railgunAddress === engineAddress,
    balanceMatch: sdkUsdcBalance === engineUsdcBalance,
    sdkAddress: wallet.railgunAddress,
    engineAddress,
    sdkUsdcBalance,
    engineUsdcBalance,
    historyCount: history.length,
    syncedThrough,
  }
}

/** Close the persistent instance (call on wallet lock). Idempotent. */
export async function closeShadowSdk(): Promise<void> {
  if (instance !== null) {
    const closing = instance.sdk
    instance = null
    await closing.close()
  }
}
