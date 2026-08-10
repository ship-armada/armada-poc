// ABOUTME: The shield-request builder — builds the on-chain ShieldRequest via @armada/sdk in the
// ABOUTME: interface's ShieldRequestData shape. Consumed by both shield handlers (hub + cross-chain).

import { buildShieldRequest, initPoseidonPromise } from '@armada/sdk'
import type { ShieldRequestData } from './shield'

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function as0x(hex: string): `0x${string}` {
  if (!hex.startsWith('0x')) throw new Error('createShieldRequestSdk: expected a 0x-prefixed hex value')
  return hex as `0x${string}`
}

/**
 * Build a single hub `ShieldRequest` via `@armada/sdk`, returned in the interface's `ShieldRequestData`
 * shape (npk/value/encryptedBundle/shieldKey/random) that the handlers assemble into the on-chain
 * tuple. The note construction is chain-agnostic — cross-chain shield reuses it and only differs in
 * the downstream CCTP wrapping.
 */
export async function createShieldRequestSdk(
  railgunAddress: string,
  amount: bigint,
  tokenAddress: string,
  shieldPrivateKeyHex: string,
): Promise<ShieldRequestData> {
  if (!railgunAddress.startsWith('0zk')) {
    throw new Error('createShieldRequestSdk: recipient must be a 0zk address')
  }
  if (amount <= 0n) {
    throw new Error('createShieldRequestSdk: amount must be positive')
  }
  await initPoseidonPromise
  const { shieldRequest, random } = await buildShieldRequest(
    { railgunAddress, amount, tokenAddress },
    hexToBytes(shieldPrivateKeyHex),
  )
  return {
    npk: as0x(shieldRequest.preimage.npk),
    value: shieldRequest.preimage.value,
    encryptedBundle: [
      as0x(shieldRequest.ciphertext.encryptedBundle[0]),
      as0x(shieldRequest.ciphertext.encryptedBundle[1]),
      as0x(shieldRequest.ciphertext.encryptedBundle[2]),
    ] as const,
    shieldKey: as0x(shieldRequest.ciphertext.shieldKey),
    random,
  }
}
