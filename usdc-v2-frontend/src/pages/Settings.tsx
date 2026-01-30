import { useState, useEffect } from 'react'
import { useAtom } from 'jotai'
import { Link } from 'react-router-dom'
import { List, Trash2 } from 'lucide-react'
// import { BreadcrumbNav } from '@/components/common/BreadcrumbNav'
import { Spinner } from '@/components/common/Spinner'
import { Button } from '@/components/common/Button'
import { ChainUrlSettings } from '@/components/settings/ChainUrlSettings'
import { CollapsibleChainSection } from '@/components/settings/CollapsibleChainSection'
import { ClearTransactionHistoryDialog } from '@/components/settings/ClearTransactionHistoryDialog'
import { ThemeToggle } from '@/components/common/ThemeToggle'
import { customEvmChainUrlsAtom, type CustomChainUrls } from '@/atoms/customChainUrlsAtom'
import { txAtom } from '@/atoms/txAtom'
import { saveCustomChainUrls, loadCustomChainUrls } from '@/services/storage/customChainUrlsStorage'
import { fetchEvmChainsConfig } from '@/services/config/chainConfigService'
import { transactionStorageService } from '@/services/tx/transactionStorageService'
import { useToast } from '@/hooks/useToast'
import { logger } from '@/utils/logger'

export function Settings() {
  const [evmCustomUrls, setEvmCustomUrls] = useAtom(customEvmChainUrlsAtom)
  const [, setTxState] = useAtom(txAtom)
  const [isLoading, setIsLoading] = useState(true)
  const [evmChains, setEvmChains] = useState<Awaited<ReturnType<typeof fetchEvmChainsConfig>> | null>(null)
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false)
  const { notify } = useToast()

  // Load chain configs and custom URLs on mount
  useEffect(() => {
    async function loadData() {
      try {
        setIsLoading(true)
        const [evmConfig, storedUrls] = await Promise.all([
          fetchEvmChainsConfig(),
          Promise.resolve(loadCustomChainUrls()),
        ])

        setEvmChains(evmConfig)

        // Load custom URLs from storage into atoms
        if (storedUrls) {
          if (storedUrls.evm && Object.keys(storedUrls.evm).length > 0) {
            setEvmCustomUrls(storedUrls.evm)
          }
        }
      } catch (error) {
        logger.error('[Settings] Failed to load chain configs', { error })
        notify({
          level: 'error',
          title: 'Failed to load settings',
          description: 'Could not load chain configurations. Please refresh the page.',
        })
      } finally {
        setIsLoading(false)
      }
    }

    loadData()
  }, [setEvmCustomUrls, notify])

  const handleUpdateUrl = (chainKey: string, _chainType: 'evm', urls: CustomChainUrls) => {
    const updated = { ...evmCustomUrls, [chainKey]: urls }
    setEvmCustomUrls(updated)
    saveCustomChainUrls({
      evm: updated,
    })
    notify({
      level: 'success',
      title: 'Settings saved',
      description: `Custom URLs for ${chainKey} have been saved.`,
    })
  }

  const handleRestoreDefault = (chainKey: string, _chainType: 'evm') => {
    const updated = { ...evmCustomUrls }
    delete updated[chainKey]
    setEvmCustomUrls(updated)
    saveCustomChainUrls({
      evm: updated,
    })
    notify({
      level: 'success',
      title: 'Default restored',
      description: `Restored default URLs for ${chainKey}.`,
    })
  }

  const handleClearTransactionHistory = () => {
    try {
      // Clear from storage
      transactionStorageService.clearAll()

      // Clear from atom state
      setTxState({
        activeTransaction: undefined,
        history: [],
      })

      logger.info('[Settings] Transaction history cleared')
      notify({
        level: 'success',
        title: 'Transaction history cleared',
        description: 'All transaction history has been permanently deleted.',
      })
    } catch (error) {
      logger.error('[Settings] Failed to clear transaction history', { error })
      notify({
        level: 'error',
        title: 'Failed to clear history',
        description: 'Could not clear transaction history. Please try again.',
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="container mx-auto p-12">

      {/* <div className="mb-10">
        <BreadcrumbNav />
      </div> */}

      <header className="space-y-2 mb-10">
        <p className="text-muted-foreground">
          Manage app settings and preferences
        </p>
      </header>

      <div className="space-y-8 mx-auto">
        {/* Configure Chains Section */}
        <section>
          <h2 className="mb-4 text-2xl font-semibold">Configure Chains</h2>
          <div className="space-y-4">
            {/* EVM Chains Section */}
            {evmChains && evmChains.chains.length > 0 && (
              <CollapsibleChainSection
                title="Configure EVM chain URLs"
                chainCount={evmChains.chains.length}
                defaultOpen={false}
              >
                {evmChains.chains.map((chain) => (
                  <ChainUrlSettings
                    key={chain.key}
                    chainKey={chain.key}
                    chainName={chain.name}
                    chainType="evm"
                    defaultUrls={{
                      rpcUrl: chain.rpcUrls?.[0],
                    }}
                    customUrls={evmCustomUrls[chain.key] || {}}
                    onUpdate={(key, urls) => handleUpdateUrl(key, 'evm', urls)}
                    onRestoreDefault={(key) => handleRestoreDefault(key, 'evm')}
                  />
                ))}
              </CollapsibleChainSection>
            )}
          </div>
        </section>

        {/* Address Book Section */}
        <section>
          <h2 className="mb-4 text-2xl font-semibold">Address Book</h2>
          <div className="card">
            <div className="flex justify-between items-baseline">
              <div className="flex-1">
                <p className="mb-2 text-sm text-muted-foreground">
                  Save and manage frequently used addresses for quick access.
                </p>
              </div>
              <Link to="/address-book">
                <Button variant="primary" className="gap-2 w-72">
                  <List className="h-4 w-4" />
                  <span>Manage Address Book</span>
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Appearance Settings Section */}
        <section>
          <h2 className="mb-4 text-2xl font-semibold">Appearance</h2>
          <div className="card">
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <label htmlFor="theme-toggle" className="text-sm font-medium cursor-pointer">
                  Theme:
                </label>
                <p className="text-sm text-muted-foreground">
                  Switch between light and dark mode
                </p>
              </div>
              <ThemeToggle />
            </div>
          </div>
        </section>

        {/* App Data Section */}
        <section>
          <h2 className="mb-4 text-2xl font-semibold">App Data</h2>
          <div className="card space-y-3">
            <div className="flex flex-col gap-3">
              <div className="flex justify-between items-baseline">
                <p className="text-sm text-muted-foreground">
                  Clear all stored transaction history.
                </p>
                <Button
                  variant="primary"
                  className="gap-2 w-72"
                  onClick={() => setIsClearDialogOpen(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  <span>Clear transaction history</span>
                </Button>
              </div>
            </div>
          </div>
        </section>
        <div className="min-h-12" />
      </div>

      {/* Clear Transaction History Dialog */}
      <ClearTransactionHistoryDialog
        open={isClearDialogOpen}
        onClose={() => setIsClearDialogOpen(false)}
        onConfirm={handleClearTransactionHistory}
      />
    </div>
  )
}
