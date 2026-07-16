// ABOUTME: Pins encodeCctpBinding to a fixed vector so it stays byte-identical to Solidity
// ABOUTME: CCTPBindingLib (validated on the contract side by test-foundry/CCTPBindingLib.t.sol).

import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { encodeCctpBinding, CCTP_BINDING_DOMAIN_TAG } from './cctpBinding'

describe('encodeCctpBinding', () => {
  // WHY: the tag must equal keccak256("ArmadaCCTPUnshield.v1") — the exact Solidity DOMAIN_TAG.
  it('uses the versioned domain tag matching Solidity', () => {
    expect(CCTP_BINDING_DOMAIN_TAG).toBe(
      '0x21356b6965af9c07c4d5fb7bc8b7ba6ca11fe531bc1418dd5534bd2269a03825',
    )
  })

  // WHY: fixed vector — if the encoding drifts from Solidity CCTPBindingLib.encode, real cross-chain
  // unshields would revert on the on-chain binding check. This freezes the format.
  it('matches the fixed (recipient, domain, maxFee) vector', () => {
    expect(encodeCctpBinding('0x0000000000000000000000000000000000000A11', 6, 5_000_000n)).toBe(
      '0xc2a828ad2c65e1372bfddbc94a1d500429e6e19c55307305e02e5e766bc32940',
    )
  })

  // WHY: any change to any field must change the commitment (the anti-redirect property).
  it('changes with each field', () => {
    const base = encodeCctpBinding('0x0000000000000000000000000000000000000A11', 6, 5_000_000n)
    expect(encodeCctpBinding('0x000000000000000000000000000000000000bad0', 6, 5_000_000n)).not.toBe(base)
    expect(encodeCctpBinding('0x0000000000000000000000000000000000000A11', 7, 5_000_000n)).not.toBe(base)
    expect(encodeCctpBinding('0x0000000000000000000000000000000000000A11', 6, 5_000_001n)).not.toBe(base)
  })

  // WHY: the domain tag must make it distinct from a bare keccak(recipient, domain, fee) (#378).
  it('is domain-separated from a bare hash', () => {
    const tagged = encodeCctpBinding('0x0000000000000000000000000000000000000A11', 6, 5_000_000n)
    const bare = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint32', 'uint256'],
        ['0x0000000000000000000000000000000000000A11', 6, 5_000_000n],
      ),
    )
    expect(tagged).not.toBe(bare)
  })
})
