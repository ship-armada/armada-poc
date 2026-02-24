/**
 * Normalize Railgun SDK transaction to PrivacyPool/Adapter format.
 * Handles null/undefined and structure mismatches (e.g. commitmentCiphertext).
 */

import { ethers } from 'ethers'
import { getHubChainId } from '@/config/networkConfig'

export function normalizeTransactionForAdapter(tx: unknown): {
  proof: { a: { x: bigint; y: bigint }; b: { x: [bigint, bigint]; y: [bigint, bigint] }; c: { x: bigint; y: bigint } }
  merkleRoot: string
  nullifiers: string[]
  commitments: string[]
  boundParams: {
    treeNumber: number
    minGasPrice: bigint
    unshield: number
    chainID: bigint
    adaptContract: string
    adaptParams: string
    commitmentCiphertext: Array<{
      ciphertext: [string, string, string, string]
      blindedSenderViewingKey: string
      blindedReceiverViewingKey: string
      annotationData: string
      memo: string
    }>
  }
  unshieldPreimage: {
    npk: string
    token: { tokenType: number; tokenAddress: string; tokenSubID: bigint }
    value: bigint
  }
} {
  const toBigInt = (v: unknown): bigint => {
    if (v == null) return 0n
    if (typeof v === 'bigint') return v
    if (typeof v === 'number' || typeof v === 'string') return BigInt(v)
    return 0n
  }
  const toHex = (v: unknown): string => {
    if (v == null) return ethers.ZeroHash
    if (typeof v === 'string' && v.startsWith('0x')) return v
    try {
      return ethers.hexlify(v as ethers.BytesLike)
    } catch {
      return ethers.ZeroHash
    }
  }
  const t = tx as Record<string, unknown>
  const bp = t.boundParams as Record<string, unknown> | undefined
  const rawCiphertext = (bp?.commitmentCiphertext ?? []) as Array<Record<string, unknown> | null | undefined>
  const defaultCiphertext: [string, string, string, string] = [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash]
  const commitmentCiphertext = rawCiphertext
    .filter((c): c is Record<string, unknown> => c != null)
    .map((c) => {
      const ct = c.ciphertext as string[] | undefined
      const arr = Array.isArray(ct) && ct.length >= 4
        ? [ct[0], ct[1], ct[2], ct[3]] as [string, string, string, string]
        : defaultCiphertext
      return {
        ciphertext: arr,
        blindedSenderViewingKey: (c.blindedSenderViewingKey ?? ethers.ZeroHash) as string,
        blindedReceiverViewingKey: (c.blindedReceiverViewingKey ?? ethers.ZeroHash) as string,
        annotationData: (c.annotationData ?? '0x') as string,
        memo: (c.memo ?? '0x') as string,
      }
    })

  const up = t.unshieldPreimage as Record<string, unknown> | undefined
  const token = (up?.token ?? {}) as Record<string, unknown>
  const unshieldPreimage = {
    npk: toHex(up?.npk) || ethers.ZeroHash,
    token: {
      tokenType: Number(token.tokenType ?? 0),
      tokenAddress: (token.tokenAddress != null ? String(token.tokenAddress) : ethers.ZeroAddress) as string,
      tokenSubID: toBigInt(token.tokenSubID),
    },
    value: toBigInt(up?.value),
  }

  const proof = t.proof as Record<string, unknown> | undefined
  const pa = (proof?.a ?? {}) as Record<string, unknown>
  const pb = (proof?.b ?? {}) as Record<string, unknown>
  const pc = (proof?.c ?? {}) as Record<string, unknown>
  const pbx = pb.x as unknown[] | undefined
  const pby = pb.y as unknown[] | undefined
  const snarkProof = {
    a: { x: toBigInt(pa.x), y: toBigInt(pa.y) },
    b: {
      x: [toBigInt(pbx?.[0]), toBigInt(pbx?.[1])] as [bigint, bigint],
      y: [toBigInt(pby?.[0]), toBigInt(pby?.[1])] as [bigint, bigint],
    },
    c: { x: toBigInt(pc.x), y: toBigInt(pc.y) },
  }

  return {
    proof: snarkProof,
    merkleRoot: toHex(t.merkleRoot) || ethers.ZeroHash,
    nullifiers: ((t.nullifiers ?? []) as unknown[]).map((n) => toHex(n) || ethers.ZeroHash) as string[],
    commitments: ((t.commitments ?? []) as unknown[]).map((c) => toHex(c) || ethers.ZeroHash) as string[],
    boundParams: {
      treeNumber: Number(bp?.treeNumber ?? 0),
      minGasPrice: toBigInt(bp?.minGasPrice),
      unshield: Number(bp?.unshield ?? 1),
      chainID: toBigInt(bp?.chainID) || BigInt(getHubChainId()),
      adaptContract: (bp?.adaptContract != null ? String(bp.adaptContract) : ethers.ZeroAddress) as string,
      adaptParams: toHex(bp?.adaptParams) || ethers.ZeroHash,
      commitmentCiphertext,
    },
    unshieldPreimage,
  }
}
