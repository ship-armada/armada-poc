// ABOUTME: Maps wagmi / RainbowKit connector ids to WalletPillMenu provider keys.

import type { Connector } from 'wagmi'

export function walletProviderFromConnector(connector?: Connector): string | undefined {
  const id = connector?.id?.toLowerCase() ?? ''
  const name = connector?.name?.toLowerCase() ?? ''
  const haystack = `${id} ${name}`
  if (haystack.includes('metamask')) return 'metamask'
  if (haystack.includes('phantom')) return 'phantom'
  if (haystack.includes('walletconnect')) return 'walletconnect'
  return undefined
}
