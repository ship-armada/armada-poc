/**
 * Wallet Status Component
 *
 * Displays the shielded wallet status including:
 * - Shielded address
 * - Lock button
 */

import { useState } from 'react';
import { useShieldedWallet } from '../../hooks/useShieldedWallet';
import { truncateAddress } from '../../lib/sdk';

export function WalletStatus() {
  const { status, railgunAddress, lock } = useShieldedWallet();
  const [copied, setCopied] = useState(false);

  if (status !== 'unlocked' || !railgunAddress) {
    return null;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(railgunAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {/* Shielded indicator */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-green-900/30 border border-green-700/50 rounded-lg">
        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
        <span className="text-sm text-green-400 font-mono">
          {truncateAddress(railgunAddress, 8)}
        </span>
        <button
          onClick={handleCopy}
          className="text-green-400 hover:text-green-300 transition-colors"
          title="Copy address"
        >
          {copied ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          )}
        </button>
      </div>

      {/* Lock button */}
      <button
        onClick={lock}
        className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
        title="Lock wallet"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
          />
        </svg>
      </button>
    </div>
  );
}
