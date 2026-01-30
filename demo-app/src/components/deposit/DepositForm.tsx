/**
 * Deposit Form Component
 *
 * Allows users to shield USDC from a client chain into the private pool.
 * Flow:
 *   1. User selects source chain (Client A, Client B, or Hub)
 *   2. User enters amount
 *   3. App checks USDC balance and allowance
 *   4. User approves USDC if needed
 *   5. User signs for shield private key (one-time)
 *   6. User executes shield transaction
 *   7. CCTP relay delivers to hub (for client chains)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { BrowserProvider } from 'ethers';
import { getClientChains, getHubChain, loadDeployments } from '../../config';
import { useShieldedWallet } from '../../hooks/useShieldedWallet';
import {
  getPublicBalance,
  getUSDCAllowance,
  approveUSDC,
  executeShield,
  executeDirectShield,
  formatUSDC,
  parseUSDC,
} from '../../lib/sdk';
import {
  initRailgun,
  isRailgunInitialized,
  createShieldRequest,
  deriveShieldPrivateKey,
  formatNpkForContract,
  formatBytes32ForContract,
  SHIELD_SIGNATURE_MESSAGE,
} from '../../lib/railgun';

type ShieldStep = 'idle' | 'init' | 'signing' | 'approving' | 'shielding' | 'success' | 'error';

export function DepositForm() {
  const { address, chain: currentChain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { status, railgunAddress } = useShieldedWallet();
  const isUnlocked = status === 'unlocked';

  // Available chains for shielding (client chains only for now)
  const clientChains = getClientChains();
  const hubChain = getHubChain();
  const allChains = [...clientChains, hubChain];

  // Form state
  const [selectedChainId, setSelectedChainId] = useState<number>(clientChains[0]?.id ?? 31337);
  const [amountInput, setAmountInput] = useState('');
  const [step, setStep] = useState<ShieldStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Balance state
  const [balance, setBalance] = useState<bigint>(0n);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);

  // Shield private key (derived from signature, cached in memory)
  const shieldPrivateKeyRef = useRef<string | null>(null);

  // Railgun SDK initialization state
  const [isRailgunReady, setIsRailgunReady] = useState(isRailgunInitialized());
  const [railgunInitError, setRailgunInitError] = useState<string | null>(null);

  const selectedChain = allChains.find(c => c.id === selectedChainId);
  const amount = amountInput ? parseUSDC(amountInput) : 0n;
  const needsApproval = amount > 0n && allowance < amount;
  const isHubChain = selectedChainId === hubChain.id;

  // Initialize Railgun SDK on mount
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      if (isRailgunInitialized()) {
        setIsRailgunReady(true);
        return;
      }

      try {
        console.log('[deposit] Initializing Railgun SDK...');
        await initRailgun();
        if (mounted) {
          setIsRailgunReady(true);
          console.log('[deposit] Railgun SDK initialized');
        }
      } catch (err) {
        console.error('[deposit] Failed to initialize Railgun SDK:', err);
        if (mounted) {
          setRailgunInitError(err instanceof Error ? err.message : 'Failed to initialize');
        }
      }
    };

    init();

    return () => {
      mounted = false;
    };
  }, []);

  // Load balance and allowance when chain or address changes
  const loadBalanceAndAllowance = useCallback(async () => {
    if (!address || !selectedChain) return;

    setIsLoadingBalance(true);
    try {
      await loadDeployments();
      const bal = await getPublicBalance(selectedChain, address);
      setBalance(bal);

      // Check allowance for PrivacyPoolClient (client chains) or PrivacyPool (hub)
      if (!isHubChain && selectedChain.contracts?.privacyPoolClient) {
        const allow = await getUSDCAllowance(
          selectedChain,
          address,
          selectedChain.contracts.privacyPoolClient
        );
        setAllowance(allow);
      } else if (isHubChain && selectedChain.contracts?.privacyPool) {
        const allow = await getUSDCAllowance(
          selectedChain,
          address,
          selectedChain.contracts.privacyPool
        );
        setAllowance(allow);
      } else {
        setAllowance(0n);
      }
    } catch (err) {
      console.error('Failed to load balance:', err);
    } finally {
      setIsLoadingBalance(false);
    }
  }, [address, selectedChain, isHubChain]);

  useEffect(() => {
    loadBalanceAndAllowance();
  }, [loadBalanceAndAllowance]);

  // Get or derive shield private key
  const getShieldPrivateKey = async (): Promise<string> => {
    // Return cached key if available
    if (shieldPrivateKeyRef.current) {
      return shieldPrivateKeyRef.current;
    }

    // Request signature from user
    if (!window.ethereum) {
      throw new Error('No wallet found');
    }

    setStep('signing');

    const provider = new BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const signature = await signer.signMessage(SHIELD_SIGNATURE_MESSAGE);

    // Derive key from signature
    const key = deriveShieldPrivateKey(signature);
    shieldPrivateKeyRef.current = key;

    return key;
  };

  const handleApprove = async () => {
    if (!address || !selectedChain || !window.ethereum) return;

    setStep('approving');
    setError(null);

    try {
      // Ensure deployments are loaded
      await loadDeployments();

      // Switch chain if needed
      if (currentChain?.id !== selectedChainId) {
        await switchChainAsync({ chainId: selectedChainId as 31337 | 31338 | 31339 });
      }

      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      // Determine spender: PrivacyPool for hub, PrivacyPoolClient for client chains
      const spender = isHubChain
        ? selectedChain.contracts?.privacyPool
        : selectedChain.contracts?.privacyPoolClient;

      if (!spender) {
        throw new Error(`No ${isHubChain ? 'PrivacyPool' : 'PrivacyPoolClient'} address for this chain. Make sure contracts are deployed.`);
      }

      // Approve max uint256 for convenience
      const maxAmount = 2n ** 256n - 1n;
      await approveUSDC(selectedChain, signer, spender, maxAmount);

      // Refresh allowance
      await loadBalanceAndAllowance();
      setStep('idle');
    } catch (err) {
      console.error('Approval error:', err);
      setError(err instanceof Error ? err.message : 'Approval failed');
      setStep('error');
    }
  };

  const handleShield = async () => {
    if (!address || !selectedChain || !railgunAddress || !window.ethereum) return;
    if (amount <= 0n) return;
    if (!isRailgunReady) {
      setError('Railgun SDK not ready');
      return;
    }

    setStep('init');
    setError(null);
    setTxHash(null);

    try {
      // Switch chain if needed
      if (currentChain?.id !== selectedChainId) {
        await switchChainAsync({ chainId: selectedChainId as 31337 | 31338 | 31339 });
      }

      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      // Get shield private key (may require signature)
      const shieldPrivateKey = await getShieldPrivateKey();

      // Get token address
      const tokenAddress = selectedChain.contracts?.mockUSDC;
      if (!tokenAddress) {
        throw new Error('No USDC address for this chain');
      }

      setStep('shielding');

      // Create shield request using Railgun SDK
      const shieldRequest = await createShieldRequest(
        railgunAddress,
        amount,
        tokenAddress,
        shieldPrivateKey
      );

      // Format values for contract call
      const npk = formatNpkForContract(shieldRequest.npk);
      const encryptedBundle: [string, string, string] = [
        formatBytes32ForContract(shieldRequest.encryptedBundle[0]),
        formatBytes32ForContract(shieldRequest.encryptedBundle[1]),
        formatBytes32ForContract(shieldRequest.encryptedBundle[2]),
      ];
      const shieldKey = formatBytes32ForContract(shieldRequest.shieldKey);

      let result: { txHash: string };

      if (isHubChain) {
        // Direct shield on hub chain - call RailgunSmartWallet directly
        result = await executeDirectShield(
          selectedChain,
          signer,
          amount,
          npk,
          encryptedBundle,
          shieldKey
        );
      } else {
        // Cross-chain shield via ClientShieldProxyV2
        result = await executeShield(
          selectedChain,
          signer,
          amount,
          npk,
          encryptedBundle,
          shieldKey
        );
      }

      setTxHash(result.txHash);
      setStep('success');
      setAmountInput('');

      // Refresh balance
      await loadBalanceAndAllowance();
    } catch (err) {
      console.error('Shield error:', err);
      setError(err instanceof Error ? err.message : 'Shield failed');
      setStep('error');
    }
  };

  const handleMaxClick = () => {
    if (balance > 0n) {
      setAmountInput(formatUSDC(balance));
    }
  };

  const canDeposit = isUnlocked && isRailgunReady && amount > 0n && amount <= balance && !needsApproval;

  const getStepLabel = () => {
    switch (step) {
      case 'init':
        return 'Initializing...';
      case 'signing':
        return 'Sign message...';
      case 'shielding':
        return 'Shielding...';
      default:
        return 'Deposit';
    }
  };

  return (
    <div className="p-6 bg-gray-900 rounded-xl border border-gray-800">
      <h3 className="text-lg font-semibold mb-4">Deposit</h3>
      <p className="text-gray-400 text-sm mb-4">
        Shield USDC from any chain into your private balance.
      </p>

      {!isUnlocked ? (
        <p className="text-yellow-500 text-sm">
          Unlock your shielded wallet to deposit.
        </p>
      ) : railgunInitError ? (
        <div className="p-3 bg-red-900/30 border border-red-700/50 rounded-lg">
          <p className="text-red-400 text-sm">Failed to initialize Railgun SDK:</p>
          <p className="text-red-300 text-xs mt-1">{railgunInitError}</p>
        </div>
      ) : !isRailgunReady ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <LoadingSpinner />
          Initializing Railgun SDK...
        </div>
      ) : (
        <div className="space-y-4">
          {/* Chain Selector */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">From Chain</label>
            <select
              value={selectedChainId}
              onChange={(e) => setSelectedChainId(Number(e.target.value))}
              disabled={step !== 'idle' && step !== 'error'}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-purple-500"
            >
              {allChains.map((chain) => (
                <option key={chain.id} value={chain.id}>
                  {chain.name} {chain.type === 'hub' ? '(Hub)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Amount Input */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-sm text-gray-400">Amount</label>
              <span className="text-xs text-gray-500">
                Balance: {isLoadingBalance ? '...' : formatUSDC(balance)} USDC
              </span>
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
          {amount > balance && (
            <p className="text-red-400 text-sm">Insufficient balance</p>
          )}

          {/* Hub Chain Notice */}
          {isHubChain && (
            <p className="text-blue-400 text-sm">
              Direct hub deposit - no relayer needed.
            </p>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3">
            {needsApproval && (
              <button
                onClick={handleApprove}
                disabled={step === 'approving'}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
              >
                {step === 'approving' ? (
                  <span className="flex items-center justify-center gap-2">
                    <LoadingSpinner />
                    Approving...
                  </span>
                ) : (
                  'Approve USDC'
                )}
              </button>
            )}

            <button
              onClick={handleShield}
              disabled={!canDeposit || ['init', 'signing', 'shielding'].includes(step)}
              className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
            >
              {['init', 'signing', 'shielding'].includes(step) ? (
                <span className="flex items-center justify-center gap-2">
                  <LoadingSpinner />
                  {getStepLabel()}
                </span>
              ) : (
                'Deposit'
              )}
            </button>
          </div>

          {/* Status Messages */}
          {step === 'success' && txHash && (
            <div className="p-3 bg-green-900/30 border border-green-700/50 rounded-lg">
              <p className="text-green-400 text-sm">
                {isHubChain
                  ? 'Shield complete! Your balance will update shortly.'
                  : 'Shield initiated! The relayer will process your deposit.'}
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
                New Deposit
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
