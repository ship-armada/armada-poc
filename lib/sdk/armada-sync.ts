// ABOUTME: Live-provider glue for the @armada/sdk sync engine — wires an ethers provider's pool logs
// ABOUTME: through the SDK decoder + scan orchestrator to produce shielded balances for one wallet.

import { Interface, type Provider } from 'ethers';
import {
  fetchLogsRanged,
  decodePoolEvents,
  WalletScanState,
  tryDecryptCommitment,
  tryDecryptShield,
  POOL_V2_EVENT_ABI,
  type ParsedPoolLog,
  type TokenBalance,
} from '@armada/sdk';
import {
  getTokenDataERC20,
  getTokenDataHash,
  ChainType,
  initPoseidonPromise,
  type TokenData,
} from '@armada/sdk/core';

/** The wallet key material the armada scan needs (from `deriveKeyset`). */
export interface ArmadaScanWallet {
  readonly masterPublicKey: bigint;
  readonly viewingPublicKey: Uint8Array;
  readonly viewingPrivateKey: Uint8Array;
  readonly nullifyingKey: bigint;
}

export interface ArmadaScanParams {
  readonly provider: Provider;
  readonly poolAddress: string;
  readonly deployBlock: number;
  readonly headBlock: number;
  readonly chainId: number;
  /** ERC20 token addresses in play — used to resolve tokenHash → tokenData during note decryption. */
  readonly tokenAddresses: readonly string[];
  readonly wallet: ArmadaScanWallet;
  /** Per-provider getLogs range cap (bisected on over-range throws). */
  readonly maxRange?: number;
}

/**
 * Scan the pool's Shield/Transact/Nullified logs over `[deployBlock, headBlock]` with the SDK sync
 * engine and return the wallet's per-token spendable/pending balances. Pure read path: builds an
 * ephemeral in-memory tree/TXO set (no persistence) — the differential's armada side.
 */
export async function scanArmadaBalances(params: ArmadaScanParams): Promise<TokenBalance[]> {
  await initPoseidonPromise;
  const iface = new Interface(POOL_V2_EVENT_ABI as unknown as string[]);

  // tokenHash → tokenData registry for the note tokenDataGetter (keyed by the canonical no-0x hash).
  const tokenByHash = new Map<string, TokenData>();
  for (const address of params.tokenAddresses) {
    const tokenData = getTokenDataERC20(address);
    tokenByHash.set(getTokenDataHash(tokenData), tokenData);
  }
  const tokenDataGetter = {
    getTokenDataFromHash: async (_v: unknown, _c: unknown, tokenHash: string): Promise<TokenData> => {
      const key = tokenHash.startsWith('0x') ? tokenHash.slice(2) : tokenHash;
      const tokenData = tokenByHash.get(key);
      if (tokenData === undefined) throw new Error(`armada-sync: unknown token hash ${tokenHash}`);
      return tokenData;
    },
  };

  // getLogs adapter: fetch the pool's logs for a window and parse them into ParsedPoolLog[].
  const getLogs = async (fromBlock: number, toBlock: number): Promise<ParsedPoolLog[]> => {
    const logs = await params.provider.getLogs({ address: params.poolAddress, fromBlock, toBlock });
    const parsed: ParsedPoolLog[] = [];
    for (const log of logs) {
      const desc = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (desc === null) continue; // not one of our pool events
      parsed.push({
        name: desc.name,
        args: desc.args as unknown as ParsedPoolLog['args'],
        blockNumber: log.blockNumber,
        txid: log.transactionHash,
      });
    }
    return parsed;
  };

  const parsedLogs = await fetchLogsRanged(getLogs, {
    fromBlock: params.deployBlock,
    toBlock: params.headBlock,
    ...(params.maxRange !== undefined ? { maxRange: params.maxRange } : {}),
  });
  const decoded = decodePoolEvents(parsedLogs);

  const receiver = {
    addressData: { masterPublicKey: params.wallet.masterPublicKey, viewingPublicKey: params.wallet.viewingPublicKey },
    viewingPrivateKey: params.wallet.viewingPrivateKey,
  };
  const chain = { type: ChainType.EVM, id: params.chainId };

  const state = new WalletScanState();
  await state.apply(decoded, {
    transact: (commitment) => tryDecryptCommitment(commitment.ciphertext, receiver, tokenDataGetter, chain),
    shield: (commitment) => tryDecryptShield(commitment, receiver),
  });

  // finalityThreshold 0 — a local differential compares fully-confirmed balances at `headBlock`.
  return state.balances(params.wallet.nullifyingKey, { currentBlock: params.headBlock, finalityThreshold: 0 });
}
