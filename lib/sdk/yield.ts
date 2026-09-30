// ABOUTME: SDK yield adapt-proof generation for Node scripts/tests — a CrossContractCalls proof that
// ABOUTME: binds the re-shield destination via adaptParams so the ArmadaYieldAdapter can't redirect (lend/redeem).

/**
 * Yield adapt-proof (lend / redeem) for the Node SDK.
 *
 * Ported from the browser helper apps/armada-interface/src/lib/railgun/yield.ts. Same on-chain
 * contract (ArmadaYieldAdapter), same adaptParams binding, same ABI — the only difference is the
 * proof is built with the engine's TransactionBatch + setAdaptID (the Node SDK path used by
 * transfer.ts/prover.ts) rather than the wallet package's high-level generateProofTransactions.
 *
 *   lend   : unshield USDC  → adapter.lendAndShield   → shielded aUSDC (vault shares)
 *   redeem : unshield aUSDC → adapter.redeemAndShield → shielded USDC (principal + yield)
 *
 * A single proof binds the unshield (input token → adapter) and the re-shield (output token →
 * user's 0zk) into one atomic ZK statement; the adapter verifies adaptParams matches the shield
 * destination the proof committed to, so it cannot deviate.
 */

import { Chain } from '@railgun-community/shared-models';
import { RailgunWallet, TXIDVersion, TransactionStructV2 } from '@railgun-community/engine';
import { ethers } from 'ethers';
import {
  createTransactionBatch,
  addUnshieldOutput,
  generateProvedTransactions,
  isProverInitialized,
  initializeProver,
  ProofProgressCallback,
} from './prover';
import { DEFAULT_ENCRYPTION_KEY } from './wallet';

export type YieldAdaptMode = 'lend' | 'redeem';

/**
 * Bind the shield destination into adaptParams. Solidity verifies adaptParams matches
 * keccak256(abi.encode(npk, encryptedBundle, shieldKey)) — divergence reverts. Lend variant.
 */
function encodeYieldAdaptParams(
  npk: string,
  encryptedBundle: [string, string, string],
  shieldKey: string,
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32[3]', 'bytes32'],
    [npk, encryptedBundle, shieldKey],
  );
  return ethers.keccak256(encoded);
}

/**
 * Redeem variant — also binds the broadcaster fee-shield destination + amount into adaptParams.
 * Must match Solidity YieldAdaptParams.encode(npk, bundle, shieldKey, feeNpk, feeBundle,
 * feeShieldKey, feeAmount). For a self-submitted e2e (no relayer) the fee fields are all zero.
 */
function encodeYieldAdaptParamsWithFee(
  npk: string,
  encryptedBundle: [string, string, string],
  shieldKey: string,
  feeNpk: string,
  feeEncryptedBundle: [string, string, string],
  feeShieldKey: string,
  feeAmount: bigint,
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32[3]', 'bytes32', 'bytes32', 'bytes32[3]', 'bytes32', 'uint256'],
    [npk, encryptedBundle, shieldKey, feeNpk, feeEncryptedBundle, feeShieldKey, feeAmount],
  );
  return ethers.keccak256(encoded);
}

/**
 * Normalize the proved Transaction into the tuple the adapter ABI expects (strict bigint / hex).
 * Ported from the interface; defensive against both engine structs and ethers Result proxies.
 */
