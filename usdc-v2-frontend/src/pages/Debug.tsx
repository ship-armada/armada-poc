import { useState, useEffect, useCallback } from 'react'
import { ethers, BrowserProvider } from 'ethers'
import { RefreshCw, AlertCircle, CheckCircle, Clock, Droplets } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Spinner } from '@/components/common/Spinner'
import {
  getYieldDeployment,
  getAaveDeployment,
  getHubCCTPDeployment,
  areDeploymentsLoaded,
  loadDeployments,
  getHubChain,
  getClientChain,
  type ChainConfig,
} from '@/config/deployments'

// ============ Types ============

interface YieldStats {
  // Vault stats
  totalAssets: bigint
  totalSupply: bigint
  totalPrincipal: bigint
  totalYield: bigint
  sharePrice: bigint
  // Treasury stats
  treasuryBalance: bigint
  treasuryTotalCollected: bigint
  // Aave stats
  aaveReserveApy: number
  vaultPositionInAave: bigint
}

interface SystemAddresses {
  usdc: string
  armadaYieldVault: string
  armadaYieldAdapter: string
  armadaTreasury: string
  mockAaveSpoke: string
}

// ============ Contract ABIs ============

const VAULT_ABI = [
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalPrincipal() view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
]

const TREASURY_ABI = [
  'function getBalance(address token) view returns (uint256)',
  'function totalCollected(address token) view returns (uint256)',
]

const AAVE_SPOKE_ABI = [
  'function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)',
  // Matches the Reserve struct: underlying, totalShares, totalDeposited, liquidityIndex, lastUpdateTimestamp, annualYieldBps, mintableYield
  'function reserves(uint256 reserveId) view returns (address underlying, uint256 totalShares, uint256 totalDeposited, uint256 liquidityIndex, uint256 lastUpdateTimestamp, uint256 annualYieldBps, bool mintableYield)',
]

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
]

const FAUCET_ABI = [
  'function drip() external',
  'function USDC_AMOUNT() view returns (uint256)',
  'function ETH_AMOUNT() view returns (uint256)',
]

// Minimum ETH balance needed to send a faucet transaction
const MIN_GAS_BALANCE = ethers.parseEther('0.01')

// ============ Faucet Types ============

interface ChainBalance {
  chain: ChainConfig
  usdc: bigint
  eth: bigint
  isLoading: boolean
  error: string | null
}

// ============ Faucet Helper Functions ============

/**
 * Request tokens from the faucet via the dev server endpoint.
 * This uses the Anvil deployer account to call dripTo() on the faucet,
 * giving the user 1000 USDC + 1 ETH without needing gas.
 */
async function requestFaucetViaBackend(address: string, chainId: number): Promise<void> {
  const response = await fetch('/api/fund-gas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, chainId }),
  })

  if (!response.ok) {
    const data = await response.json()
    throw new Error(data.error || 'Failed to request tokens')
  }
}

/**
 * Request tokens from faucet directly (when user has gas)
 */
async function requestFaucetDirect(
  chain: ChainConfig,
  signer: ethers.Signer
): Promise<void> {
  if (!chain.contracts?.faucet) {
    throw new Error(`No faucet address for chain ${chain.id}`)
  }

  const faucet = new ethers.Contract(chain.contracts.faucet, FAUCET_ABI, signer)
  const tx = await faucet.drip()
  await tx.wait()
}

/**
 * Get public USDC balance for an address on a chain
 */
async function getPublicBalance(chain: ChainConfig, address: string): Promise<bigint> {
  const usdcAddress = chain.contracts?.usdc || chain.contracts?.mockUSDC
  if (!usdcAddress) return 0n

  const provider = new ethers.JsonRpcProvider(chain.rpcUrl)
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider)
  return await usdc.balanceOf(address)
}

/**
 * Get native ETH balance for an address on a chain
 */
async function getNativeBalance(chain: ChainConfig, address: string): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl)
  return await provider.getBalance(address)
}

/**
 * Format ETH amount for display (18 decimals)
 */
function formatETH(amount: bigint): string {
  return ethers.formatEther(amount)
}

