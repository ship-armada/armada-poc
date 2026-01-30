import chainsConfig from './chains.json';

export interface ChainConfig {
  id: number;
  name: string;
  type: 'hub' | 'client';
  rpcUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  contracts?: {
    mockUSDC?: string;            // MockUSDCV2 token address
    privacyPool?: string;         // Hub: PrivacyPool contract
    privacyPoolClient?: string;   // Client: PrivacyPoolClient contract
    faucet?: string;              // Faucet for test tokens
  };
}

export interface TokenConfig {
  symbol: string;
  decimals: number;
}

export interface Config {
  chains: ChainConfig[];
  tokens: Record<string, TokenConfig>;
}

// Load chain configuration
export const config: Config = chainsConfig as Config;

// Helper functions
export function getChainById(chainId: number): ChainConfig | undefined {
  return config.chains.find(c => c.id === chainId);
}

export function getHubChain(): ChainConfig {
  const hub = config.chains.find(c => c.type === 'hub');
  if (!hub) throw new Error('Hub chain not configured');
  return hub;
}

export function getClientChains(): ChainConfig[] {
  return config.chains.filter(c => c.type === 'client');
}

export function getAllChains(): ChainConfig[] {
  return config.chains;
}

// Contract addresses - loaded from deployment files
let deploymentsLoaded = false;

interface DeploymentFile {
  chainId: number;
  contracts: Record<string, string>;
  cctp?: {
    usdc?: string;
    tokenMessenger?: string;
    messageTransmitter?: string;
  };
}

async function fetchDeployment(name: string): Promise<DeploymentFile | null> {
  try {
    // In development, Vite proxies requests to the parent directory
    // In production, these files should be copied to the dist folder
    const response = await fetch(`/api/deployments/${name}.json`);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export async function loadDeployments(): Promise<void> {
  if (deploymentsLoaded) return;

  try {
    // Load deployment files
    // - privacy-pool-*.json: Native CCTP architecture (PrivacyPool contracts)
    // - *-v3.json: CCTP infrastructure (MockUSDCV2, TokenMessenger, etc.) + Faucet
    const [
      privacyPoolHub,
      privacyPoolClient,
      privacyPoolClientB,
      hubCctp,
      clientCctp,
      clientBCctp,
    ] = await Promise.all([
      fetchDeployment('privacy-pool-hub'),
      fetchDeployment('privacy-pool-client'),
      fetchDeployment('privacy-pool-clientB'),
      fetchDeployment('hub-v3'),
      fetchDeployment('client-v3'),
      fetchDeployment('clientB-v3'),
    ]);

    const hasPrivacyPool = !!privacyPoolHub;
    const hasCctp = !!hubCctp;

    if (!hasPrivacyPool && !hasCctp) {
      console.warn('No deployment files found. Run npm run setup first.');
      return;
    }

    console.log('Loading deployments...', {
      privacyPool: hasPrivacyPool,
      cctp: hasCctp,
    });

    // Update Hub chain config (chain ID 31337)
    const hubChain = config.chains.find(c => c.id === 31337);
    if (hubChain) {
      // USDC: prefer privacy-pool cctp section, fallback to hub-v3 contracts
      const hubUsdc = privacyPoolHub?.cctp?.usdc || hubCctp?.contracts?.usdc;

      hubChain.contracts = {
        mockUSDC: hubUsdc,
        privacyPool: privacyPoolHub?.contracts?.privacyPool,
        faucet: hubCctp?.contracts?.faucet,
      };
    }

    // Update Client A chain config (chain ID 31338)
    const clientAChain = config.chains.find(c => c.id === 31338);
    if (clientAChain) {
      const clientUsdc = privacyPoolClient?.cctp?.usdc || clientCctp?.contracts?.usdc;

      clientAChain.contracts = {
        mockUSDC: clientUsdc,
        privacyPoolClient: privacyPoolClient?.contracts?.privacyPoolClient,
        faucet: clientCctp?.contracts?.faucet,
      };
    }

    // Update Client B chain config (chain ID 31339)
    const clientBChain = config.chains.find(c => c.id === 31339);
    if (clientBChain) {
      const clientBUsdc = privacyPoolClientB?.cctp?.usdc || clientBCctp?.contracts?.usdc;

      clientBChain.contracts = {
        mockUSDC: clientBUsdc,
        privacyPoolClient: privacyPoolClientB?.contracts?.privacyPoolClient,
        faucet: clientBCctp?.contracts?.faucet,
      };
    }

    deploymentsLoaded = true;
    console.log('Deployments loaded:', {
      hub: hubChain?.contracts,
      clientA: clientAChain?.contracts,
      clientB: clientBChain?.contracts,
    });
  } catch (error) {
    console.warn('Failed to load deployments:', error);
  }
}

export function getContractAddress(chainId: number, contract: keyof NonNullable<ChainConfig['contracts']>): string | undefined {
  const chain = getChainById(chainId);
  return chain?.contracts?.[contract];
}
