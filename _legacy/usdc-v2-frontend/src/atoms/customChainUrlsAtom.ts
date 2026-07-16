import { atom } from 'jotai'

/**
 * Custom URL configuration for a chain
 */
export interface CustomChainUrls {
  rpcUrl?: string
}

/**
 * Custom URLs for EVM chains
 * Key: chain key (e.g., 'sepolia', 'base-sepolia')
 */
export const customEvmChainUrlsAtom = atom<Record<string, CustomChainUrls>>({})

