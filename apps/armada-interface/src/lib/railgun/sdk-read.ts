// ABOUTME: The @armada/sdk shielded read path — a persistent IndexedDB-backed SDK instance that syncs the
// ABOUTME: unlocked wallet and reports its 0zk address, USDC balance, yield-vault shares, and tx history.

import {
  createArmadaSdk,
  IndexedDBStorageAdapter,
  getTokenDataERC20,
  getTokenDataHash,
  type ArmadaSdk,
  type ProverAdapter,
  type ArtifactSource,
  type HistoryEntry,
} from '@armada/sdk'
import { getCachedDeployments, getUsdcAddress, loadYieldDeployment } from '../../config/deployments'
import { getNetworkConfig } from '../../config/network'
import * as keyManager from './keyManager'

// Read-only: it only syncs + reads. Proving/artifacts are never exercised, so they throw if
// something unexpectedly reaches the spend path — a loud signal rather than silent wrong behavior.
const readOnlyProver: ProverAdapter = {
  prove: async () => {
    throw new Error('sdk-read: read-only read path does not prove')
  },
  verify: async () => false,
  close: async () => {},
}
const readOnlyArtifacts: ArtifactSource = {
  resolve: async () => {
    throw new Error('sdk-read: read-only read path does not resolve artifacts')
  },
}

/** The shielded yield-vault share token (ayUSDC), if a yield deployment exists. */
async function vaultTokenAddress(): Promise<`0x${string}` | undefined> {
  const yieldDeployment = await loadYieldDeployment()
  return yieldDeployment?.contracts.armadaYieldVault as `0x${string}` | undefined
}

/** Assemble the SDK config from the same deployment + network config the engine uses. */
async function readPathConfig(): Promise<{
  pool: {
    chainId: number
    poolAddress: `0x${string}`
    deployBlock: number
    usdcAddress: `0x${string}`
    additionalTokens?: `0x${string}`[]
  }
  rpc: { urls: string[] }
}> {
  const deployments = getCachedDeployments()
  if (deployments === null) throw new Error('sdk-read: deployments not loaded')
  const hub = getNetworkConfig().hub
  const poolAddress = deployments.hub.contracts.privacyPool as `0x${string}` | undefined
  const usdcAddress = getUsdcAddress(deployments, hub) as `0x${string}` | undefined
  if (!poolAddress || !usdcAddress) {
    throw new Error('sdk-read: hub deployment missing privacyPool or usdc')
  }
  // Scan the yield-vault share token too, so the SDK can report shielded ayUSDC shares.
  const vault = await vaultTokenAddress()
  return {
    pool: {
      chainId: hub.chainId,
      poolAddress,
      deployBlock: deployments.hub.deployBlock ?? 0,
      usdcAddress,
      ...(vault ? { additionalTokens: [vault] } : {}),
    },
    rpc: { urls: [...hub.rpcUrls] },
  }
}

type ReadWallet = Awaited<ReturnType<ArmadaSdk['wallet']['fromRootSecret']>>

// A PERSISTENT SDK instance for the session — IndexedDB-backed, so the scan state survives across reads
// and page reloads (the first sync scans from deployBlock; later ones are
// incremental). Recreated when the unlocked wallet changes; closed on lock via `closeSdkRead`.
let instance: { sdk: ArmadaSdk; wallet: ReadWallet; address: string } | null = null

// Separate IDB database from the engine's (`armada-shielded`) so the SDK read instance keeps its
// own scan state. The value retains the legacy `-shadow` name so existing users' persisted scan
// state isn't orphaned by the rename (a changed name would force a full re-scan on next unlock).
const READ_DB_NAME = 'armada-sdk-shadow'

async function ensureInstance(): Promise<{ sdk: ArmadaSdk; wallet: ReadWallet; address: string }> {
  const engineAddress = keyManager.getRailgunAddress()
  if (instance !== null && instance.address === engineAddress) return instance

  if (instance !== null) await instance.sdk.close()

  const cfg = await readPathConfig()
  const sdk = await createArmadaSdk({
    ...cfg,
    storage: new IndexedDBStorageAdapter(READ_DB_NAME),
    prover: readOnlyProver,
    artifacts: readOnlyArtifacts,
  })
  const wallet = await sdk.wallet.fromRootSecret(keyManager.getRootSecret(), {
    creationBlock: keyManager.getCreationBlock() ?? 0,
  })
  instance = { sdk, wallet, address: engineAddress }
  return instance
}

/** Sync the persistent SDK wallet and return its shielded USDC balance (spendable + pending). */
export async function syncSdkUsdcBalance(): Promise<bigint> {
  const { wallet } = await ensureInstance()
  await wallet.sync()
  const cfg = await readPathConfig()
  const usdcHash = getTokenDataHash(getTokenDataERC20(cfg.pool.usdcAddress))
  const usdc = (await wallet.balances()).find(b => b.tokenHash === usdcHash)
  return usdc ? usdc.spendable + usdc.pending : 0n
}

/** Sync the persistent SDK wallet and return its shielded yield-vault shares (ayUSDC). 0 if no vault. */
export async function syncSdkYieldShares(): Promise<bigint> {
  const vault = await vaultTokenAddress()
  if (vault === undefined) return 0n
  const { wallet } = await ensureInstance()
  await wallet.sync()
  const vaultHash = getTokenDataHash(getTokenDataERC20(vault))
  const shares = (await wallet.balances()).find(b => b.tokenHash === vaultHash)
  return shares ? shares.spendable + shares.pending : 0n
}

/** Sync + reconstruct the SDK wallet's tx history (optionally only entries at/after `sinceBlock`). */
export async function syncSdkHistory(sinceBlock?: number): Promise<HistoryEntry[]> {
  const { wallet } = await ensureInstance()
  await wallet.sync()
  return wallet.history(sinceBlock !== undefined ? { sinceBlock } : {})
}

/** Close the persistent instance (call on wallet lock). Idempotent. */
export async function closeSdkRead(): Promise<void> {
  if (instance !== null) {
    const closing = instance.sdk
    instance = null
    await closing.close()
  }
}
