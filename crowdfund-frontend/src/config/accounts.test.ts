// ABOUTME: Unit tests for Anvil account configuration.
// ABOUTME: Validates account addresses and structure.
import { describe, it, expect } from 'vitest'
import { ANVIL_ACCOUNTS } from './accounts'
import { isAddress } from 'ethers'

describe('ANVIL_ACCOUNTS', () => {
  it('has 10 accounts', () => {
    expect(ANVIL_ACCOUNTS).toHaveLength(10)
  })

  it('all addresses are valid checksummed addresses', () => {
    for (const acc of ANVIL_ACCOUNTS) {
      expect(isAddress(acc.address)).toBe(true)
    }
  })

  it('all private keys start with 0x and are 66 chars', () => {
    for (const acc of ANVIL_ACCOUNTS) {
      expect(acc.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })

  it('account 0 is admin', () => {
    expect(ANVIL_ACCOUNTS[0].role).toBe('admin')
    expect(ANVIL_ACCOUNTS[0].address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
  })

  it('accounts 1-3 are seeds', () => {
    for (let i = 1; i <= 3; i++) {
      expect(ANVIL_ACCOUNTS[i].role).toBe('seed')
    }
  })

  it('accounts 4-6 are hop1', () => {
    for (let i = 4; i <= 6; i++) {
      expect(ANVIL_ACCOUNTS[i].role).toBe('hop1')
    }
  })

  it('accounts 7-9 are hop2', () => {
    for (let i = 7; i <= 9; i++) {
      expect(ANVIL_ACCOUNTS[i].role).toBe('hop2')
    }
  })

  it('has no duplicate addresses', () => {
    const addresses = ANVIL_ACCOUNTS.map((a) => a.address.toLowerCase())
    expect(new Set(addresses).size).toBe(addresses.length)
  })

  it('indexes are sequential 0-9', () => {
    ANVIL_ACCOUNTS.forEach((acc, i) => {
      expect(acc.index).toBe(i)
    })
  })
})
