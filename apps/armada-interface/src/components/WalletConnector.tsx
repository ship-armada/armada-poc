// ABOUTME: Header wallet control — RainbowKit connect flow; connected state uses crowdfund-parity WalletPillMenu.

import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import { WalletButton, WalletPillMenu } from '@armada/ui'
import { useBalances } from '@/hooks/useBalances'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { truncateAddress } from '@/lib/format'
import { walletProviderFromConnector } from '@/lib/walletProvider'
import { ShieldedIdentitySection } from './ShieldedIdentitySection'
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
  // V2 Phase 3a: the EVM + shielded addresses share one pill. We only render the shielded
  // section when the consuming app actually has a shielded-wallet record on hand; collapsing
  // to undefined keeps the WalletPillMenu's dropdown looking native for the non-shielded path
  // (which is unreachable from this component in practice — armada-interface always has a
  // shielded wallet by the time WalletConnector is mounted in AppLayout — but kept defensive).
  const shielded = useShieldedWallet()
  const hasShieldedWallet = shielded.state !== null && shielded.state !== undefined

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
            extraSection={hasShieldedWallet ? <ShieldedIdentitySection /> : undefined}
          />
        )
      }}
    </ConnectButton.Custom>
  )
}
