// ABOUTME: Committer mobile wallet circle + WalletMenuSheet (copy / disconnect) for hero header.
// ABOUTME: Replaces the full-screen burger wallet block on bare CrowdfundExperience pages.

import { useId, useState } from 'react'
import { WalletIcon } from '@heroicons/react/24/outline'
import { WalletMetamask, WalletPhantom, WalletWalletConnect } from '@web3icons/react'
import { useAccount, useDisconnect } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Button as ArmadaButton, WalletMenuSheet } from '@armada/ui'

const WALLET_TRIGGER_ICON_PX = 22

/** Map a wagmi connector id to the designer's `@web3icons` provider switch. */
function detectWalletProvider(connectorId?: string): string | undefined {
  if (!connectorId) return undefined
  const id = connectorId.toLowerCase()
  if (id.includes('metamask')) return 'metamask'
  if (id.includes('phantom')) return 'phantom'
  if (id.includes('walletconnect')) return 'walletconnect'
  return undefined
}

function MobileWalletTriggerIcon({
  provider,
  size = WALLET_TRIGGER_ICON_PX,
}: {
  provider?: string
  size?: number
}) {
  switch (provider) {
    case 'metamask':
      return <WalletMetamask size={size} aria-hidden />
    case 'phantom':
      return <WalletPhantom size={size} aria-hidden />
    case 'walletconnect':
      return <WalletWalletConnect size={size} aria-hidden />
    default:
      return <WalletIcon width={size} height={size} aria-hidden />
  }
}

/** Mockup convention is 6 chars before the ellipsis ("0x1234...abcd"). */
function truncate6(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export interface CommitterMobileWalletProps {
  /** Connected wallet USDC balance (6 decimals). */
  usdcBalance: bigint
}

export function CommitterMobileWallet({ usdcBalance }: CommitterMobileWalletProps) {
  const { connector } = useAccount()
  const { disconnect } = useDisconnect()
  const [walletSheetOpen, setWalletSheetOpen] = useState(false)
  const walletSheetId = useId()

  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, authenticationStatus, openConnectModal, openChainModal }) => {
        const isReady = mounted && authenticationStatus !== 'loading'
        const isConnected =
          isReady &&
          account &&
          chain &&
          (!authenticationStatus || authenticationStatus === 'authenticated')

        if (!isReady) {
          return (
            <ArmadaButton
              variant="secondary"
              size="sm"
              label="…"
              showIcon={false}
              disabled
            />
          )
        }

        if (!isConnected) {
          return (
            <ArmadaButton
              variant="secondary"
              size="sm"
              label="Connect"
              showIcon={false}
              onClick={openConnectModal}
            />
          )
        }

        if (chain.unsupported) {
          return (
            <ArmadaButton
              variant="secondary"
              size="sm"
              label="Network"
              showIcon={false}
              onClick={openChainModal}
            />
          )
        }

        const provider = detectWalletProvider(connector?.id)
        const displayAddress = account.displayName.startsWith('0x')
          ? truncate6(account.address)
          : account.displayName
        const balanceWhole = Number(usdcBalance / 1_000_000n)

        return (
          <MobileWalletConnected
            sheetId={walletSheetId}
            open={walletSheetOpen}
            onOpenChange={setWalletSheetOpen}
            provider={provider}
            displayAddress={displayAddress}
            copyAddress={account.address}
            usdcBalance={balanceWhole}
            onDisconnect={() => disconnect()}
          />
        )
      }}
    </ConnectButton.Custom>
  )
}

function MobileWalletConnected({
  sheetId,
  open,
  onOpenChange,
  provider,
  displayAddress,
  copyAddress,
  usdcBalance,
  onDisconnect,
}: {
  sheetId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  provider?: string
  displayAddress: string
  copyAddress: string
  usdcBalance: number
  onDisconnect: () => void
}) {
  return (
    <>
      <button
        type="button"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border-0 bg-white/16 p-0 text-white hover:bg-white/24 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        aria-expanded={open}
        aria-controls={sheetId}
        aria-haspopup="dialog"
        aria-label={open ? 'Close wallet menu' : 'Open wallet menu'}
        onClick={() => onOpenChange(!open)}
      >
        <MobileWalletTriggerIcon provider={provider} />
      </button>
      <WalletMenuSheet
        id={sheetId}
        open={open}
        onClose={() => onOpenChange(false)}
        walletAddress={displayAddress}
        walletCopyAddress={copyAddress}
        walletProvider={provider}
        usdcBalance={usdcBalance}
        onDisconnect={onDisconnect}
      />
    </>
  )
}
