import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { Header } from './components/layout/Header';
import { BalanceCard } from './components/balance/BalanceCard';
import { DepositForm } from './components/deposit/DepositForm';
import { PayForm } from './components/pay/PayForm';
import { FaucetSection } from './components/faucet/FaucetSection';
import { DebugPanel } from './components/debug/DebugPanel';
import { loadDeployments } from './config';

function App() {
  const { isConnected } = useAccount();
  const [showDebug, setShowDebug] = useState(false);

  // Load deployment addresses on mount
  useEffect(() => {
    loadDeployments();
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <Header />

      <main className="max-w-4xl mx-auto px-4 py-8">
        {!isConnected ? (
          <div className="text-center py-20">
            <h2 className="text-2xl font-bold mb-4">Welcome to Railgun POC</h2>
            <p className="text-gray-400 mb-8">
              Connect your wallet to get started with private USDC transfers.
            </p>
            <div className="inline-block p-4 bg-gray-900 rounded-lg border border-gray-800">
              <p className="text-sm text-yellow-500">
                This is a proof-of-concept demo running on local devnet.
                <br />
                Use test funds only.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Shielded Balance Card */}
            <BalanceCard />

            {/* Two column layout for Deposit and Pay */}
            <div className="grid md:grid-cols-2 gap-6">
              {/* Deposit Form */}
              <DepositForm />

              {/* Pay Form */}
              <PayForm />
            </div>

            {/* Faucet Section */}
            <FaucetSection />

            {/* Debug Panel Toggle */}
            <div className="flex justify-center">
              <button
                onClick={() => setShowDebug(!showDebug)}
                className="text-xs text-gray-500 hover:text-gray-300 underline"
              >
                {showDebug ? 'Hide Debug Panel' : 'Show Debug Panel'}
              </button>
            </div>

            {/* Debug Panel */}
            {showDebug && <DebugPanel />}

            {/* Warning */}
            <div className="p-4 bg-yellow-900/20 border border-yellow-700/50 rounded-lg">
              <p className="text-sm text-yellow-500">
                This is POC software. Do not use with real funds.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
