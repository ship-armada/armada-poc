/**
 * Faucet Button Component
 *
 * Button to request test tokens from a specific chain's faucet.
 */

import { useState } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { BrowserProvider, parseEther } from 'ethers';
import { type ChainConfig } from '../../config';
import { requestFaucet } from '../../lib/sdk';

interface FaucetButtonProps {
  chain: ChainConfig;
  onSuccess?: () => void;
}

// Minimum ETH balance needed to send a faucet transaction
const MIN_GAS_BALANCE = parseEther('0.01');

/**
 * Request tokens from the faucet via the dev server endpoint.
 * This uses the Anvil deployer account to call dripTo() on the faucet,
 * giving the user 1000 USDC + 1 ETH without needing gas.
 */
async function requestFaucetViaBackend(address: string, chainId: number): Promise<void> {
  const response = await fetch('/api/fund-gas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, chainId }),
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Failed to request tokens');
  }
}

export function FaucetButton({ chain, onSuccess }: FaucetButtonProps) {
  const { address, chain: currentChain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFaucet = async () => {
    if (!address) return;

    setIsLoading(true);
    setError(null);
    setStatus(null);

    try {
      // Switch chain if needed
      if (currentChain?.id !== chain.id) {
        setStatus('Switching chain...');
        await switchChainAsync({ chainId: chain.id as 31337 | 31338 | 31339 });
      }

      // Get signer from window.ethereum
      if (!window.ethereum) {
        throw new Error('No wallet found');
      }

      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      // Check ETH balance - if too low, use backend to call faucet
      const balance = await provider.getBalance(address);
      if (balance < MIN_GAS_BALANCE) {
        // No gas - use backend endpoint which calls dripTo() on user's behalf
        setStatus('Requesting tokens...');
        await requestFaucetViaBackend(address, chain.id);
      } else {
        // Has gas - call faucet directly from client
        setStatus('Requesting tokens...');
        await requestFaucet(chain, signer);
      }

      // Notify parent
      onSuccess?.();
    } catch (err) {
      console.error('Faucet error:', err);
      setError(err instanceof Error ? err.message : 'Failed to request tokens');
    } finally {
      setIsLoading(false);
      setStatus(null);
    }
  };

  const hasFaucet = !!chain.contracts?.faucet;

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        onClick={handleFaucet}
        disabled={isLoading || !hasFaucet}
        className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
      >
        {isLoading ? (
          <span className="flex items-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            {status || 'Processing...'}
          </span>
        ) : hasFaucet ? (
          `Get ${chain.name} tokens`
        ) : (
          'No faucet'
        )}
      </button>
      {error && (
        <p className="text-xs text-red-400 text-center max-w-[150px]">{error}</p>
      )}
    </div>
  );
}