function normalizeTransactionForAdapter(tx: unknown, hubChainId: number): unknown {
  const toBigInt = (v: unknown): bigint => {
    if (v == null) return 0n;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' || typeof v === 'string') return BigInt(v);
    return 0n;
  };
  const toHex = (v: unknown): string => {
    if (v == null) return ethers.ZeroHash;
    if (typeof v === 'string' && v.startsWith('0x')) return v;
    try {
      return ethers.hexlify(v as ethers.BytesLike);
    } catch {
      return ethers.ZeroHash;
    }
  };
  const t = tx as Record<string, unknown>;
  const bp = t.boundParams as Record<string, unknown> | undefined;
  const rawCiphertext = (bp?.commitmentCiphertext ?? []) as Array<Record<string, unknown> | null | undefined>;
  const defaultCiphertext: [string, string, string, string] = [
    ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash,
  ];
  const commitmentCiphertext = rawCiphertext
    .filter((c): c is Record<string, unknown> => c != null)
    .map((c) => {
      const ct = c.ciphertext as string[] | undefined;
      const arr = Array.isArray(ct) && ct.length >= 4
        ? [ct[0], ct[1], ct[2], ct[3]] as [string, string, string, string]
        : defaultCiphertext;
      return {
        ciphertext: arr,
        blindedSenderViewingKey: (c.blindedSenderViewingKey ?? ethers.ZeroHash) as string,
        blindedReceiverViewingKey: (c.blindedReceiverViewingKey ?? ethers.ZeroHash) as string,
        annotationData: (c.annotationData ?? '0x') as string,
        memo: (c.memo ?? '0x') as string,
      };
    });

  const up = t.unshieldPreimage as Record<string, unknown> | undefined;
  const token = (up?.token ?? {}) as Record<string, unknown>;
  const unshieldPreimage = {
    npk: toHex(up?.npk) || ethers.ZeroHash,
    token: {
      tokenType: Number(token.tokenType ?? 0),
      tokenAddress: (token.tokenAddress != null ? String(token.tokenAddress) : ethers.ZeroAddress) as string,
      tokenSubID: toBigInt(token.tokenSubID),
    },
    value: toBigInt(up?.value),
  };

  const proof = t.proof as Record<string, unknown> | undefined;
  const pa = (proof?.a ?? {}) as Record<string, unknown>;
  const pb = (proof?.b ?? {}) as Record<string, unknown>;
  const pc = (proof?.c ?? {}) as Record<string, unknown>;
  const pbx = pb.x as unknown[] | undefined;
  const pby = pb.y as unknown[] | undefined;
  const snarkProof = {
    a: { x: toBigInt(pa.x), y: toBigInt(pa.y) },
    b: {
      x: [toBigInt(pbx?.[0]), toBigInt(pbx?.[1])] as [bigint, bigint],
      y: [toBigInt(pby?.[0]), toBigInt(pby?.[1])] as [bigint, bigint],
    },
    c: { x: toBigInt(pc.x), y: toBigInt(pc.y) },
  };

  return {
    proof: snarkProof,
    merkleRoot: toHex(t.merkleRoot) || ethers.ZeroHash,
    nullifiers: ((t.nullifiers ?? []) as unknown[]).map((n) => toHex(n) || ethers.ZeroHash) as string[],
    commitments: ((t.commitments ?? []) as unknown[]).map((c) => toHex(c) || ethers.ZeroHash) as string[],
    boundParams: {
      treeNumber: Number(bp?.treeNumber ?? 0),
      minGasPrice: toBigInt(bp?.minGasPrice),
      unshield: Number(bp?.unshield ?? 1),
      chainID: toBigInt(bp?.chainID) || BigInt(hubChainId),
      adaptContract: (bp?.adaptContract != null ? String(bp.adaptContract) : ethers.ZeroAddress) as string,
      adaptParams: toHex(bp?.adaptParams) || ethers.ZeroHash,
      commitmentCiphertext,
    },
    unshieldPreimage,
  };
}

/**
 * Adapter entry points — mirrors contracts/yield/ArmadaYieldAdapter.sol verbatim. Both take the
 * same Transaction tuple + the user's shield destination; redeem additionally takes the fee
 * destination + amount.
 */
const ADAPTER_ABI = [
  'function lendAndShield(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) _transaction, bytes32 _npk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext) returns (uint256)',
  'function redeemAndShield(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) _transaction, bytes32 _npk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext, bytes32 _feeNpk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _feeShieldCiphertext, uint256 _feeAmount) returns (uint256)',
];

export interface YieldAdaptResult {
  /** Ready-to-send tx: to = adapterAddress, data = encoded calldata, value = 0. */
  transaction: { to: string; data: string; value: bigint };
  /** The proved transaction(s) — exposed for circuit-shape logging in tests. */
  transactions: TransactionStructV2[];
}

/**
 * Build the adapt-proof tx for a lend OR redeem. `unshieldToken` is what we spend; `shieldOutputToken`
 * is what we receive back into the pool. The relayer fee is optional (default 0 for self-submitted
 * e2e); when >0 the redeem path binds the relayer's own 0zk destination into adaptParams (#312).
 */
