import { useState, useCallback } from 'react'
import {
  ArrowDownLeft,
  Send,
  Shield,
  ShieldCheck,
  Loader2,
  Lock,
  TrendingUp,
} from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { RequireMetaMaskConnection } from '@/components/wallet/RequireMetaMaskConnection'
import { useTransactionQueryParam } from '@/hooks/useTransactionQueryParam'
import { useTransactionCompletionMonitor } from '@/hooks/useTransactionCompletionMonitor'
import { useTxAnimationState } from '@/hooks/useTxAnimationState'
import { RecentActivitySection } from '@/components/dashboard/RecentActivitySection'
import {
  WelcomePanel,
  DepositPanel,
  SendPanel,
  EarnPanel,
} from '@/components/dashboard/panels'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { Button } from '@/components/common/Button'

type ActivePanel = 'none' | 'deposit' | 'send' | 'earn'

export function Dashboard() {
  const [openModalTxId, setOpenModalTxId] = useState<string | null>(null)
  const [historyReloadTrigger, setHistoryReloadTrigger] = useState(0)
  const [activePanel, setActivePanel] = useState<ActivePanel>('none')

  // Shielded wallet state
  const {
    status: shieldedStatus,
    railgunAddress,
    formattedBalance: shieldedBalance,
    formattedUsdcBalance,
    formattedYieldAssets,
    hasYieldPosition,
    isScanning,
    error: shieldedError,
    unlock,
    lock,
  } = useShieldedWallet()

  // Handle transaction query parameter
  useTransactionQueryParam(
    useCallback((txId: string) => {
      setOpenModalTxId(txId)
    }, []),
  )

  // Initialize animation state management
  useTxAnimationState()

  // Monitor transaction completion
  useTransactionCompletionMonitor({
    openModalTxId,
    onTransactionCompleted: useCallback(() => {
      setHistoryReloadTrigger((prev) => prev + 1)
    }, []),
  })

  return (
    <RequireMetaMaskConnection message="Please connect your MetaMask wallet to view your balances and perform transactions.">
      <div className="flex flex-col gap-6 p-12 mx-auto w-full container">
        {/* Main Layout: Left column (balance + actions + activity) | Right column (panels) */}
        <div className="flex flex-col lg:flex-row gap-6 mb-12 items-start">
          {/* Left Column */}
          <div className="flex flex-col gap-6 w-full lg:w-[450px] flex-shrink-0">
            {/* Balance Card */}
            <div className="card bg-muted/50 card-xl card-shadow-xs">
              <div className="flex flex-col gap-6">
                {/* Shielded Balance Section */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {shieldedStatus === 'unlocked' ? (
                      <ShieldCheck className="h-5 w-5 text-primary" />
                    ) : (
                      <Shield className="h-5 w-5 text-muted-foreground" />
                    )}
                    <div>
                      <p className="text-sm text-muted-foreground">
                        Shielded USDC Balance
                      </p>
                      {shieldedStatus === 'unlocked' ? (
                        <div className="flex items-center gap-2">
                          <p className="text-3xl font-bold">
                            ${shieldedBalance}
                          </p>
                          {isScanning && (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          )}
                        </div>
                      ) : (
                        <p className="text-3xl font-bold text-muted-foreground">
                          --
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Unlock/Lock Button */}
                  <div className="flex flex-col items-end gap-2">
                    {shieldedStatus === 'disconnected' ? (
                      <p className="text-xs text-muted-foreground">
                        Connect wallet first
                      </p>
                    ) : shieldedStatus === 'unlocking' ? (
                      <Button
                        variant="secondary"
                        disabled
                        className="min-w-[120px]"
                      >
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Unlocking...
                      </Button>
                    ) : shieldedStatus === 'unlocked' ? (
                      <Button
                        variant="ghost"
                        onClick={lock}
                        className="min-w-[120px]"
                      >
                        <Lock className="h-4 w-4" />
                        Lock
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        onClick={unlock}
                        className="min-w-[120px]"
                      >
                        <img
                          src="/assets/symbols/glyph1.png"
                          alt=""
                          className="h-5 w-5"
                        />
                        Unlock Shielded
                      </Button>
                    )}
                  </div>
                </div>

                {/* Yield Position Breakdown (when unlocked and has yield) */}
                {shieldedStatus === 'unlocked' && hasYieldPosition && (
                  <div className="flex flex-col gap-2 px-3 py-2 bg-success/5 border border-success/20 rounded-md">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-success" />
                      <p className="text-xs font-medium text-success">Earning Yield</p>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Idle USDC:</span>
                      <span className="font-mono">${formattedUsdcBalance}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">In Yield (ayUSDC):</span>
                      <span className="font-mono text-success">${formattedYieldAssets}</span>
                    </div>
                  </div>
                )}

                {/* Railgun Address (when unlocked) */}
                {shieldedStatus === 'unlocked' && railgunAddress && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-md">
                    <p className="text-xs text-muted-foreground">
                      Railgun Address:
                    </p>
                    <p className="text-xs font-mono text-foreground truncate">
                      {railgunAddress.slice(0, 20)}...{railgunAddress.slice(-8)}
                    </p>
                  </div>
                )}

                {/* Error Display */}
                {shieldedError && (
                  <div className="px-3 py-2 bg-error/10 text-error-foreground rounded-md">
                    <p className="text-xs">{shieldedError}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3">
              <Button
                variant={activePanel === 'deposit' ? 'primary' : 'secondary'}
                onClick={() =>
                  setActivePanel(activePanel === 'deposit' ? 'none' : 'deposit')
                }
                className="flex-1"
              >
                <ArrowDownLeft className="h-4 w-4" />
                Deposit
              </Button>
              <Button
                variant={activePanel === 'send' ? 'primary' : 'secondary'}
                onClick={() =>
                  setActivePanel(activePanel === 'send' ? 'none' : 'send')
                }
                className="flex-1"
              >
                <Send className="h-4 w-4" />
                Send
              </Button>
              <Button
                variant={activePanel === 'earn' ? 'primary' : 'secondary'}
                onClick={() =>
                  setActivePanel(activePanel === 'earn' ? 'none' : 'earn')
                }
                className="flex-1"
              >
                <TrendingUp className="h-4 w-4" />
                Earn
              </Button>
            </div>

            {/* Recent Activity */}
            <RecentActivitySection
              openModalTxId={openModalTxId}
              onModalOpenChange={setOpenModalTxId}
              reloadTrigger={historyReloadTrigger}
            />
          </div>

          {/* Right Column: Panels */}
          <div className="w-full lg:flex-1">
            <AnimatePresence mode="wait">
              <motion.div
                key={activePanel}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
              >
                {activePanel === 'none' && <WelcomePanel />}
                {activePanel === 'deposit' && (
                  <DepositPanel onClose={() => setActivePanel('none')} />
                )}
                {activePanel === 'send' && (
                  <SendPanel onClose={() => setActivePanel('none')} />
                )}
                {activePanel === 'earn' && (
                  <EarnPanel onClose={() => setActivePanel('none')} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <div className="min-h-12" />
      </div>
    </RequireMetaMaskConnection>
  )
}
