import { useWallet } from '@/hooks/useWallet'
import { Button } from '@/components/common/Button'

export function AccountDisplay() {
  const { state, disconnect } = useWallet()
  const hasConnections = state.metaMask.isConnected

  if (!hasConnections) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
        No wallet connected
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-col text-sm">
        {state.metaMask.isConnected && state.metaMask.account ? (
          <span className="font-medium">EVM: {state.metaMask.account}</span>
        ) : null}
      </div>
      <Button variant="ghost" onClick={disconnect} aria-label="Disconnect wallet">
        Disconnect
      </Button>
    </div>
  )
}
