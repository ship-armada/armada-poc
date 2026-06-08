// ABOUTME: Header wallet control — RainbowKit connect flow; connected state uses crowdfund-parity WalletPillMenu.

import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import { WalletButton, WalletPillMenu } from '@armada/ui'
import { useBalances } from '@/hooks/useBalances'
import { truncateAddress } from '@/lib/format'
import { walletProviderFromConnector } from '@/lib/walletProvider'
import styles from './WalletConnector.module.css'

function totalUnshieldedUsdc(unshielded: Record<number, bigint>): number {
  let sum = 0n
  for (const amount of Object.values(unshielded)) {
    sum += amount
  }
  return Number(sum) / 1e6
}

export function WalletConnector() {
  const { connector } = useAccount()
  const { disconnect } = useDisconnect()
  const { unshielded } = useBalances()
  const usdcBalance = useMemo(() => totalUnshieldedUsdc(unshielded), [unshielded])
  const walletProvider = walletProviderFromConnector(connector)

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        authenticationStatus,
        openChainModal,
        openConnectModal,
      }) => {
        const isReady = mounted && authenticationStatus !== 'loading'
        const isConnected =
          isReady
          && account
          && chain
          && (!authenticationStatus || authenticationStatus === 'authenticated')

        if (!isReady) {
          return (
            <WalletButton
              label="Connecting..."
              icon={<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              disabled
              ariaLabel="Wallet connecting"
            />
          )
        }

        if (!isConnected) {
          return <WalletButton label="Connect Wallet" onClick={openConnectModal} />
        }

        if (chain.unsupported) {
          return (
            <WalletButton
              label="Wrong network"
              variant="destructive"
              onClick={openChainModal}
              ariaLabel="Wrong network — click to switch"
            />
          )
        }

        const displayAddress = account.displayName.startsWith('0x')
          ? truncateAddress(account.address)
          : account.displayName

        return (
          <WalletPillMenu
            displayAddress={displayAddress}
            copyAddress={account.address}
            walletProvider={walletProvider}
            usdcBalance={usdcBalance}
            onDisconnect={() => disconnect()}
            triggerClassName={styles.trigger}
          />
        )
      }}
    </ConnectButton.Custom>
  )
}
