/**
 * Pay Form Component
 *
 * Allows users to send USDC from their shielded balance:
 * - To a Railgun address (0zk...): Private transfer
 * - To an Ethereum address (0x...): Unshield (+ optional bridge to client chain)
 *
 * Flow:
 *   1. User enters recipient address
 *   2. App detects address type (0zk vs 0x)
 *   3. User enters amount
 *   4. For 0x addresses: User selects destination chain
 *   5. User clicks "Send"
 *   6. App generates zk proof (~30 seconds)
 *   7. App submits transaction
 *      - Hub destination: Direct unshield to recipient via transact()
 *      - Client destination: Atomic cross-chain unshield via PrivacyPool.atomicCrossChainUnshield()
 *   8. For cross-chain: CCTP relayer delivers tokens to PrivacyPoolClient on destination chain
 */

import { useState, useEffect } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { getClientChains, getHubChain, loadDeployments } from '../../config';
import { useShieldedWallet } from '../../hooks/useShieldedWallet';
import {
  executePrivateTransfer,
  executeUnshield,
  executeUnshieldToClientChain,
  getShieldedBalance,
  formatUSDC,
  parseUSDC,
  onBalanceUpdate,
} from '../../lib/sdk';
import {
  initRailgun,
  isRailgunInitialized,
  initializeProver,
  isProverReady,
} from '../../lib/railgun';

type PayStep = 'idle' | 'init-prover' | 'generating-proof' | 'submitting' | 'success' | 'error';
type RecipientType = 'unknown' | 'railgun' | 'ethereum';

