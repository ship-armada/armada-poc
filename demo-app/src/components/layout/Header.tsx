import { useAccount } from 'wagmi';
import { ConnectButton } from '../wallet/ConnectButton';
import { WalletStatus } from '../wallet/WalletStatus';
import { ChainSelector } from './ChainSelector';

export function Header() {
  const { isConnected } = useAccount();

  return (
    <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-10">
      <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-white">Railgun POC</h1>
          <span className="text-xs px-2 py-0.5 bg-yellow-600/20 text-yellow-500 rounded-full">
            Demo
          </span>
        </div>

        <div className="flex items-center gap-4">
          {isConnected && (
            <>
              <WalletStatus />
              <ChainSelector />
            </>
          )}
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
