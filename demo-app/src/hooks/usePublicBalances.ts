/**
 * Public Balances Hook
 *
 * Fetches public USDC and ETH balances for all configured chains.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { getAllChains, loadDeployments, type ChainConfig } from '../config';
import { getPublicBalance, getNativeBalance } from '../lib/sdk';

export interface ChainBalance {
  chain: ChainConfig;
  usdc: bigint;
  eth: bigint;
  isLoading: boolean;
  error: string | null;
}

export interface PublicBalancesState {
  balances: ChainBalance[];
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function usePublicBalances(): PublicBalancesState {
  const { address, isConnected } = useAccount();
  const [balances, setBalances] = useState<ChainBalance[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!address || !isConnected) {
      setBalances([]);
      return;
    }

    setIsLoading(true);

    await loadDeployments();
    const chains = getAllChains();
    const newBalances: ChainBalance[] = [];

    for (const chain of chains) {
      try {
        const [usdc, eth] = await Promise.all([
          getPublicBalance(chain, address),
          getNativeBalance(chain, address),
        ]);

        newBalances.push({
          chain,
          usdc,
          eth,
          isLoading: false,
          error: null,
        });
      } catch (error) {
        newBalances.push({
          chain,
          usdc: 0n,
          eth: 0n,
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to fetch balance',
        });
      }
    }

    setBalances(newBalances);
    setIsLoading(false);
  }, [address, isConnected]);

  // Initial fetch and refetch when address changes
  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    balances,
    isLoading,
    refresh,
  };
}
