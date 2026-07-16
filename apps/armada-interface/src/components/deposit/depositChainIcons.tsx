// ABOUTME: Maps chain IDs from network config to @web3icons/react network icons (crowdfund DepositAmountCard parity).
// ABOUTME: Unknown chains (e.g. local Anvil) return null — DepositAmountCard falls back to a letter avatar.

import NetworkArbitrumSepolia from '@web3icons/react/icons/networks/NetworkArbitrumSepolia'
import NetworkBaseSepolia from '@web3icons/react/icons/networks/NetworkBaseSepolia'
import NetworkEthereum from '@web3icons/react/icons/networks/NetworkEthereum'
import NetworkSepolia from '@web3icons/react/icons/networks/NetworkSepolia'

type NetworkIcon = typeof NetworkSepolia

const ICON_BY_CHAIN_ID: Readonly<Record<number, NetworkIcon>> = {
  11155111: NetworkSepolia,
  84532: NetworkBaseSepolia,
  421614: NetworkArbitrumSepolia,
  31337: NetworkEthereum,
  31338: NetworkEthereum,
  31339: NetworkEthereum,
}

export function chainIconForChainId(chainId: number): NetworkIcon | null {
  return ICON_BY_CHAIN_ID[chainId] ?? null
}
