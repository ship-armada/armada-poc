// ABOUTME: Renders the connected wallet provider's brand glyph (MetaMask / Phantom / WalletConnect).
// ABOUTME: Provider name is matched case-insensitively by substring so wagmi connector names resolve loosely; falls back to a generic wallet icon.

import { WalletIcon } from '@heroicons/react/24/outline'
import WalletMetamask from '@web3icons/react/icons/wallets/WalletMetamask'
import WalletPhantom from '@web3icons/react/icons/wallets/WalletPhantom'
import WalletWalletConnect from '@web3icons/react/icons/wallets/WalletWalletConnect'

export interface WalletProviderIconProps {
  provider?: string
  size?: number
}

export function WalletProviderIcon({ provider, size = 16 }: WalletProviderIconProps) {
  const name = provider?.toLowerCase() ?? ''
  if (name.includes('metamask')) return <WalletMetamask size={size} aria-hidden />
  if (name.includes('phantom')) return <WalletPhantom size={size} aria-hidden />
  if (name.includes('walletconnect')) return <WalletWalletConnect size={size} aria-hidden />
  return <WalletIcon width={size} height={size} aria-hidden />
}
