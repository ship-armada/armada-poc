// ABOUTME: Header wallet control — RainbowKit connect flow; connected state uses crowdfund-parity WalletPillMenu.

import { useMemo } from 'react'
import { Loader2, LogIn } from 'lucide-react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import { Button, WalletButton, WalletPillMenu } from '@/design'
import { useBalances } from '@/hooks/useBalances'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { truncateAddress, truncateAddressEnds } from '@/lib/format'
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
  // When the shielded wallet is unlocked, surface a truncated 0zk... underneath the EVM
  // address in the pill trigger (V2 Phase 3a — the EVM + shielded addresses are 1:1
  // representations of one identity). When locked or never-unlocked, the trigger stays
  // single-row so the user isn't shown a stale shielded address from a prior session.
  const shieldedDisplay =
    shielded.state?.status === 'unlocked' && shielded.state.shieldedAddress
      ? truncateAddressEnds(shielded.state.shieldedAddress, 6, 4)
      : undefined

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
          // V2 redesign: the disconnected-state pill uses the same `secondary md` chrome as the
          // connected `WalletPillMenu` trigger (solid black bg via `styles.trigger`), so the
          // transition from "Connect Wallet" → "0xabcd…1234" reads as a state change on the
          // same pill rather than a swap to a different component. Replaces the legacy
          // `WalletButton` whose built-in radial-gradient circle icon no longer fits the design.
          return (
            <Button
              variant="secondary"
              size="md"
              label="Connect Wallet"
              showIcon={false}
              leadingIcon={<LogIn aria-hidden="true" width={16} height={16} />}
              onClick={openConnectModal}
              className={styles.trigger}
            />
          )
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
            shieldedAddress={shieldedDisplay}
          />
        )
      }}
    </ConnectButton.Custom>
  )
}
