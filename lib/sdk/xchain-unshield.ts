// ABOUTME: SDK cross-chain-unshield proof generation for Node scripts/tests — an unshield-to-pool proof
// ABOUTME: that binds the CCTP destination (finalRecipient, domain, maxFee) into adaptParams so the exit can't be redirected.

/**
 * Cross-chain unshield adapt-proof for the Node SDK.
 *
 * Ported from the browser helper apps/armada-interface/src/lib/railgun/unshield.ts
 * (buildXchainUnshieldTransaction) + cctpBinding.ts. Same on-chain entry point
 * (PrivacyPool.atomicCrossChainUnshield), same CCTP destination binding, same Transaction ABI — the
 * only difference is the proof is built with the engine's TransactionBatch + setAdaptID (the Node SDK
 * path used by transfer.ts / yield.ts) rather than the wallet package's generateProofTransactions.
 *
 * Flow: shielded USDC on the hub → unshield to the PrivacyPool itself → the pool CCTP-burns to
 * `destinationDomain`, delivering to `finalRecipient` on the destination chain (via the relayer +
 * CCTP attestation). `adaptContract` is ZeroAddress (a plain unshield-to-pool, NOT a cross-contract
 * relay-adapt call), and the proof's `adaptParams` binds the destination tuple. The hub TransactModule
 * re-derives that binding from the submitted arguments and reverts on any mismatch (#364/#378/#399),
 * so a relayer or front-runner cannot redirect the exit.
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

/**
 * Versioned domain tag — MUST match Solidity `CCTPBindingLib.DOMAIN_TAG`
 * (`keccak256("ArmadaCCTPUnshield.v1")`). Namespaces the adaptParams format.
 */
const CCTP_BINDING_DOMAIN_TAG = ethers.keccak256(ethers.toUtf8Bytes('ArmadaCCTPUnshield.v1'));

/**
 * Encode the cross-chain-unshield destination binding — the value the prover sets as
 * `boundParams.adaptParams`. MUST stay byte-identical to Solidity `CCTPBindingLib.encode`:
 *   keccak256(abi.encode(DOMAIN_TAG, recipient, destinationDomain, maxFee))
 */
export function encodeCctpBinding(recipient: string, destinationDomain: number, maxFee: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint32', 'uint256'],
      [CCTP_BINDING_DOMAIN_TAG, recipient, destinationDomain, maxFee],
    ),
  );
}

/**
 * Coerce the SDK's proved Transaction struct into the exact tuple the on-chain
 * `atomicCrossChainUnshield` ABI expects (strict bigint / hex on every field). Same normalizer as
 * yield.ts — the on-chain `Transaction` struct is identical.
 */
function normalizeTransaction(tx: unknown, hubChainId: number): unknown {
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
 * PrivacyPool cross-chain unshield entry point — mirrors contracts/privacy-pool/PrivacyPool.sol
 * verbatim. Takes the proved Transaction tuple + the plaintext destination args the hub re-derives
 * the adaptParams binding from.
 */
const PRIVACY_POOL_XCHAIN_ABI = [
  'function atomicCrossChainUnshield(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) _transaction, uint32 destinationDomain, address finalRecipient, uint256 maxFee, bytes32 uniqueNonce) returns (uint64)',
];

export interface XchainUnshieldResult {
  /** Ready-to-send tx: to = privacyPoolAddress, data = encoded calldata, value = 0. */
  transaction: { to: string; data: string; value: bigint };
  /** The proved transaction(s) — exposed for circuit-shape logging in tests. */
  transactions: TransactionStructV2[];
}

/**
 * Build the cross-chain unshield tx. Unshields `amount` of `tokenAddress` to the PrivacyPool, binding
 * the CCTP destination (finalRecipient on `destinationDomain`, `maxFee`) into the proof's adaptParams.
 * Self-submitted (no broadcaster fee) — the e2e submits from the deployer EOA.
 */
export async function buildXchainUnshieldTransaction(opts: {
  wallet: RailgunWallet;
  chain: Chain;
  tokenAddress: string;
  privacyPoolAddress: string;
  amount: bigint;
  finalRecipient: string;
  destinationDomain: number;
  maxFee: bigint;
  uniqueNonce: string;
  hubChainId: number;
  encryptionKey?: string;
  progressCallback?: ProofProgressCallback;
}): Promise<XchainUnshieldResult> {
  const encryptionKey = opts.encryptionKey ?? DEFAULT_ENCRYPTION_KEY;
  if (!isProverInitialized()) {
    await initializeProver();
  }

  const adaptParams = encodeCctpBinding(opts.finalRecipient, opts.destinationDomain, opts.maxFee);

  // Unshield the token to the PrivacyPool itself; bind the CCTP destination via the batch's adaptID
  // with adaptContract = ZeroAddress (plain unshield-to-pool — the contract requires adaptContract==0).
  const batch = createTransactionBatch(opts.chain);
  addUnshieldOutput(batch, opts.privacyPoolAddress, opts.amount, opts.tokenAddress);
  batch.setAdaptID({ contract: ethers.ZeroAddress, parameters: adaptParams });

  const transactions = await generateProvedTransactions(
    batch,
    opts.wallet,
    TXIDVersion.V2_PoseidonMerkle,
    encryptionKey,
    opts.progressCallback,
  );
  if (!transactions.length) {
    throw new Error('buildXchainUnshieldTransaction: SDK returned no proved transactions');
  }

  const transaction = normalizeTransaction(transactions[0], opts.hubChainId);
  const iface = new ethers.Interface(PRIVACY_POOL_XCHAIN_ABI);
  const data = iface.encodeFunctionData('atomicCrossChainUnshield', [
    transaction,
    opts.destinationDomain,
    opts.finalRecipient,
    opts.maxFee,
    opts.uniqueNonce,
  ]);

  return {
    transaction: { to: opts.privacyPoolAddress, data, value: 0n },
    transactions,
  };
}
