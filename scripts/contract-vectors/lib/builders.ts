/**
 * Calldata builders for pool operations: ShieldRequest / Transaction structs,
 * unshield-note Poseidon hashing, and EIP-2612 permit signing.
 *
 * Struct shapes are ABI-pinned to specs/PRIVACY_POOL_CONTRACT.md §3.
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
// @ts-ignore - circomlibjs has no bundled types (same pattern as test/privacy_pool_integration.ts)
import { buildPoseidon } from "circomlibjs";
import { d32, d32Field, SNARK_SCALAR_FIELD } from "./util";

export const UnshieldType = { NONE: 0, NORMAL: 1, REDIRECT: 2 } as const;

// ── Poseidon (off-chain, circomlib parameters — matches PoseidonT4 on-chain) ──

let poseidonInstance: any = null;
let poseidonF: any = null;

export async function initPoseidon(): Promise<void> {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
    poseidonF = poseidonInstance.F;
  }
}

/**
 * commitmentHash(preimage) = PoseidonT4([npk, tokenID, value])  (spec §2.2).
 * Used to build the unshield-output commitment (spec §8.3 check 6).
 */
export function commitmentHash(npk: string, tokenAddress: string, value: bigint): string {
  if (!poseidonInstance) throw new Error("initPoseidon() not called");
  const tokenId = BigInt(tokenAddress); // ERC20 tokenID = uint256(uint160(token))
  const h = poseidonInstance([BigInt(npk), tokenId, value]);
  const out = poseidonF.toObject(h) as bigint;
  return ethers.zeroPadValue(ethers.toBeHex(out % SNARK_SCALAR_FIELD), 32);
}

// ── ShieldRequest ────────────────────────────────────────────────────────────

export interface TokenDataStruct {
  tokenType: number;
  tokenAddress: string;
  tokenSubID: number;
}

export function erc20Token(tokenAddress: string): TokenDataStruct {
  return { tokenType: 0, tokenAddress, tokenSubID: 0 };
}

export function makeShieldRequest(
  seed: string,
  token: TokenDataStruct,
  value: bigint,
  npk?: string
) {
  return {
    preimage: {
      npk: npk ?? d32Field(`npk:${seed}`),
      token,
      value,
    },
    ciphertext: {
      encryptedBundle: [d32(`${seed}:eb0`), d32(`${seed}:eb1`), d32(`${seed}:eb2`)],
      shieldKey: d32(`${seed}:sk`),
    },
  };
}

// ── Transaction ──────────────────────────────────────────────────────────────

const DUMMY_PROOF = {
  a: { x: 0, y: 0 },
  b: {
    x: [0, 0],
    y: [0, 0],
  },
  c: { x: 0, y: 0 },
};

export interface TransactionSpec {
  seed: string;
  nullifierCount: number;
  commitmentCount: number;
  merkleRoot: string;
  treeNumber: number;
  chainId: number;
  unshield?: number; // UnshieldType
  /** Required when unshield != NONE. */
  unshieldPreimage?: {
    npk: string;
    token: TokenDataStruct;
    value: bigint;
  };
  /** Overrides the derived nullifiers (e.g. double-spend replay). */
  nullifiers?: string[];
  /** Overrides the derived commitments. */
  commitments?: string[];
}

export function makeCiphertext(seed: string, i: number) {
  return {
    ciphertext: [
      d32(`${seed}:cc${i}:0`),
      d32(`${seed}:cc${i}:1`),
      d32(`${seed}:cc${i}:2`),
      d32(`${seed}:cc${i}:3`),
    ],
    blindedSenderViewingKey: d32(`${seed}:cc${i}:bsvk`),
    blindedReceiverViewingKey: d32(`${seed}:cc${i}:brvk`),
    annotationData: "0x",
    memo: "0x",
  };
}

/**
 * Build a Transaction struct. In testingMode the router's verify() returns true
 * without touching the proof, so the proof is a zero struct and nullifiers /
 * commitments are deterministic field elements.
 *
 * For unshield transactions the LAST commitment is the unshield-output note
 * hash (spec §8.3 check 6) and the ciphertext array has one fewer entry.
 */
export function makeTransaction(spec: TransactionSpec) {
  const unshield = spec.unshield ?? 0;
  const nullifiers =
    spec.nullifiers ??
    Array.from({ length: spec.nullifierCount }, (_, i) => d32Field(`${spec.seed}:n${i}`));

  let commitments: string[];
  if (spec.commitments) {
    commitments = spec.commitments;
  } else {
    commitments = Array.from({ length: spec.commitmentCount }, (_, i) =>
      d32Field(`${spec.seed}:c${i}`)
    );
    if (unshield !== 0) {
      if (!spec.unshieldPreimage) throw new Error("unshield tx requires unshieldPreimage");
      const up = spec.unshieldPreimage;
      // For REDIRECT the hash binds msg.sender instead of the preimage npk —
      // the caller passes the already-substituted npk in that case.
      commitments[commitments.length - 1] = commitmentHash(
        up.npk,
        up.token.tokenAddress,
        up.value
      );
    }
  }

  const ciphertextCount =
    unshield !== 0 ? spec.commitmentCount - 1 : spec.commitmentCount;
  const commitmentCiphertext = Array.from({ length: ciphertextCount }, (_, i) =>
    makeCiphertext(spec.seed, i)
  );

  return {
    proof: DUMMY_PROOF,
    merkleRoot: spec.merkleRoot,
    nullifiers,
    commitments,
    boundParams: {
      treeNumber: spec.treeNumber,
      minGasPrice: 0,
      unshield,
      chainID: spec.chainId,
      adaptContract: ethers.ZeroAddress,
      adaptParams: ethers.ZeroHash,
      commitmentCiphertext,
    },
    unshieldPreimage: spec.unshieldPreimage ?? {
      npk: ethers.ZeroHash,
      token: { tokenType: 0, tokenAddress: ethers.ZeroAddress, tokenSubID: 0 },
      value: 0,
    },
  };
}

// ── EIP-2612 permit ──────────────────────────────────────────────────────────

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export async function signPermit(
  signer: Signer,
  usdc: { name(): Promise<string>; nonces(owner: string): Promise<bigint>; getAddress(): Promise<string> },
  spender: string,
  value: bigint,
  deadline: bigint,
  chainId: number
): Promise<{ v: number; r: string; s: string }> {
  const domain = {
    name: await usdc.name(),
    version: "1",
    chainId,
    verifyingContract: await usdc.getAddress(),
  };
  const owner = await signer.getAddress();
  const nonce = await usdc.nonces(owner);
  const sig = await (signer as any).signTypedData(domain, PERMIT_TYPES, {
    owner,
    spender,
    value,
    nonce,
    deadline,
  });
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s };
}
