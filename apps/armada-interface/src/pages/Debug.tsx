// ABOUTME: Developer panel — contract addresses, wallet balances on each chain, plus a faucet drip button in local mode only.
// ABOUTME: Available in both local and sepolia (read-only diagnostics make sense everywhere); the faucet column hides on sepolia.

import { useCallback, useEffect, useState } from 'react'
import { ethers } from 'ethers'
import { useAtomValue } from 'jotai'
import { useAccount } from 'wagmi'
import { Check, Copy } from 'lucide-react'
import { Card, SectionHeader } from '@/components/ui'
import { Button } from '@armada/ui'
import { useWallet } from '@/hooks/useWallet'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { useRelayerHealth } from '@/hooks/useRelayerHealth'
import { loadDeployments, type ResolvedDeployments } from '@/config/deployments'
import { getNetworkConfig, isLocalMode, isRelayerConfigured, type ChainIdentity } from '@/config/network'
import { railgunEngineAtom, shieldedUsdcAtom } from '@/state/wallet'
import { formatUsdcAmount, truncateAddress } from '@/lib/format'
import styles from './Debug.module.css'

/**
 * Small inline copy-to-clipboard widget. Shows a checkmark for 1.2s after a successful copy,
 * then reverts. Inline-scoped to Debug; if a second consumer needs it we'll promote to
 * components/ui/CopyValue. Until then, premature abstraction.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_200)
    } catch {
      // Clipboard API can fail in non-secure contexts (rare on localhost / https). Silent —
      // the user can still select+copy the text manually.
    }
  }
  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className={styles.copyButton}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  )
}

/**
 * `dl` row helper: `dt` label + `dd` containing the value as code with an inline copy button.
 * Returns a fragment so callers can drop it straight into a `<dl>`. When `value` is missing,
 * renders an em-dash placeholder (no copy button).
 */
function AddressRow({ label, value, truncate = false }: {
  label: string
  value: string | undefined
  truncate?: boolean
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value ? (
          <span className={styles.copyRow}>
            <code>{truncate ? truncateAddress(value) : value}</code>
            <CopyButton value={value} label={label} />
          </span>
        ) : (
          '—'
        )}
      </dd>
    </>
  )
}

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)']

/** Secondary manifest shape (hub-v3.json / client-v3.json / clientB-v3.json). */
interface FaucetManifest {
  chainId: number
  contracts: {
    usdc: string
    faucet?: string
  }
}

/** Manifest filename per role; mirrors the convention in deployments/ at the repo root. */
const FAUCET_MANIFEST_NAMES: Record<'hub' | 'clientA' | 'clientB', string> = {
  hub: 'hub-v3.json',
  clientA: 'client-v3.json',
  clientB: 'clientB-v3.json',
}

async function loadFaucetManifest(role: 'hub' | 'clientA' | 'clientB'): Promise<FaucetManifest | null> {
  try {
    const res = await fetch(`/api/deployments/${FAUCET_MANIFEST_NAMES[role]}`)
    if (!res.ok) return null
    return (await res.json()) as FaucetManifest
  } catch {
    return null
  }
}

interface ChainBalance {
  chainId: number
  name: string
  rpcUrl: string
  faucetAddress: string | null
  ethBalance: bigint | null
  usdcBalance: bigint | null
  usdcAddress: string
  error: string | null
}

async function queryChainBalance(
  chain: ChainIdentity,
  evmAddress: string,
  usdcAddress: string,
  faucetAddress: string | null,
): Promise<ChainBalance> {
  const rpcUrl = chain.rpcUrls[0]!
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const usdc = new ethers.Contract(usdcAddress, ERC20_BALANCE_ABI, provider)
    // ethers v6 Contract method types are dynamic / optional under strict TS; non-null asserts
    // because the ABI we passed makes balanceOf+drip statically guaranteed to exist.
    const balanceOfFn = usdc.balanceOf as (a: string) => Promise<bigint>
    const [ethBalance, usdcBalance] = await Promise.all([
      provider.getBalance(evmAddress),
      balanceOfFn(evmAddress),
    ])
    return {
      chainId: chain.chainId,
      name: chain.name,
      rpcUrl,
      faucetAddress,
      ethBalance,
      usdcBalance,
      usdcAddress,
      error: null,
    }
  } catch (err) {
    return {
      chainId: chain.chainId,
      name: chain.name,
      rpcUrl,
      faucetAddress,
      ethBalance: null,
      usdcBalance: null,
      usdcAddress,
      error: err instanceof Error ? err.message : 'query failed',
    }
  }
}

