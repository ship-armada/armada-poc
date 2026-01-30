/**
 * Unlock Prompt Component
 *
 * Prompts the user to sign a message with MetaMask to derive
 * their shielded wallet keys.
 */

import { useState } from 'react';
import { useShieldedWallet } from '../../hooks/useShieldedWallet';

export function UnlockPrompt() {
  const { unlock, status, error } = useShieldedWallet();
  const [isUnlocking, setIsUnlocking] = useState(false);

  const handleUnlock = async () => {
    setIsUnlocking(true);
    try {
      await unlock();
    } catch (err) {
      // Error is already handled in the hook
      console.error('Unlock failed:', err);
    } finally {
      setIsUnlocking(false);
    }
  };

  const isLoading = isUnlocking || status === 'unlocking';

  return (
    <div className="p-6 bg-gray-900 rounded-xl border border-gray-800">
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-600/20 flex items-center justify-center">
          <svg
            className="w-8 h-8 text-blue-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
        </div>

        <h3 className="text-xl font-semibold mb-2">Unlock Shielded Wallet</h3>

        <p className="text-gray-400 text-sm mb-6 max-w-md mx-auto">
          Sign a message with your wallet to derive your shielded wallet keys.
          Your keys will only be held in memory during this session.
        </p>

        <button
          onClick={handleUnlock}
          disabled={isLoading}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
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
              Waiting for signature...
            </span>
          ) : (
            'Unlock Wallet'
          )}
        </button>

        {error && (
          <p className="mt-4 text-sm text-red-400">{error}</p>
        )}

        <div className="mt-6 p-4 bg-yellow-900/20 border border-yellow-700/50 rounded-lg">
          <p className="text-sm text-yellow-500">
            This is POC software. Only sign this message on trusted devices
            and use test funds only.
          </p>
        </div>
      </div>
    </div>
  );
}
