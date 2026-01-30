/**
 * Faucet Section Component
 *
 * Displays faucet buttons for all chains and shows public balances.
 */

import { usePublicBalances } from '../../hooks/usePublicBalances';
import { FaucetButton } from './FaucetButton';
import { formatUSDC, formatETH } from '../../lib/sdk';

export function FaucetSection() {
  const { balances, isLoading, refresh } = usePublicBalances();

  return (
    <div className="p-6 bg-gray-900 rounded-xl border border-gray-800">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Test Faucet</h3>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
          title="Refresh balances"
        >
          <svg
            className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </div>

      <p className="text-gray-400 text-sm mb-6">
        Get test USDC and ETH for each chain. Each faucet gives 1,000 USDC and 1 ETH.
      </p>

      {/* Faucet Buttons */}
      <div className="flex flex-wrap gap-3 mb-6">
        {balances.map((b) => (
          <FaucetButton
            key={b.chain.id}
            chain={b.chain}
            onSuccess={refresh}
          />
        ))}
      </div>

      {/* Balance Table */}
      <div className="border-t border-gray-800 pt-4">
        <h4 className="text-sm font-medium text-gray-400 mb-3">Your Public Balances</h4>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 text-left">
                <th className="pb-2 font-medium">Chain</th>
                <th className="pb-2 font-medium text-right">USDC</th>
                <th className="pb-2 font-medium text-right">ETH</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.chain.id} className="border-t border-gray-800">
                  <td className="py-2">
                    <span className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          b.chain.type === 'hub' ? 'bg-blue-500' : 'bg-green-500'
                        }`}
                      />
                      {b.chain.name}
                    </span>
                  </td>
                  <td className="py-2 text-right font-mono">
                    {b.isLoading ? (
                      <span className="text-gray-500">...</span>
                    ) : b.error ? (
                      <span className="text-red-400">Error</span>
                    ) : (
                      <span className="text-white">{formatUSDC(b.usdc)}</span>
                    )}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {b.isLoading ? (
                      <span className="text-gray-500">...</span>
                    ) : b.error ? (
                      <span className="text-red-400">Error</span>
                    ) : (
                      <span className="text-gray-300">{formatETH(b.eth).slice(0, 8)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
