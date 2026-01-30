/**
 * Shielded Wallet Hook & Context
 *
 * Manages the shielded wallet state and provides methods for:
 * - Unlocking (deriving keys from MetaMask signature)
 * - Locking (clearing keys from memory)
 * - Accessing shielded address and balance
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import {
  constructDerivationMessage,
  signatureToMnemonic,
  signatureToEncryptionKey,
} from '../lib/keyDerivation';
import {
  setKeys,
  clearKeys,
  isUnlocked as checkIsUnlocked,
  getWalletId,
  getEncryptionKey,
  setOnLockCallback,
  removeOnLockCallback,
} from '../lib/keyManager';
import {
  generateRailgunAddressAsync,
  getShieldedBalance,
  refreshWalletBalances,
  onBalanceUpdate,
} from '../lib/sdk';
import { isRailgunInitialized, initRailgun } from '../lib/railgun';
import { getHubChain, loadDeployments } from '../config';

// ============ Types ============

export type WalletStatus = 'disconnected' | 'connected' | 'unlocking' | 'unlocked';

interface ShieldedWalletState {
  status: WalletStatus;
  railgunAddress: string | null;
  shieldedBalance: bigint;
  isScanning: boolean;
  error: string | null;
}

interface ShieldedWalletContextValue extends ShieldedWalletState {
  walletId: string | null;
  encryptionKey: string | null;
  unlock: () => Promise<void>;
  lock: () => void;
  refreshBalance: () => Promise<void>;
}

// ============ Context ============

const ShieldedWalletContext = createContext<ShieldedWalletContextValue | null>(null);

// ============ Provider ============

interface ShieldedWalletProviderProps {
  children: ReactNode;
}

export function ShieldedWalletProvider({ children }: ShieldedWalletProviderProps) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [state, setState] = useState<ShieldedWalletState>({
    status: 'disconnected',
    railgunAddress: null,
    shieldedBalance: 0n,
    isScanning: false,
    error: null,
  });

  // Update status when connection changes
  useEffect(() => {
    if (!isConnected) {
      // Clear keys when disconnected
      clearKeys();
      setState({
        status: 'disconnected',
        railgunAddress: null,
        shieldedBalance: 0n,
        isScanning: false,
        error: null,
      });
    } else if (state.status === 'disconnected') {
      // Connected but not unlocked
      setState(prev => ({
        ...prev,
        status: 'connected',
        error: null,
      }));
    }
  }, [isConnected, state.status]);

  // Handle auto-lock callback
  useEffect(() => {
    setOnLockCallback(() => {
      setState(prev => ({
        ...prev,
        status: isConnected ? 'connected' : 'disconnected',
        railgunAddress: null,
        shieldedBalance: 0n,
        error: null,
      }));
    });

    return () => {
      removeOnLockCallback();
    };
  }, [isConnected]);

  // Unlock wallet by signing message
  const unlock = useCallback(async () => {
    if (!address) {
      throw new Error('No wallet connected');
    }

    setState(prev => ({ ...prev, status: 'unlocking', error: null }));

    try {
      // Ensure Railgun SDK is initialized first
      if (!isRailgunInitialized()) {
        console.log('[wallet] Initializing Railgun SDK...');
        await initRailgun();
      }

      // Construct and sign the derivation message
      const message = constructDerivationMessage(address);
      const signature = await signMessageAsync({ message });

      // Debug: log signature for comparison with usdc-v2-frontend
      console.log('[wallet] DEBUG - Message:', message);
      console.log('[wallet] DEBUG - Signature:', signature);

      // Derive mnemonic and encryption key from signature
      const mnemonic = signatureToMnemonic(signature);
      const encryptionKey = signatureToEncryptionKey(signature);

      // Debug: log first word of mnemonic (safe to log)
      console.log('[wallet] DEBUG - Mnemonic first word:', mnemonic.split(' ')[0]);

      // Generate Railgun address and wallet ID using SDK (async)
      console.log('[wallet] Creating Railgun wallet...');
      const { walletId, railgunAddress } = await generateRailgunAddressAsync(
        mnemonic,
        encryptionKey
      );

      // Store keys in key manager
      setKeys(mnemonic, encryptionKey, walletId, railgunAddress);

      // Update state
      setState(prev => ({
        ...prev,
        status: 'unlocked',
        railgunAddress,
        error: null,
      }));

      console.log('Shielded wallet unlocked:', railgunAddress.slice(0, 20) + '...');
    } catch (error) {
      console.error('Failed to unlock wallet:', error);
      setState(prev => ({
        ...prev,
        status: 'connected',
        error: error instanceof Error ? error.message : 'Failed to unlock wallet',
      }));
      throw error;
    }
  }, [address, signMessageAsync]);

  // Lock wallet (clear keys)
  const lock = useCallback(() => {
    clearKeys();
    setState(prev => ({
      ...prev,
      status: isConnected ? 'connected' : 'disconnected',
      railgunAddress: null,
      shieldedBalance: 0n,
      error: null,
    }));
  }, [isConnected]);

  // Refresh shielded balance
  const refreshBalance = useCallback(async () => {
    if (!checkIsUnlocked()) return;

    setState(prev => ({ ...prev, isScanning: true }));

    try {
      // Ensure deployments are loaded to get token address
      await loadDeployments();
      const hubChain = getHubChain();
      const tokenAddress = hubChain.contracts?.mockUSDC;

      if (!tokenAddress) {
        console.warn('[wallet] No MockUSDC address available for hub chain');
        setState(prev => ({ ...prev, isScanning: false }));
        return;
      }

      const walletId = getWalletId();

      // First trigger a balance scan/refresh
      await refreshWalletBalances(walletId);

      // Then get the current balance
      const balance = await getShieldedBalance(walletId, tokenAddress);

      setState(prev => ({
        ...prev,
        shieldedBalance: balance,
        isScanning: false,
      }));
    } catch (error) {
      console.error('Failed to refresh balance:', error);
      setState(prev => ({ ...prev, isScanning: false }));
    }
  }, []);

  // Subscribe to balance update events
  // Note: We DON'T call refreshBalance() here because that would create an infinite loop:
  // refreshBalance() -> refreshWalletBalances() -> SDK emits event -> refreshBalance() -> ...
  // Instead, we just fetch the balance directly without triggering another scan.
  useEffect(() => {
    if (state.status !== 'unlocked') return;

    const unsubscribe = onBalanceUpdate(async (event) => {
      console.log('[wallet] Balance update received:', event);

      // Get the balance directly without triggering another scan
      try {
        await loadDeployments();
        const hubChain = getHubChain();
        const tokenAddress = hubChain.contracts?.mockUSDC;
        if (tokenAddress) {
          const walletId = getWalletId();
          const balance = await getShieldedBalance(walletId, tokenAddress);
          setState(prev => ({
            ...prev,
            shieldedBalance: balance,
          }));
        }
      } catch (error) {
        console.error('[wallet] Failed to update balance from event:', error);
      }
    });

    return () => unsubscribe();
  }, [state.status]);

  // Auto-refresh balance when unlocked
  useEffect(() => {
    if (state.status === 'unlocked') {
      refreshBalance();
    }
  }, [state.status, refreshBalance]);

  // Get wallet credentials from keyManager when unlocked
  const walletId = state.status === 'unlocked' ? getWalletId() : null;
  const encryptionKey = state.status === 'unlocked' ? getEncryptionKey() : null;

  const value: ShieldedWalletContextValue = {
    ...state,
    walletId,
    encryptionKey,
    unlock,
    lock,
    refreshBalance,
  };

  return (
    <ShieldedWalletContext.Provider value={value}>
      {children}
    </ShieldedWalletContext.Provider>
  );
}

// ============ Hook ============

export function useShieldedWallet(): ShieldedWalletContextValue {
  const context = useContext(ShieldedWalletContext);
  if (!context) {
    throw new Error('useShieldedWallet must be used within ShieldedWalletProvider');
  }
  return context;
}
