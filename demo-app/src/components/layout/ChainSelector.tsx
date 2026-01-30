import { useAccount, useSwitchChain } from 'wagmi';
import { supportedChains } from '../../config/wagmi';

export function ChainSelector() {
  const { chain } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  return (
    <select
      value={chain?.id || ''}
      onChange={(e) => switchChain({ chainId: Number(e.target.value) as 31338 | 31337 | 31339 })}
      disabled={isPending}
      className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500"
    >
      {!chain && <option value="">Select Chain</option>}
      {supportedChains.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
