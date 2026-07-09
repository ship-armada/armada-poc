import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { encodeYieldAdaptParams } from '../yieldAdaptParams'

describe('encodeYieldAdaptParams', () => {
  it('should return a 32-byte keccak256 hash', () => {
    const npk = ethers.hexlify(ethers.randomBytes(32))
    const encryptedBundle: [string, string, string] = [
      ethers.hexlify(ethers.randomBytes(32)),
      ethers.hexlify(ethers.randomBytes(32)),
      ethers.hexlify(ethers.randomBytes(32)),
    ]
    const shieldKey = ethers.hexlify(ethers.randomBytes(32))

    const result = encodeYieldAdaptParams(npk, encryptedBundle, shieldKey)

    expect(result).toMatch(/^0x[0-9a-f]{64}$/)
    expect(ethers.getBytes(result)).toHaveLength(32)
  })

  it('should be deterministic for same inputs', () => {
    const npk = '0x' + '01'.repeat(32)
    const encryptedBundle: [string, string, string] = [
      '0x' + '02'.repeat(32),
      '0x' + '03'.repeat(32),
      '0x' + '04'.repeat(32),
    ]
    const shieldKey = '0x' + '05'.repeat(32)

    const result1 = encodeYieldAdaptParams(npk, encryptedBundle, shieldKey)
    const result2 = encodeYieldAdaptParams(npk, encryptedBundle, shieldKey)

    expect(result1).toBe(result2)
  })

  it('should produce different output for different inputs', () => {
    const npk = '0x' + '01'.repeat(32)
    const encryptedBundle: [string, string, string] = [
      '0x' + '02'.repeat(32),
      '0x' + '03'.repeat(32),
      '0x' + '04'.repeat(32),
    ]
    const shieldKey = '0x' + '05'.repeat(32)

    const result1 = encodeYieldAdaptParams(npk, encryptedBundle, shieldKey)
    const result2 = encodeYieldAdaptParams(
      '0x' + '06'.repeat(32),
      encryptedBundle,
      shieldKey,
    )

    expect(result1).not.toBe(result2)
  })
})
