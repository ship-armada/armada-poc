/**
 * Yield Adapt Params
 *
 * Mirrors Solidity YieldAdaptParams.encode for binding shield destination
 * in trustless lend/redeem flows. The adaptParams field in a transaction
 * binds the re-shield destination so the adapter cannot deviate.
 */

import { ethers } from 'ethers'

/**
 * Encode yield operation parameters into adaptParams
 * Must match Solidity: keccak256(abi.encode(npk, encryptedBundle, shieldKey))
 *
 * @param npk Note public key for re-shielding (user's receiving key)
 * @param encryptedBundle Shield ciphertext bundle [3]
 * @param shieldKey Public key used to generate shared encryption key
 * @returns adaptParams Keccak256 hash of all parameters
 */
export function encodeYieldAdaptParams(
  npk: string,
  encryptedBundle: [string, string, string],
  shieldKey: string,
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32[3]', 'bytes32'],
    [npk, encryptedBundle, shieldKey],
  )
  return ethers.keccak256(encoded)
}