// ============ Component ============

export function Debug() {
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<YieldStats | null>(null)
  const [addresses, setAddresses] = useState<SystemAddresses | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)

  // Faucet state
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null)
  const [chainBalances, setChainBalances] = useState<ChainBalance[]>([])
  const [faucetLoading, setFaucetLoading] = useState<Record<number, boolean>>({})
  const [faucetErrors, setFaucetErrors] = useState<Record<number, string | null>>({})
  const [balancesLoading, setBalancesLoading] = useState(false)

  const fetchStats = useCallback(async () => {
    try {
      // Ensure deployments are loaded
      if (!areDeploymentsLoaded()) {
        await loadDeployments()
      }

      const yieldDeployment = getYieldDeployment()
      const aaveDeployment = getAaveDeployment()
      const cctpDeployment = getHubCCTPDeployment()

      if (!yieldDeployment) {
        throw new Error('Yield deployment not found. Run deploy:yield first.')
      }

      // Set addresses
      setAddresses({
        usdc: yieldDeployment.config.usdc,
        armadaYieldVault: yieldDeployment.contracts.armadaYieldVault,
        armadaYieldAdapter: yieldDeployment.contracts.armadaYieldAdapter,
        armadaTreasury: yieldDeployment.contracts.armadaTreasury,
        mockAaveSpoke: yieldDeployment.config.mockAaveSpoke,
      })

      // Connect to hub chain
      const provider = new ethers.JsonRpcProvider('http://localhost:8545')

      // Create contract instances
      const vault = new ethers.Contract(
        yieldDeployment.contracts.armadaYieldVault,
        VAULT_ABI,
        provider
      )
      const treasury = new ethers.Contract(
        yieldDeployment.contracts.armadaTreasury,
        TREASURY_ABI,
        provider
      )
      const aaveSpoke = new ethers.Contract(
        yieldDeployment.config.mockAaveSpoke,
        AAVE_SPOKE_ABI,
        provider
      )

      // Fetch all stats in parallel
      const [
        totalAssets,
        totalSupply,
        totalPrincipal,
        sharePriceRaw,
        treasuryBalance,
        treasuryTotalCollected,
        vaultPositionInAave,
        reserveInfo,
      ] = await Promise.all([
        vault.totalAssets(),
        vault.totalSupply(),
        vault.totalPrincipal(),
        vault.convertToAssets(ethers.parseUnits('1', 6)), // Price of 1 share
        treasury.getBalance(yieldDeployment.config.usdc),
        treasury.totalCollected(yieldDeployment.config.usdc),
        aaveSpoke.getUserSuppliedAssets(
          yieldDeployment.config.reserveId,
          yieldDeployment.contracts.armadaYieldVault
        ),
        aaveSpoke.reserves(yieldDeployment.config.reserveId),
      ])

      // Calculate total yield
      const totalYield = totalAssets > totalPrincipal ? totalAssets - totalPrincipal : 0n

      setStats({
        totalAssets,
        totalSupply,
        totalPrincipal,
        totalYield,
        sharePrice: sharePriceRaw,
        treasuryBalance,
        treasuryTotalCollected,
        aaveReserveApy: Number(reserveInfo.annualYieldBps) / 100, // Convert bps to percent
        vaultPositionInAave,
      })

      setLastUpdated(new Date())
      setError(null)
    } catch (err) {
      console.error('[Debug] Failed to fetch stats:', err)
      setError(err instanceof Error ? err.message : 'Failed to fetch stats')
    }
  }, [])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await fetchStats()
    setIsRefreshing(false)
  }

  // Initial load
  useEffect(() => {
    const load = async () => {
      setIsLoading(true)
      await fetchStats()
      setIsLoading(false)
    }
    load()
  }, [fetchStats])

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return

    const interval = setInterval(() => {
      fetchStats()
    }, 5000) // Every 5 seconds

    return () => clearInterval(interval)
  }, [autoRefresh, fetchStats])

  // Get all configured chains for faucet
  const getAllChains = useCallback((): ChainConfig[] => {
    const chains: ChainConfig[] = []
    const hub = getHubChain()
    if (hub) chains.push(hub)
    const clientA = getClientChain('client-a')
    if (clientA) chains.push(clientA)
    const clientB = getClientChain('client-b')
    if (clientB) chains.push(clientB)
    return chains
  }, [])

  // Fetch balances for all chains
  const refreshBalances = useCallback(async () => {
    if (!connectedAddress) {
      setChainBalances([])
      return
    }

    setBalancesLoading(true)
    const chains = getAllChains()
    const newBalances: ChainBalance[] = []

    for (const chain of chains) {
      try {
        const [usdc, eth] = await Promise.all([
          getPublicBalance(chain, connectedAddress),
          getNativeBalance(chain, connectedAddress),
        ])
        newBalances.push({ chain, usdc, eth, isLoading: false, error: null })
      } catch (err) {
        newBalances.push({
          chain,
          usdc: 0n,
          eth: 0n,
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to fetch balance',
        })
      }
    }

    setChainBalances(newBalances)
    setBalancesLoading(false)
  }, [connectedAddress, getAllChains])

  // Connect wallet and fetch balances
  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      console.warn('[Debug] No wallet found')
      return
    }

    try {
      const provider = new BrowserProvider(window.ethereum)
      const accounts = await provider.send('eth_requestAccounts', [])
      if (accounts.length > 0) {
        setConnectedAddress(accounts[0])
      }
    } catch (err) {
      console.error('[Debug] Failed to connect wallet:', err)
    }
  }, [])

  // Handle faucet request for a specific chain
  const handleFaucetRequest = useCallback(async (chain: ChainConfig) => {
    if (!connectedAddress) {
      await connectWallet()
      return
    }

    setFaucetLoading((prev) => ({ ...prev, [chain.id]: true }))
    setFaucetErrors((prev) => ({ ...prev, [chain.id]: null }))

    try {
      // Check if user has enough gas to call faucet directly
      const ethBalance = await getNativeBalance(chain, connectedAddress)

      if (ethBalance < MIN_GAS_BALANCE) {
        // Use backend to call dripTo() on user's behalf
        await requestFaucetViaBackend(connectedAddress, chain.id)
      } else {
        // Call faucet directly
        if (!window.ethereum) throw new Error('No wallet found')
        const provider = new BrowserProvider(window.ethereum)
        const signer = await provider.getSigner()
        await requestFaucetDirect(chain, signer)
      }

      // Refresh balances after successful faucet
      await refreshBalances()
    } catch (err) {
      console.error(`[Debug] Faucet error for chain ${chain.id}:`, err)
      setFaucetErrors((prev) => ({
        ...prev,
        [chain.id]: err instanceof Error ? err.message : 'Failed to request tokens',
      }))
    } finally {
      setFaucetLoading((prev) => ({ ...prev, [chain.id]: false }))
    }
  }, [connectedAddress, connectWallet, refreshBalances])

  // Auto-connect wallet and fetch balances on mount
  useEffect(() => {
    const init = async () => {
      await connectWallet()
    }
    init()
  }, [connectWallet])

  // Refresh balances when address changes
  useEffect(() => {
    if (connectedAddress) {
      refreshBalances()
    }
  }, [connectedAddress, refreshBalances])

  // Format helpers
  const formatUSDC = (amount: bigint): string => {
    const formatted = ethers.formatUnits(amount, 6)
    return Number(formatted).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    })
  }

  const formatSharePrice = (price: bigint): string => {
    // Share price is in 6 decimals (1 share = X USDC)
    const formatted = ethers.formatUnits(price, 6)
    return Number(formatted).toFixed(6)
  }

  const truncateAddress = (address: string): string => {
    return `${address.slice(0, 10)}...${address.slice(-8)}`
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Loading yield system stats..." />
      </div>
    )
  }

  return (
    <div className="container mx-auto p-12 max-w-4xl">
      <header className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">System Debug</h1>
            <p className="text-muted-foreground mt-1">
              Yield system statistics and contract addresses
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
              />
              Auto-refresh
            </label>
            <Button
              variant="secondary"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
        {lastUpdated && (
          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Last updated: {lastUpdated.toLocaleTimeString()}
          </p>
        )}
      </header>

      {error ? (
        <div className="card bg-error/10 border-error/20">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-error mt-0.5" />
            <div>
              <h3 className="font-medium text-error">Error Loading Stats</h3>
              <p className="text-sm text-error/80 mt-1">{error}</p>
              <p className="text-xs text-muted-foreground mt-2">
                Make sure the chains are running and contracts are deployed.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Test Faucet */}
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <Droplets className="h-5 w-5 text-primary" />
              Test Faucet
            </h2>
            <div className="card">
              <p className="text-sm text-muted-foreground mb-4">
                Get test USDC and ETH for each chain. Each faucet gives 1,000 USDC and 1 ETH.
              </p>

              {/* Faucet Buttons */}
              <div className="flex flex-wrap gap-3 mb-6">
                {getAllChains().map((chain) => (
                  <div key={chain.id} className="flex flex-col items-center gap-1">
                    <Button
                      onClick={() => handleFaucetRequest(chain)}
                      disabled={faucetLoading[chain.id] || !chain.contracts?.faucet}
                      variant="secondary"
                      className="gap-2"
                    >
                      {faucetLoading[chain.id] ? (
                        <>
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          Requesting...
                        </>
                      ) : chain.contracts?.faucet ? (
                        `Get ${chain.name} tokens`
                      ) : (
                        'No faucet'
                      )}
                    </Button>
                    {faucetErrors[chain.id] && (
                      <p className="text-xs text-error max-w-[150px] text-center">
                        {faucetErrors[chain.id]}
                      </p>
                    )}
                  </div>
                ))}
                <Button
                  onClick={refreshBalances}
                  disabled={balancesLoading}
                  variant="ghost"
                  className="gap-2"
                  title="Refresh balances"
                >
                  <RefreshCw className={`h-4 w-4 ${balancesLoading ? 'animate-spin' : ''}`} />
                </Button>
              </div>

              {/* Balance Table */}
              {connectedAddress && (
                <div className="border-t border-border pt-4">
                  <h4 className="text-sm font-medium text-muted-foreground mb-3">
                    Your Public Balances ({truncateAddress(connectedAddress)})
                  </h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-muted-foreground text-left">
                          <th className="pb-2 font-medium">Chain</th>
                          <th className="pb-2 font-medium text-right">USDC</th>
                          <th className="pb-2 font-medium text-right">ETH</th>
                        </tr>
                      </thead>
                      <tbody>
                        {chainBalances.map((b) => (
                          <tr key={b.chain.id} className="border-t border-border">
                            <td className="py-2">
                              <span className="flex items-center gap-2">
                                <span
                                  className={`w-2 h-2 rounded-full ${
                                    b.chain.id === 31337 ? 'bg-primary' : 'bg-success'
                                  }`}
                                />
                                {b.chain.name}
                              </span>
                            </td>
                            <td className="py-2 text-right font-mono">
                              {b.isLoading ? (
                                <span className="text-muted-foreground">...</span>
                              ) : b.error ? (
                                <span className="text-error">Error</span>
                              ) : (
                                <span>{formatUSDC(b.usdc)}</span>
                              )}
                            </td>
                            <td className="py-2 text-right font-mono">
                              {b.isLoading ? (
                                <span className="text-muted-foreground">...</span>
                              ) : b.error ? (
                                <span className="text-error">Error</span>
                              ) : (
                                <span className="text-muted-foreground">
                                  {formatETH(b.eth).slice(0, 8)}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {!connectedAddress && (
                <div className="border-t border-border pt-4">
                  <p className="text-sm text-muted-foreground">
                    Connect your wallet to view balances and request tokens.
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Vault Stats */}
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-success" />
              Armada Yield Vault
            </h2>
            <div className="card">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                <div>
                  <p className="text-sm text-muted-foreground">Total Assets</p>
                  <p className="text-2xl font-bold">
                    ${stats ? formatUSDC(stats.totalAssets) : '--'}
                  </p>
                  <p className="text-xs text-muted-foreground">USDC in vault</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Supply</p>
                  <p className="text-2xl font-bold">
                    {stats ? formatUSDC(stats.totalSupply) : '--'}
                  </p>
                  <p className="text-xs text-muted-foreground">ayUSDC shares</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Principal</p>
                  <p className="text-2xl font-bold">
                    ${stats ? formatUSDC(stats.totalPrincipal) : '--'}
                  </p>
                  <p className="text-xs text-muted-foreground">Original deposits</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Yield Accrued</p>
                  <p className="text-2xl font-bold text-success">
                    ${stats ? formatUSDC(stats.totalYield) : '--'}
                  </p>
                  <p className="text-xs text-muted-foreground">Assets - Principal</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Share Price</p>
                  <p className="text-2xl font-bold">
                    {stats ? formatSharePrice(stats.sharePrice) : '--'}
                  </p>
                  <p className="text-xs text-muted-foreground">USDC per ayUSDC</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Yield Fee</p>
                  <p className="text-2xl font-bold">10%</p>
                  <p className="text-xs text-muted-foreground">On redemption</p>
                </div>
              </div>
            </div>
          </section>

          {/* Treasury Stats */}
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-success" />
              Armada Treasury
            </h2>
            <div className="card">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                <div>
                  <p className="text-sm text-muted-foreground">Current Balance</p>
                  <p className="text-2xl font-bold text-primary">
                    ${stats ? formatUSDC(stats.treasuryBalance) : '--'}
                  </p>
                  <p className="text-xs text-muted-foreground">Available to withdraw</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Collected</p>
                  <p className="text-2xl font-bold">
                    ${stats ? formatUSDC(stats.treasuryTotalCollected) : '--'}
                  </p>
                  <p className="text-xs text-muted-foreground">All-time fees</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Withdrawn</p>
                  <p className="text-2xl font-bold">
                    ${stats ? formatUSDC(stats.treasuryTotalCollected - stats.treasuryBalance) : '--'}
                  </p>
                  <p className="text-xs text-muted-foreground">Collected - Balance</p>
                </div>
              </div>
            </div>
          </section>

          {/* Aave Stats */}
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-success" />
              Mock Aave Spoke
            </h2>
            <div className="card">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                <div>
                  <p className="text-sm text-muted-foreground">Reserve APY</p>
                  <p className="text-2xl font-bold text-success">
                    {stats ? `${stats.aaveReserveApy.toFixed(2)}%` : '--'}
                  </p>
                  <p className="text-xs text-muted-foreground">Annual yield rate</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Vault Position</p>
                  <p className="text-2xl font-bold">
                    ${stats ? formatUSDC(stats.vaultPositionInAave) : '--'}
                  </p>
                  <p className="text-xs text-muted-foreground">Vault's Aave balance</p>
                </div>
              </div>
            </div>
          </section>

          {/* Contract Addresses */}
          <section>
            <h2 className="text-xl font-semibold mb-4">Contract Addresses</h2>
            <div className="card">
              <div className="space-y-3">
                {addresses && (
                  <>
                    <div className="flex justify-between items-center py-2 border-b border-border">
                      <span className="text-sm text-muted-foreground">USDC</span>
                      <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                        {truncateAddress(addresses.usdc)}
                      </code>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b border-border">
                      <span className="text-sm text-muted-foreground">Armada Yield Vault (ayUSDC)</span>
                      <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                        {truncateAddress(addresses.armadaYieldVault)}
                      </code>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b border-border">
                      <span className="text-sm text-muted-foreground">Armada Yield Adapter</span>
                      <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                        {truncateAddress(addresses.armadaYieldAdapter)}
                      </code>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b border-border">
                      <span className="text-sm text-muted-foreground">Armada Treasury</span>
                      <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                        {truncateAddress(addresses.armadaTreasury)}
                      </code>
                    </div>
                    <div className="flex justify-between items-center py-2">
                      <span className="text-sm text-muted-foreground">Mock Aave Spoke</span>
                      <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                        {truncateAddress(addresses.mockAaveSpoke)}
                      </code>
                    </div>
                  </>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      <div className="min-h-12" />
    </div>
  )
}