export async function buildYieldAdaptTransaction(opts: {
  wallet: RailgunWallet;
  chain: Chain;
  mode: YieldAdaptMode;
  unshieldToken: string;
  shieldOutputToken: string;
  amount: bigint;
  railgunAddress: string;
  adapterAddress: string;
  hubChainId: number;
  encryptionKey?: string;
  /** Redeem broadcaster fee in shieldOutputToken units; 0 (default) = no fee (self-submitted). */
  feeAmount?: bigint;
  /** Relayer's 0zk address to shield the fee to; required only when feeAmount > 0. */
  feeRecipientRailgunAddress?: string;
  progressCallback?: ProofProgressCallback;
}): Promise<YieldAdaptResult> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RelayAdaptHelper, ByteUtils } = require('@railgun-community/engine');

  const encryptionKey = opts.encryptionKey ?? DEFAULT_ENCRYPTION_KEY;
  if (!isProverInitialized()) {
    await initializeProver();
  }

  // 16-byte random binds the resulting shield request — the adapter receives this same value as
  // part of the shield ciphertext and derives identical commitments.
  const shieldRandom = ByteUtils.randomHex(16);
  const relayShieldRequests = await RelayAdaptHelper.generateRelayShieldRequests(
    shieldRandom,
    [{ tokenAddress: opts.shieldOutputToken, recipientAddress: opts.railgunAddress }],
    [],
  );
  if (relayShieldRequests.length === 0) {
    throw new Error('buildYieldAdaptTransaction: failed to generate relay shield request');
  }
  const shieldRequest = relayShieldRequests[0];
  const npk = String(shieldRequest.preimage.npk);
  const encryptedBundle = [
    String(shieldRequest.ciphertext.encryptedBundle[0]),
    String(shieldRequest.ciphertext.encryptedBundle[1]),
    String(shieldRequest.ciphertext.encryptedBundle[2]),
  ] as [string, string, string];
  const shieldKey = String(shieldRequest.ciphertext.shieldKey);

  const isRedeem = opts.mode === 'redeem';
  const feeAmount = isRedeem ? (opts.feeAmount ?? 0n) : 0n;

  // Redeem binds the fee-shield destination into adaptParams (all-zero when feeAmount is 0).
  let feeNpk = ethers.ZeroHash;
  let feeEncryptedBundle: [string, string, string] = [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash];
  let feeShieldKey = ethers.ZeroHash;
  if (isRedeem && feeAmount > 0n) {
    if (!opts.feeRecipientRailgunAddress) {
      throw new Error('buildYieldAdaptTransaction: feeAmount > 0 requires feeRecipientRailgunAddress');
    }
    const feeShieldRandom = ByteUtils.randomHex(16);
    const feeShieldReqs = await RelayAdaptHelper.generateRelayShieldRequests(
      feeShieldRandom,
      [{ tokenAddress: opts.shieldOutputToken, recipientAddress: opts.feeRecipientRailgunAddress }],
      [],
    );
    if (feeShieldReqs.length === 0) {
      throw new Error('buildYieldAdaptTransaction: failed to generate relayer fee shield request');
    }
    const feeReq = feeShieldReqs[0];
    feeNpk = String(feeReq.preimage.npk);
    feeEncryptedBundle = [
      String(feeReq.ciphertext.encryptedBundle[0]),
      String(feeReq.ciphertext.encryptedBundle[1]),
      String(feeReq.ciphertext.encryptedBundle[2]),
    ];
    feeShieldKey = String(feeReq.ciphertext.shieldKey);
  }

  const adaptParams = isRedeem
    ? encodeYieldAdaptParamsWithFee(npk, encryptedBundle, shieldKey, feeNpk, feeEncryptedBundle, feeShieldKey, feeAmount)
    : encodeYieldAdaptParams(npk, encryptedBundle, shieldKey);

  // Build the CrossContractCalls proof: unshield the input token to the adapter, and bind the
  // adapter + adaptParams via the batch's adaptID so the proof commits to the shield destination.
  const batch = createTransactionBatch(opts.chain);
  addUnshieldOutput(batch, opts.adapterAddress, opts.amount, opts.unshieldToken);
  batch.setAdaptID({ contract: opts.adapterAddress, parameters: adaptParams });

  const transactions = await generateProvedTransactions(
    batch,
    opts.wallet,
    TXIDVersion.V2_PoseidonMerkle,
    encryptionKey,
    opts.progressCallback,
  );
  if (!transactions.length) {
    throw new Error('buildYieldAdaptTransaction: SDK returned no proved transactions');
  }

  const transaction = normalizeTransactionForAdapter(transactions[0], opts.hubChainId);
  const iface = new ethers.Interface(ADAPTER_ABI);
  const data = isRedeem
    ? iface.encodeFunctionData('redeemAndShield', [
        transaction,
        npk,
        { encryptedBundle, shieldKey },
        feeNpk,
        { encryptedBundle: feeEncryptedBundle, shieldKey: feeShieldKey },
        feeAmount,
      ])
    : iface.encodeFunctionData('lendAndShield', [transaction, npk, { encryptedBundle, shieldKey }]);

  return {
    transaction: { to: opts.adapterAddress, data, value: 0n },
    transactions,
  };
}
