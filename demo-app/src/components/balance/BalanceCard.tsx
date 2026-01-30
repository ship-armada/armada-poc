/**
 * Balance Card Component
 *
 * Displays the user's shielded USDC balance.
 */

import { useShieldedWallet } from '../../hooks/useShieldedWallet';
import { formatUSDC, truncateAddress } from '../../lib/sdk';
import { UnlockPrompt } from '../wallet/UnlockPrompt';

export function BalanceCard() {
  const { status, railgunAddress, shieldedBalance, isScanning, refreshBalance } = useShieldedWallet();

  // Show unlock prompt if not unlocked
  if (status !== 'unlocked') {
    return <UnlockPrompt />;
  }

  return (
    <div className="p-6 bg-gradient-to-br from-gray-900 to-gray-800 rounded-xl border border-gray-700">
      <div className="flex items-start justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-300">Shielded Balance</h3>
        <button
          onClick={refreshBalance}
          disabled={isScanning}
          className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
          title="Refresh balance"
        >
          <svg
            className={`w-5 h-5 ${isScanning ? 'animate-spin' : ''}`}
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

      {/* Balance Display */}
      <div className="mb-6">
        <div className="flex items-baseline gap-2">
          <span className="text-4xl font-bold text-white">
            {formatUSDC(shieldedBalance)}
          </span>
          <span className="text-xl text-gray-400">USDC</span>
        </div>
        {isScanning && (
          <p className="text-sm text-gray-500 mt-1">Scanning merkle tree...</p>
        )}
      </div>

      {/* Shielded Address */}
      <div className="pt-4 border-t border-gray-700">
        <p className="text-sm text-gray-500 mb-1">Shielded Address</p>
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono text-gray-300 bg-gray-800 px-3 py-1.5 rounded">
            {railgunAddress ? truncateAddress(railgunAddress, 12) : '...'}
          </code>
          <CopyButton text={railgunAddress || ''} />
        </div>
      </div>
    </div>
  );
}

// ============ Copy Button ============

function CopyButton({ text }: { text: string }) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
      title="Copy full address"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
        />
      </svg>
    </button>
  );
}
