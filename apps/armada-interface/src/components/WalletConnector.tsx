// ABOUTME: Header wallet control — RainbowKit connect flow; connected state renders the WalletMenu pill + side panel.

import { useMemo } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Loader2, LogIn } from 'lucide-react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import { Button, WalletButton } from '@/design'
import { WalletMenu } from '@/components/WalletMenu'
import { useBalances } from '@/hooks/useBalances'
import { openModalAtom, balanceHiddenAtom } from '@/state/ui'
import { getChainById } from '@/config/network'
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
  const setOpenModal = useSetAtom(openModalAtom)
  const [balanceHidden, setBalanceHidden] = useAtom(balanceHiddenAtom)

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
          // connected `WalletMenu` trigger (solid black bg via `styles.trigger`), so the
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

        // Address explorer link — chain explorer base + /address/<addr>. Undefined on local Anvil
        // (no explorer), which disables the "View on explorer" action in the panel.
        const explorerBase = getChainById(chain.id)?.explorerUrl
        const explorerUrl = explorerBase ? `${explorerBase}/address/${account.address}` : undefined
        const networkLabel = chain.name ?? getChainById(chain.id)?.name ?? `Chain ${chain.id}`

        return (
          <WalletMenu
            displayAddress={displayAddress}
            fullAddress={account.address}
            walletProvider={walletProvider}
            chainId={chain.id}
            usdcBalance={usdcBalance}
            networkLabel={networkLabel}
            explorerUrl={explorerUrl}
            balanceHidden={balanceHidden}
            onBalanceHiddenChange={setBalanceHidden}
            onDisconnect={() => disconnect()}
            onDeposit={() => setOpenModal('shield')}
            triggerClassName={styles.trigger}
          />
        )
      }}
    </ConnectButton.Custom>
  )
}