export function Debug() {
  // Read-only consumers — Sign step gates on these, here we just surface them for inspection.
  const engine = useAtomValue(railgunEngineAtom)
  const shielded = useAtomValue(shieldedUsdcAtom)
  const { address: evmAddress } = useWallet()
  const { state: shieldedState } = useShieldedWallet()
  const { chainId: connectedChainId } = useAccount()

  const [deployments, setDeployments] = useState<ResolvedDeployments | null>(null)
  const [faucetByChainId, setFaucetByChainId] = useState<Record<number, string>>({})
  const [balances, setBalances] = useState<ChainBalance[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [drippingChainId, setDrippingChainId] = useState<number | null>(null)
  const [dripError, setDripError] = useState<string | null>(null)
  const [resettingEngine, setResettingEngine] = useState(false)

  // Relayer health pill next to the URL. Polled only when a relayer is actually configured —
  // hosted builds without VITE_RELAYER_URL set `isRelayerConfigured()` to false and would
  // otherwise hit `fetch('')` every 60s for no benefit.
  const relayerHealth = useRelayerHealth({ enabled: isRelayerConfigured() })

  // Refresh chain balances against the currently-connected EVM address. Called on mount,
  // after a successful faucet drip, and via the "Refresh" button.
  const refreshBalances = useCallback(async () => {
    if (!evmAddress || !deployments) return
    setRefreshing(true)
    try {
      const cfg = getNetworkConfig()
      const chains: Array<{ chain: ChainIdentity; usdc: string }> = [
        { chain: cfg.hub, usdc: deployments.hub.cctp.usdc },
        ...deployments.clients.map((c, i) => ({
          chain: cfg.clients[i]!,
          usdc: c.cctp.usdc,
        })),
      ]
      const results = await Promise.all(
        chains.map(({ chain, usdc }) =>
          queryChainBalance(chain, evmAddress, usdc, faucetByChainId[chain.chainId] ?? null),
        ),
      )
      setBalances(results)
    } finally {
      setRefreshing(false)
    }
  }, [evmAddress, deployments, faucetByChainId])

  // One-time bootstrap: pull the privacy-pool deployments + (local mode only) the secondary
  // faucet manifests. The faucet manifests (hub-v3.json etc.) only exist for the local Anvil
  // deployment; skipping the fetch on Sepolia avoids three 404s in the network panel.
  useEffect(() => {
    void (async () => {
      const resolved = await loadDeployments()
      setDeployments(resolved)
      if (!isLocalMode()) return
      const [hubFaucet, clientFaucet, clientBFaucet] = await Promise.all([
        loadFaucetManifest('hub'),
        loadFaucetManifest('clientA'),
        loadFaucetManifest('clientB'),
      ])
      const map: Record<number, string> = {}
      for (const m of [hubFaucet, clientFaucet, clientBFaucet]) {
        if (m?.contracts.faucet) map[m.chainId] = m.contracts.faucet
      }
      setFaucetByChainId(map)
    })()
  }, [])

  // Refresh balances once deployments + wallet are both ready.
  useEffect(() => {
    void refreshBalances()
  }, [refreshBalances])

  const handleResetEngine = useCallback(async () => {
    setResettingEngine(true)
    try {
      // Reset the module-scope init flags then trigger a re-init. The Jotai atom mirror will
      // re-track lifecycle (cold → warming → ready/failed). Doesn't clear IDB / artifact cache;
      // for a hard reset the user can wipe site data via devtools.
      const { resetInitState, initRailgunEngine } = await import('@/lib/railgun/init')
      resetInitState()
      await initRailgunEngine()
    } finally {
      setResettingEngine(false)
    }
  }, [])

  const handleDrip = useCallback(
    async (chainId: number) => {
      if (!evmAddress) {
        setDripError('Connect your wallet first.')
        return
      }
      setDripError(null)
      setDrippingChainId(chainId)
      try {
        // POST to the dev-server endpoint — uses the Anvil deployer to call dripTo(address),
        // sending USDC + sponsor ETH to the user. Sidesteps the chicken-and-egg of needing
        // gas to call drip() directly. The endpoint is local-mode only (503 on sepolia).
        const res = await fetch('/api/fund-gas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: evmAddress, chainId }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
          throw new Error(data.error ?? 'Drip failed.')
        }
        await refreshBalances()
      } catch (err) {
        setDripError(err instanceof Error ? err.message : 'Drip failed.')
      } finally {
        setDrippingChainId(null)
      }
    },
    [evmAddress, refreshBalances],
  )

  const localMode = isLocalMode()

  return (
    <div className={styles.page}>
      <SectionHeader title="Debug" />

      <Card className={styles.section}>
        <h3 className={styles.sectionTitle}>Network</h3>
        <dl className={styles.kv}>
          <dt>Mode</dt><dd>{localMode ? 'local' : 'sepolia'}</dd>
          <dt>Engine state</dt>
          <dd>
            <span className={styles.copyRow}>
              <span>{engine.state}{engine.error ? ` — ${engine.error}` : ''}</span>
              <Button
                variant="secondary"
                size="sm"
                showIcon={false}
                label={resettingEngine ? 'Resetting…' : 'Reset'}
                onClick={() => void handleResetEngine()}
                disabled={resettingEngine || engine.state === 'warming'}
              />
            </span>
          </dd>
          <dt>Hub chain</dt><dd>{getNetworkConfig().hub.name} ({getNetworkConfig().hub.chainId})</dd>
          <dt>Client chains</dt><dd>{getNetworkConfig().clients.map(c => `${c.name} (${c.chainId})`).join(', ')}</dd>
          <dt>Relayer URL</dt>
          <dd>
            <code>{getNetworkConfig().relayerUrl || '—'}</code>
            {isRelayerConfigured() ? <RelayerHealthPill state={relayerHealth} /> : null}
          </dd>
        </dl>
      </Card>

      <Card className={styles.section}>
        <h3 className={styles.sectionTitle}>Connected wallet</h3>
        <dl className={styles.kv}>
          <AddressRow label="EVM address" value={evmAddress ?? undefined} />
          <dt>Wallet chain</dt><dd>{connectedChainId ?? '—'}</dd>
          <AddressRow label="Shielded wallet ID" value={shieldedState?.id} />
          <dt>Shielded status</dt><dd>{shieldedState?.status ?? 'missing'}</dd>
          <AddressRow label="Shielded address" value={shieldedState?.railgunAddress} truncate />
          <dt>Anti-phish checksum</dt><dd>{shieldedState?.checksum ?? '—'}</dd>
          <dt>Shielded USDC</dt><dd>{shielded === null ? '— not synced —' : `${formatUsdcAmount(shielded)} USDC`}</dd>
        </dl>
      </Card>

      <Card className={styles.section}>
        <div className={styles.sectionHeaderRow}>
          <h3 className={styles.sectionTitle}>Balances per chain</h3>
          <Button
            variant="secondary"
            size="sm"
            showIcon={false}
            label={refreshing ? 'Refreshing…' : 'Refresh'}
            onClick={() => void refreshBalances()}
            disabled={refreshing || !evmAddress}
          />
        </div>
        {!evmAddress ? (
          <p className={styles.muted}>Connect a wallet to see balances.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Chain</th>
                <th>ETH</th>
                <th>USDC</th>
                {localMode ? <th>Faucet</th> : null}
              </tr>
            </thead>
            <tbody>
              {balances.map(b => (
                <tr key={b.chainId}>
                  <td>{b.name} ({b.chainId})</td>
                  <td>{b.ethBalance === null ? '—' : ethers.formatEther(b.ethBalance).slice(0, 8)}</td>
                  <td>{b.usdcBalance === null ? '—' : formatUsdcAmount(b.usdcBalance)}</td>
                  {localMode ? (
                    <td>
                      {b.faucetAddress ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          showIcon={false}
                          label={drippingChainId === b.chainId ? 'Dripping…' : 'Drip'}
                          onClick={() => void handleDrip(b.chainId)}
                          disabled={drippingChainId !== null || !evmAddress}
                        />
                      ) : (
                        <span className={styles.muted}>no faucet</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {dripError ? (
          <div role="alert" className={styles.error}>{dripError}</div>
        ) : null}
      </Card>

      <Card className={styles.section}>
        <h3 className={styles.sectionTitle}>Hub contracts</h3>
        {deployments ? (
          <dl className={styles.kv}>
            <AddressRow label="PrivacyPool" value={deployments.hub.contracts.privacyPool} />
            <AddressRow label="MerkleModule" value={deployments.hub.contracts.merkleModule} />
            <AddressRow label="VerifierModule" value={deployments.hub.contracts.verifierModule} />
            <AddressRow label="ShieldModule" value={deployments.hub.contracts.shieldModule} />
            <AddressRow label="TransactModule" value={deployments.hub.contracts.transactModule} />
            <AddressRow label="HookRouter" value={deployments.hub.contracts.hookRouter} />
            <AddressRow label="USDC" value={deployments.hub.cctp.usdc} />
            <AddressRow label="TokenMessenger" value={deployments.hub.cctp.tokenMessenger} />
            <AddressRow label="MessageTransmitter" value={deployments.hub.cctp.messageTransmitter} />
            <AddressRow label="Faucet" value={faucetByChainId[deployments.hub.chainId]} />
          </dl>
        ) : (
          <p className={styles.muted}>Loading…</p>
        )}
      </Card>

      <Card className={styles.section}>
        <h3 className={styles.sectionTitle}>Client contracts</h3>
        {deployments ? (
          deployments.clients.map((c, i) => (
            <div key={c.chainId} className={i > 0 ? styles.clientBlockSpaced : styles.clientBlock}>
              <h4 className={styles.subTitle}>{getNetworkConfig().clients[i]?.name ?? `Client ${i + 1}`} ({c.chainId})</h4>
              <dl className={styles.kv}>
                <AddressRow label="PrivacyPoolClient" value={c.contracts.privacyPoolClient} />
                <AddressRow label="HookRouter" value={c.contracts.hookRouter} />
                <AddressRow label="USDC" value={c.cctp.usdc} />
                <AddressRow label="Faucet" value={faucetByChainId[c.chainId]} />
              </dl>
            </div>
          ))
        ) : (
          <p className={styles.muted}>Loading…</p>
        )}
      </Card>
    </div>
  )
}

// Health pill — small colored dot + status label. Healthy = green, stale/unhealthy = amber,
// unreachable (query error) = red, in-flight first fetch = gray "checking…". The hook itself
// is gated on isRelayerConfigured() at the call site so this only renders when there's a real
// endpoint to poll.
function RelayerHealthPill({ state }: { state: ReturnType<typeof useRelayerHealth> }) {
  const { data, error, isLoading } = state

  let dotClass = styles.healthDot
  let label: string
  if (error) {
    dotClass = `${styles.healthDot} ${styles.healthDotUnreachable}`
    label = 'unreachable'
  } else if (isLoading || !data) {
    label = 'checking…'
  } else if (data.status === 'healthy') {
    dotClass = `${styles.healthDot} ${styles.healthDotHealthy}`
    label = 'healthy'
  } else {
    dotClass = `${styles.healthDot} ${styles.healthDotDegraded}`
    label = data.status // 'stale' | 'unhealthy'
  }

  return (
    <span className={styles.healthPill} aria-label={`Relayer health: ${label}`}>
      <span className={dotClass} aria-hidden />
      {label}
    </span>
  )
}
