import { useMemo } from 'react'
import { Button } from '@/components/common/Button'
import { AlertBox } from '@/components/common/AlertBox'
import { useWallet } from '@/hooks/useWallet'

export function WalletSelector() {
  const {
    connectMetaMask,
    state,
    error,
    isMetaMaskAvailable,
  } = useWallet()

  const isMetaMaskConnecting = state.metaMask.isConnecting
  const truncatedEvmAddress = useMemo(() => {
    if (!state.metaMask.account) return undefined
    return `${state.metaMask.account.slice(0, 6)}...${state.metaMask.account.slice(-4)}`
  }, [state.metaMask.account])

  return (
    <div className="space-y-4">
      <AlertBox tone="info" title="Wallet connection">
        Connect MetaMask for EVM flows. Availability is detected automatically.
      </AlertBox>
      <div className="grid gap-4">
        <section className="space-y-3 card card-opacity">
          <header className="space-y-1">
            <h3 className="text-base font-semibold">MetaMask</h3>
            <p className="text-sm text-muted-foreground">
              EVM chains for deposits and outbound payments.
            </p>
          </header>
          <Button
            onClick={connectMetaMask}
            disabled={!isMetaMaskAvailable || isMetaMaskConnecting}
            variant={isMetaMaskAvailable ? 'primary' : 'ghost'}
          >
            {isMetaMaskAvailable ? (
              isMetaMaskConnecting ? (
                'Connecting...'
              ) : state.metaMask.isConnected ? (
                'Reconnect MetaMask'
              ) : (
                <>
                  <img src="/assets/logos/metamask-logo.svg" alt="MetaMask" className="h-4 w-4" />
                  <span>Connect MetaMask</span>
                </>
              )
            ) : (
              'MetaMask Not Detected'
            )}
          </Button>
          {state.metaMask.isConnected && state.metaMask.account ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="truncate">Connected: {truncatedEvmAddress}</p>
              {state.metaMask.chainId ? <p>Chain ID: {state.metaMask.chainId}</p> : null}
            </div>
          ) : null}
        </section>
      </div>
      {error ? (
        <AlertBox tone="error" title="Wallet Error">
          {error}
        </AlertBox>
      ) : null}
    </div>
  )
}
