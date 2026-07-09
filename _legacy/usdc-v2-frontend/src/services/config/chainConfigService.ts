import type { EvmChainsFile } from '@/config/chains'
import { isSepoliaMode } from '@/config/networkConfig'

const CHAINS_ENDPOINT = isSepoliaMode() ? '/evm-chains-sepolia.json' : '/evm-chains.json'

export async function fetchEvmChainsConfig(): Promise<EvmChainsFile> {
  const response = await fetch(CHAINS_ENDPOINT, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to load chain configuration (${response.status})`)
  }

  const payload = (await response.json()) as EvmChainsFile
  return payload
}

