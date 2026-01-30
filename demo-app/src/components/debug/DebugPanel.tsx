import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { getHubChain, loadDeployments } from '../../config';

/**
 * Debug Panel for testing SNARK verification
 *
 * Provides buttons to:
 * 1. Test with valid proof (normal unshield)
 * 2. Test with corrupted proof (should fail verification)
 * 3. Check testing mode status
 * 4. Toggle testing mode
 */
export function DebugPanel() {
  const [status, setStatus] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [privacyPoolAddress, setPrivacyPoolAddress] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      await loadDeployments();
      const hub = getHubChain();
      setPrivacyPoolAddress(hub?.contracts?.privacyPool || null);
    };
    load();
  }, []);

  const PRIVACY_POOL_ABI = [
    'function testingMode() view returns (bool)',
    'function setTestingMode(bool enabled)',
    'function verify((tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) transaction) view returns (bool)',
    'function owner() view returns (address)',
  ];

  const checkTestingMode = async () => {
    if (!privacyPoolAddress || !window.ethereum) {
      setStatus('No PrivacyPool address or wallet');
      return;
    }

    try {
      setIsLoading(true);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const pool = new ethers.Contract(privacyPoolAddress, PRIVACY_POOL_ABI, provider);

      const testingMode = await pool.testingMode();
      setStatus(`Testing mode: ${testingMode ? 'ENABLED (proofs bypassed)' : 'DISABLED (proofs verified)'}`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleTestingMode = async () => {
    if (!privacyPoolAddress || !window.ethereum) {
      setStatus('No PrivacyPool address or wallet');
      return;
    }

    try {
      setIsLoading(true);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const pool = new ethers.Contract(privacyPoolAddress, PRIVACY_POOL_ABI, signer);

      const currentMode = await pool.testingMode();
      setStatus(`Toggling testing mode from ${currentMode} to ${!currentMode}...`);

      const tx = await pool.setTestingMode(!currentMode);
      await tx.wait();

      const newMode = await pool.testingMode();
      setStatus(`Testing mode toggled! Now: ${newMode ? 'ENABLED' : 'DISABLED'}`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const testBadProof = async () => {
    if (!privacyPoolAddress || !window.ethereum) {
      setStatus('No PrivacyPool address or wallet');
      return;
    }

    try {
      setIsLoading(true);
      setStatus('Creating transaction with intentionally bad proof...');

      const provider = new ethers.BrowserProvider(window.ethereum);
      const pool = new ethers.Contract(privacyPoolAddress, PRIVACY_POOL_ABI, provider);

      // Create a fake transaction with invalid proof values
      // All zeros will definitely fail verification
      const fakeTransaction = {
        proof: {
          a: { x: 1n, y: 2n },  // Invalid point
          b: { x: [1n, 2n], y: [3n, 4n] },  // Invalid point
          c: { x: 5n, y: 6n },  // Invalid point
        },
        merkleRoot: ethers.zeroPadValue('0x01', 32),  // Fake root
        nullifiers: [ethers.zeroPadValue('0x1234', 32)],
        commitments: [
          ethers.zeroPadValue('0xabcd', 32),
          ethers.zeroPadValue('0xef01', 32),
        ],
        boundParams: {
          treeNumber: 0,
          minGasPrice: 0n,
          unshield: 1,  // NORMAL unshield
          chainID: 31337n,
          adaptContract: ethers.ZeroAddress,
          adaptParams: ethers.zeroPadValue('0x00', 32),
          commitmentCiphertext: [],
        },
        unshieldPreimage: {
          npk: ethers.zeroPadValue('0x9DCadBFA2bCA34FAa28840c4fC391FC421a57921', 32),
          token: {
            tokenType: 0,  // ERC20
            tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',  // USDC
            tokenSubID: 0n,
          },
          value: 1000000n,  // 1 USDC
        },
      };

      setStatus('Calling verify() with bad proof...');

      try {
        const result = await pool.verify(fakeTransaction);
        setStatus(`verify() returned: ${result} - ${result ? 'UNEXPECTED! Proof should have failed!' : 'Proof correctly rejected'}`);
      } catch (verifyErr) {
        const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        if (errMsg.includes('Invalid Merkle Root') || errMsg.includes('Key not set')) {
          setStatus(`Verification failed as expected: ${errMsg}`);
        } else if (errMsg.includes('revert')) {
          setStatus(`Proof verification reverted (expected): ${errMsg.slice(0, 200)}`);
        } else {
          setStatus(`Error during verification: ${errMsg}`);
        }
      }
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const testDirectVerifyCall = async () => {
    if (!privacyPoolAddress || !window.ethereum) {
      setStatus('No PrivacyPool address or wallet');
      return;
    }

    try {
      setIsLoading(true);
      setStatus('Testing direct staticcall to verify()...');

      const provider = new ethers.BrowserProvider(window.ethereum);

      // Encode a minimal verify call with obviously wrong data
      const iface = new ethers.Interface([
        'function verify((tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) transaction) view returns (bool)',
      ]);

      const fakeTransaction = {
        proof: {
          a: { x: 123n, y: 456n },
          b: { x: [789n, 101112n], y: [131415n, 161718n] },
          c: { x: 192021n, y: 222324n },
        },
        merkleRoot: '0x' + '11'.repeat(32),
        nullifiers: ['0x' + '22'.repeat(32)],
        commitments: ['0x' + '33'.repeat(32), '0x' + '44'.repeat(32)],
        boundParams: {
          treeNumber: 0,
          minGasPrice: 0n,
          unshield: 1,
          chainID: 31337n,
          adaptContract: ethers.ZeroAddress,
          adaptParams: '0x' + '00'.repeat(32),
          commitmentCiphertext: [],
        },
        unshieldPreimage: {
          npk: '0x' + '55'.repeat(32),
          token: {
            tokenType: 0,
            tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
            tokenSubID: 0n,
          },
          value: 1000000n,
        },
      };

      const calldata = iface.encodeFunctionData('verify', [fakeTransaction]);

      setStatus('Sending eth_call to verify()...');

      const result = await provider.call({
        to: privacyPoolAddress,
        data: calldata,
      });

      const decoded = iface.decodeFunctionResult('verify', result);
      setStatus(`verify() returned: ${decoded[0]} - ${decoded[0] ? 'Testing mode is ON' : 'Proof rejected (verification working!)'}`);

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('revert') || errMsg.includes('execution reverted')) {
        setStatus(`Verification correctly reverted: ${errMsg.slice(0, 300)}`);
      } else {
        setStatus(`Error: ${errMsg}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (!privacyPoolAddress) {
    return (
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-2">Debug Panel</h3>
        <p className="text-gray-400">Loading deployments...</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h3 className="text-lg font-semibold mb-4">SNARK Verification Debug</h3>

      <div className="space-y-3">
        <div className="text-sm text-gray-400">
          PrivacyPool: <code className="text-xs">{privacyPoolAddress || 'Not found'}</code>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={checkTestingMode}
            disabled={isLoading}
            className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded text-sm"
          >
            Check Testing Mode
          </button>

          <button
            onClick={toggleTestingMode}
            disabled={isLoading}
            className="px-3 py-2 bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 rounded text-sm"
          >
            Toggle Testing Mode
          </button>

          <button
            onClick={testBadProof}
            disabled={isLoading}
            className="px-3 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 rounded text-sm"
          >
            Test Bad Proof
          </button>

          <button
            onClick={testDirectVerifyCall}
            disabled={isLoading}
            className="px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 rounded text-sm"
          >
            Direct Verify Call
          </button>
        </div>

        {status && (
          <div className="mt-3 p-3 bg-gray-900 rounded text-sm font-mono whitespace-pre-wrap break-all">
            {status}
          </div>
        )}

        <div className="mt-4 text-xs text-gray-500">
          <p><strong>Check Testing Mode:</strong> Shows if SNARK verification is bypassed</p>
          <p><strong>Toggle Testing Mode:</strong> Enable/disable proof bypass (owner only)</p>
          <p><strong>Test Bad Proof:</strong> Calls verify() with invalid proof data</p>
          <p><strong>Direct Verify Call:</strong> Raw eth_call to verify function</p>
        </div>
      </div>
    </div>
  );
}
