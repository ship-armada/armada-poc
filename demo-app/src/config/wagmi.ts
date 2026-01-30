import { http, createConfig } from 'wagmi';
import { defineChain } from 'viem';
import { injected } from 'wagmi/connectors';

// Define local devnet chains
// Hub uses 31337 and port 8545 to match Railgun SDK's Hardhat network config
export const hubChain = defineChain({
  id: 31337,
  name: 'Hub Chain',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: ['http://localhost:8545'],
    },
  },
});

export const clientAChain = defineChain({
  id: 31338,
  name: 'Client A',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: ['http://localhost:8546'],
    },
  },
});

export const clientBChain = defineChain({
  id: 31339,
  name: 'Client B',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: ['http://localhost:8547'],
    },
  },
});

// All supported chains
export const supportedChains = [hubChain, clientAChain, clientBChain] as const;

// Wagmi config
export const wagmiConfig = createConfig({
  chains: supportedChains,
  connectors: [
    injected(),
  ],
  transports: {
    [hubChain.id]: http(),
    [clientAChain.id]: http(),
    [clientBChain.id]: http(),
  },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