export function PayForm() {
  const { address, chain: currentChain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { status, walletId, encryptionKey } = useShieldedWallet();
  const isUnlocked = status === 'unlocked';

  // Available chains
  const clientChains = getClientChains();
  const hubChain = getHubChain();
  const allChains = [hubChain, ...clientChains];

  // Form state
  const [recipientInput, setRecipientInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [destinationChainId, setDestinationChainId] = useState<number>(hubChain.id);
  const [step, setStep] = useState<PayStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [proofProgress, setProofProgress] = useState(0);

  // Balance state
  const [shieldedBalance, setShieldedBalance] = useState<bigint>(0n);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);

  // SDK state
  const [isRailgunReady, setIsRailgunReady] = useState(isRailgunInitialized());

  // Derived state
  const amount = amountInput ? parseUSDC(amountInput) : 0n;
  const recipientType = detectRecipientType(recipientInput);
  const isPrivateTransfer = recipientType === 'railgun';
  const showDestinationSelector = recipientType === 'ethereum';

  // Initialize Railgun SDK on mount
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      if (isRailgunInitialized()) {
        setIsRailgunReady(true);
        return;
      }

      try {
        await initRailgun();
        if (mounted) {
          setIsRailgunReady(true);
        }
      } catch (err) {
        console.error('[pay] Failed to initialize Railgun SDK:', err);
      }
    };

    init();

    return () => {
      mounted = false;
    };
  }, []);

  // Load shielded balance
  const refreshBalance = async () => {
    if (!walletId || !isRailgunReady) return;

    setIsLoadingBalance(true);
    try {
      await loadDeployments();
      const hubConfig = getHubChain();
      if (hubConfig.contracts?.mockUSDC) {
        const bal = await getShieldedBalance(walletId, hubConfig.contracts.mockUSDC);
        setShieldedBalance(bal);
      }
    } catch (err) {
      console.error('[pay] Failed to load shielded balance:', err);
    } finally {
      setIsLoadingBalance(false);
    }
  };

  useEffect(() => {
    if (!walletId || !isRailgunReady) return;

    // Load balance initially
    refreshBalance();

    // Subscribe to balance updates from SDK
    const unsubscribe = onBalanceUpdate(async () => {
      console.log('[pay] Balance update event received, refreshing...');
      await refreshBalance();
    });

    return () => unsubscribe();
  }, [walletId, isRailgunReady]);

  const handleSend = async () => {
    if (!walletId || !encryptionKey || !address) return;
    if (amount <= 0n || recipientType === 'unknown') return;

    setStep('init-prover');
    setError(null);
    setTxHash(null);
    setProofProgress(0);

    try {
      // Ensure we're on the hub chain for transactions
      if (currentChain?.id !== hubChain.id) {
        await switchChainAsync({ chainId: hubChain.id as 31337 | 31338 | 31339 });
      }

      // Initialize prover if needed
      if (!isProverReady()) {
        console.log('[pay] Initializing prover...');
        await initializeProver();
      }

      await loadDeployments();
      const hubConfig = getHubChain();
      const tokenAddress = hubConfig.contracts?.mockUSDC;

      if (!tokenAddress) {
        throw new Error('No USDC address for hub chain');
      }

      setStep('generating-proof');

      if (isPrivateTransfer) {
        // Private transfer to Railgun address
        const result = await executePrivateTransfer(
          walletId,
          encryptionKey,
          tokenAddress,
          recipientInput,
          amount,
          setProofProgress
        );

        setTxHash(result.txHash);
        setStep('success');
      } else {
        // Unshield to Ethereum address
        const isHubDestination = destinationChainId === hubChain.id;

        if (isHubDestination) {
          // Direct unshield to recipient on hub chain
          const unshieldResult = await executeUnshield(
            walletId,
            encryptionKey,
            tokenAddress,
            recipientInput,
            amount,
            setProofProgress
          );

          setTxHash(unshieldResult.txHash);
          setStep('success');
        } else {
          // Atomic cross-chain unshield via PrivacyPool
          // Uses native CCTP integration: proof verification + CCTP bridging in one tx
          const privacyPoolAddress = hubConfig.contracts?.privacyPool;
          if (!privacyPoolAddress) {
            throw new Error('No PrivacyPool address for hub chain');
          }

          const result = await executeUnshieldToClientChain(
            walletId,
            encryptionKey,
            tokenAddress,
            privacyPoolAddress,
            amount,
            destinationChainId,
            recipientInput, // Final recipient on destination chain
            setProofProgress
          );

          setTxHash(result.txHash);
          setStep('success');
        }
      }

      // Clear form
      setAmountInput('');
      setRecipientInput('');

      // Refresh balance after successful transaction
      // Use a small delay to allow the SDK to process the new state
      setTimeout(() => refreshBalance(), 2000);

    } catch (err) {
      console.error('[pay] Error:', err);
      setError(err instanceof Error ? err.message : 'Transaction failed');
      setStep('error');
    }
  };

  const handleMaxClick = () => {
    if (shieldedBalance > 0n) {
      setAmountInput(formatUSDC(shieldedBalance));
    }
  };

  const canSend = isUnlocked &&
    isRailgunReady &&
    amount > 0n &&
    amount <= shieldedBalance &&
    recipientType !== 'unknown';

  const getStepLabel = () => {
    switch (step) {
      case 'init-prover':
        return 'Initializing prover...';
      case 'generating-proof':
        return `Generating proof... ${Math.round(proofProgress * 100)}%`;
      case 'submitting':
        return 'Submitting...';
      default:
        return 'Send';
    }
  };

  const getRecipientTypeLabel = () => {
    switch (recipientType) {
      case 'railgun':
        return 'Private transfer';
      case 'ethereum':
        return 'Unshield to public address';
      default:
        return '';
    }
  };

  return (
    <div className="p-6 bg-gray-900 rounded-xl border border-gray-800">
      <h3 className="text-lg font-semibold mb-4">Send</h3>
      <p className="text-gray-400 text-sm mb-4">
        Send USDC privately or unshield to a public address.
      </p>

      {!isUnlocked ? (
        <p className="text-yellow-500 text-sm">
          Unlock your shielded wallet to send.
        </p>
      ) : !isRailgunReady ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <LoadingSpinner />
          Initializing Railgun SDK...
        </div>
      ) : (
        <div className="space-y-4">
          {/* Shielded Balance */}
          <div className="p-3 bg-gray-800/50 rounded-lg">
            <div className="text-sm text-gray-400">Shielded Balance</div>
            <div className="text-xl font-mono">
              {isLoadingBalance ? '...' : formatUSDC(shieldedBalance)} USDC
            </div>
          </div>

          {/* Recipient Input */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">To</label>
            <input
              type="text"
              value={recipientInput}
              onChange={(e) => setRecipientInput(e.target.value.trim())}
              placeholder="0zk... or 0x..."
              disabled={step !== 'idle' && step !== 'error'}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-purple-500"
            />
            {recipientType !== 'unknown' && recipientInput && (
              <p className={`text-xs mt-1 ${isPrivateTransfer ? 'text-purple-400' : 'text-blue-400'}`}>
                {getRecipientTypeLabel()}
              </p>
            )}
            {recipientInput && recipientType === 'unknown' && (
              <p className="text-xs mt-1 text-red-400">
                Invalid address. Enter a 0zk... or 0x... address.
              </p>
            )}
          </div>

          {/* Amount Input */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-sm text-gray-400">Amount</label>
            </div>
            <div className="relative">
              <input
                type="text"
                value={amountInput}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '' || /^\d*\.?\d*$/.test(val)) {
                    setAmountInput(val);
                  }
                }}
                placeholder="0.00"
                disabled={step !== 'idle' && step !== 'error'}
                className="w-full px-3 py-2 pr-20 bg-gray-800 border border-gray-700 rounded-lg text-white font-mono focus:outline-none focus:border-purple-500"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
                <button
                  onClick={handleMaxClick}
                  className="text-xs text-purple-400 hover:text-purple-300"
                >
                  MAX
                </button>
                <span className="text-gray-400">USDC</span>
              </div>
            </div>
          </div>

          {/* Validation Messages */}
          {amount > shieldedBalance && (
            <p className="text-red-400 text-sm">Insufficient shielded balance</p>
          )}

          {/* Destination Chain Selector (only for 0x addresses) */}
          {showDestinationSelector && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Destination Chain</label>
              <select
                value={destinationChainId}
                onChange={(e) => setDestinationChainId(Number(e.target.value))}
                disabled={step !== 'idle' && step !== 'error'}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-purple-500"
              >
                {allChains.map((chain) => (
                  <option key={chain.id} value={chain.id}>
                    {chain.name} {chain.type === 'hub' ? '(direct)' : '(via relayer)'}
                  </option>
                ))}
              </select>
              {destinationChainId !== hubChain.id && (
                <p className="text-xs text-yellow-500 mt-1">
                  Single-tx unshield + bridge. Relayer delivers to client chain.
                </p>
              )}
            </div>
          )}

          {/* Proof Generation Warning */}
          {step === 'idle' && canSend && (
            <p className="text-xs text-gray-500">
              Proof generation takes ~30 seconds. Please wait after clicking Send.
            </p>
          )}

          {/* Progress Bar */}
          {step === 'generating-proof' && (
            <div className="space-y-2">
              <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-500 transition-all duration-300"
                  style={{ width: `${Math.round(proofProgress * 100)}%` }}
                />
              </div>
              <p className="text-xs text-gray-400 text-center">
                Generating zero-knowledge proof...
              </p>
            </div>
          )}

          {/* Send Button */}
          <button
            onClick={handleSend}
            disabled={!canSend || !['idle', 'error'].includes(step)}
            className="w-full px-4 py-3 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {['init-prover', 'generating-proof', 'submitting'].includes(step) ? (
              <span className="flex items-center justify-center gap-2">
                <LoadingSpinner />
                {getStepLabel()}
              </span>
            ) : (
              'Send'
            )}
          </button>

          {/* Status Messages */}
          {step === 'success' && txHash && (
            <div className="p-3 bg-green-900/30 border border-green-700/50 rounded-lg">
              <p className="text-green-400 text-sm">
                {isPrivateTransfer
                  ? 'Private transfer complete!'
                  : destinationChainId === hubChain.id
                    ? 'Unshield complete!'
                    : 'Unshield + bridge complete! Tokens will arrive on client chain after relay.'}
              </p>
              <p className="text-xs text-gray-400 mt-1 font-mono break-all">
                Tx: {txHash}
              </p>
              <button
                onClick={() => {
                  setStep('idle');
                  setTxHash(null);
                  setError(null);
                }}
                className="mt-2 text-sm text-purple-400 hover:text-purple-300"
              >
                New Transfer
              </button>
            </div>
          )}

          {step === 'error' && error && (
            <div className="p-3 bg-red-900/30 border border-red-700/50 rounded-lg">
              <p className="text-red-400 text-sm">{error}</p>
              <button
                onClick={() => setStep('idle')}
                className="text-xs text-gray-400 hover:text-white mt-1"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Detect if an address is a Railgun address (0zk...) or Ethereum address (0x...)
 */
function detectRecipientType(address: string): RecipientType {
  if (!address) return 'unknown';

  // Railgun addresses start with 0zk
  if (address.startsWith('0zk')) {
    // Basic validation - should be longer than prefix
    return address.length > 10 ? 'railgun' : 'unknown';
  }

  // Ethereum addresses start with 0x and are 42 chars
  if (address.startsWith('0x')) {
    return address.length === 42 ? 'ethereum' : 'unknown';
  }

  return 'unknown';
}

function LoadingSpinner() {
  return (
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
  );
}
