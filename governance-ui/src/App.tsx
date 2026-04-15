// ABOUTME: Top-level app component for the governance test UI.
// ABOUTME: Provides tab navigation, account selector, time control, and event log.

import { useState } from 'react'
import { useWallet } from './hooks/useWallet'
import { useGovernanceContracts } from './hooks/useGovernanceContracts'
import { useGovernanceData } from './hooks/useGovernanceData'
import { TimeControlBar } from './components/TimeControlBar'
import { TokenPanel } from './components/TokenPanel'
import { ProposalsPanel } from './components/ProposalsPanel'
import { TreasuryPanel } from './components/TreasuryPanel'
import { StewardPanel } from './components/StewardPanel'
import { EventLog } from './components/EventLog'
import { RevenueLockPanel } from './components/RevenueLockPanel'
import { getNetworkMode, isSepoliaMode } from './config'

type Tab = 'tokens' | 'proposals' | 'treasury' | 'steward' | 'revenueLock'

const TABS: { key: Tab; label: string }[] = [
  { key: 'tokens', label: 'Tokens & Voting' },
  { key: 'proposals', label: 'Proposals' },
  { key: 'treasury', label: 'Treasury' },
  { key: 'steward', label: 'Steward' },
  { key: 'revenueLock', label: 'Revenue Lock' },
]

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('tokens')
  const wallet = useWallet()
  const contracts = useGovernanceContracts()
  const govData = useGovernanceData(contracts, wallet.account)

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-neutral-200">
      {/* Header */}
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Armada Governance</h1>
            <p className="text-xs text-neutral-500">
              Test UI &middot; {getNetworkMode()} mode
            </p>
          </div>
          <div className="flex items-center gap-4">
            {/* Security Council Status */}
            {govData.securityCouncil && (
              <div className="flex items-center gap-1.5 text-xs">
                <span className={`inline-block h-2 w-2 rounded-full ${govData.isSecurityCouncilEjected ? 'bg-red-500' : 'bg-green-500'}`} />
                <span className="text-neutral-500">SC:</span>
                <span className="font-mono text-neutral-400">
                  {govData.isSecurityCouncilEjected
                    ? 'Ejected'
                    : `${govData.securityCouncil.slice(0, 6)}...${govData.securityCouncil.slice(-4)}`}
                </span>
              </div>
            )}
            {contracts.error && (
              <span className="text-xs text-red-400">{contracts.error}</span>
            )}
            {/* Account Selector */}
            {!isSepoliaMode() ? (
              <AnvilAccountSelector wallet={wallet} />
            ) : (
              <MetaMaskConnector wallet={wallet} />
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-4">
        {/* Time Control */}
        <TimeControlBar onTimeChanged={govData.refresh} />

        {/* Tab Navigation */}
        <div className="mt-4 flex gap-1 border-b border-neutral-800">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === key
                  ? 'border-b-2 border-blue-500 text-white'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="mt-4">
          {activeTab === 'tokens' && (
            <TokenPanel
              contracts={contracts}
              wallet={wallet}
              govData={govData}
            />
          )}
          {activeTab === 'proposals' && (
            <ProposalsPanel
              contracts={contracts}
              wallet={wallet}
              govData={govData}
            />
          )}
          {activeTab === 'treasury' && (
            <TreasuryPanel
              contracts={contracts}
              wallet={wallet}
              govData={govData}
            />
          )}
          {activeTab === 'steward' && (
            <StewardPanel
              contracts={contracts}
              wallet={wallet}
              govData={govData}
            />
          )}
          {activeTab === 'revenueLock' && (
            <RevenueLockPanel
              contracts={contracts}
              wallet={wallet}
              govData={govData}
            />
          )}
        </div>

        {/* Event Log */}
        <EventLog contracts={contracts} />
      </div>
    </div>
  )
}

/** Dropdown to select between predefined Anvil accounts (local mode) */
function AnvilAccountSelector({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  return (
    <div className="flex items-center gap-3">
      <select
        value={wallet.anvilAccount?.index ?? 0}
        onChange={(e) => {
          const idx = Number(e.target.value)
          const acct = wallet.anvilAccounts.find((a) => a.index === idx)
          if (acct) wallet.selectAnvilAccount(acct)
        }}
        className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 border border-neutral-700 focus:border-blue-500 focus:outline-none"
      >
        {wallet.anvilAccounts.map((acct) => (
          <option key={acct.index} value={acct.index}>
            #{acct.index} {acct.label} ({acct.address.slice(0, 6)}...{acct.address.slice(-4)})
          </option>
        ))}
      </select>
      {wallet.anvilAccount && (
        <div className="flex items-center gap-1">
          <code className="rounded bg-neutral-900 px-2 py-1 text-xs text-neutral-400">
            {wallet.anvilAccount.address}
          </code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(wallet.anvilAccount!.address)
            }}
            className="rounded bg-neutral-800 px-1.5 py-1 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 border border-neutral-700 transition-colors"
            title="Copy address"
          >
            Copy
          </button>
        </div>
      )}
    </div>
  )
}

/** MetaMask connect/disconnect button (Sepolia mode) */
function MetaMaskConnector({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  if (wallet.account) {
    return (
      <div className="flex items-center gap-3">
        <code className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
          {wallet.account.slice(0, 6)}...{wallet.account.slice(-4)}
        </code>
        <span className="text-xs text-neutral-500">
          Chain {wallet.chainId}
        </span>
        <button
          onClick={wallet.disconnect}
          className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-700"
        >
          Disconnect
        </button>
      </div>
    )
  }
  return (
    <button
      onClick={wallet.connectMetaMask}
      className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
    >
      Connect MetaMask
    </button>
  )
}
