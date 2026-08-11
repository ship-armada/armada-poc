// ABOUTME: Unit test for buildYieldAdaptSdk — plans an unshield-to-adapter with a re-shield-bundle adaptParams
// ABOUTME: (deposit vs redeem), and encodes lendAndShield / redeemAndShield from the proved transaction tuple.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  planTransfer: vi.fn(),
  prove: vi.fn(),
  buildShieldRequest: vi.fn(),
  generateShieldPrivateKey: vi.fn(() => new Uint8Array(32)),
  encodeYieldDepositBinding: vi.fn(() => '0xdepositbinding'),
  encodeYieldRedeemBinding: vi.fn(() => '0xredeembinding'),
  transactionToTuple: vi.fn(() => ['TUPLE']),
  encodeFunctionData: vi.fn(() => '0xcalldata'),
}))
vi.mock('@armada/sdk', () => ({
  buildShieldRequest: hoisted.buildShieldRequest,
  generateShieldPrivateKey: hoisted.generateShieldPrivateKey,
  encodeYieldDepositBinding: hoisted.encodeYieldDepositBinding,
  encodeYieldRedeemBinding: hoisted.encodeYieldRedeemBinding,
  transactionToTuple: hoisted.transactionToTuple,
}))
vi.mock('ethers', () => ({
  // A regular function (not arrow) so `new ethers.Interface(...)` works as a constructor.
  ethers: { Interface: vi.fn(function () { return { encodeFunctionData: hoisted.encodeFunctionData } }) },
}))
vi.mock('./sdk-read', () => ({
  getSdkWallet: async () => ({ planTransfer: hoisted.planTransfer, prove: hoisted.prove }),
}))

import { buildYieldAdaptSdk } from './yield-sdk'

const USDC = '0xaaaa000000000000000000000000000000000000' as const
const VAULT = '0xbbbb000000000000000000000000000000000000' as const
const ADAPTER = '0xcccc000000000000000000000000000000000000' as const
const NPK = `0x${'11'.repeat(32)}`
const FEE_NPK = `0x${'22'.repeat(32)}`
const BUNDLE: [string, string, string] = [`0x${'a1'.repeat(32)}`, `0x${'a2'.repeat(32)}`, `0x${'a3'.repeat(32)}`]
const SHIELD_KEY = `0x${'bb'.repeat(32)}`

function shieldReqReturning(npk: string, random: string) {
  return {
    shieldRequest: { preimage: { npk }, ciphertext: { encryptedBundle: BUNDLE, shieldKey: SHIELD_KEY } },
    random,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.planTransfer.mockResolvedValue({ plan: true })
  hoisted.prove.mockResolvedValue({ toTransactionData: () => ({ tx: 'data' }) })
  hoisted.transactionToTuple.mockReturnValue(['TUPLE'])
  hoisted.encodeFunctionData.mockReturnValue('0xcalldata')
})

describe('buildYieldAdaptSdk', () => {
  it('deposit (lend): plans unshield USDC→adapter with the deposit binding + SDK fee leg, encodes lendAndShield', async () => {
    hoisted.buildShieldRequest.mockResolvedValueOnce(shieldReqReturning(NPK, 'r-user'))
    const r = await buildYieldAdaptSdk({
      mode: 'lend',
      amount: 5_000_000n,
      unshieldToken: USDC,
      shieldOutputToken: VAULT,
      adapterAddress: ADAPTER,
      shieldedAddress: '0zk_user',
      broadcasterFee: { amount: 20_000n, recipientAddress: '0zk_relayer' },
    })
    // Re-shield destination is the USER's 0zk in the OUTPUT token (ayUSDC shares).
    expect(hoisted.buildShieldRequest).toHaveBeenCalledTimes(1)
    expect(hoisted.buildShieldRequest.mock.calls[0]![0]).toEqual({ shieldedAddress: '0zk_user', amount: 0n, tokenAddress: VAULT })
    // Deposit binding over (npk, bundle, shieldKey).
    expect(hoisted.encodeYieldDepositBinding).toHaveBeenCalledWith(BigInt(NPK), BUNDLE, SHIELD_KEY)
    // Unshield goes TO the adapter (adaptContract = adapter), token = USDC, plus the SDK fee leg.
    expect(hoisted.planTransfer).toHaveBeenCalledWith({
      outputs: [],
      unshield: { recipient: ADAPTER, amount: 5_000_000n, adaptContract: ADAPTER, adaptParams: '0xdepositbinding' },
      tokenAddress: USDC,
      fee: { schedule: { transfer: '20000' }, broadcasterShieldedAddress: '0zk_relayer', feesCacheId: '', expiresAt: 0 },
    })
    // lendAndShield(transaction tuple, npk, shieldCiphertext).
    expect(hoisted.encodeFunctionData).toHaveBeenCalledWith('lendAndShield', [['TUPLE'], NPK, { encryptedBundle: BUNDLE, shieldKey: SHIELD_KEY }])
    expect(r).toEqual({ to: ADAPTER, data: '0xcalldata' })
    expect(r.feeShieldRandom).toBeUndefined() // deposit has no contract-side fee note
  })

  it('redeem: plans unshield shares→adapter, builds the fee re-shield bundle, encodes redeemAndShield + surfaces feeShieldRandom', async () => {
    hoisted.buildShieldRequest
      .mockResolvedValueOnce(shieldReqReturning(NPK, 'r-user'))   // user bundle
      .mockResolvedValueOnce(shieldReqReturning(FEE_NPK, 'r-fee')) // relayer fee bundle
    const r = await buildYieldAdaptSdk({
      mode: 'redeem',
      amount: 3_000_000n, // shares
      unshieldToken: VAULT,
      shieldOutputToken: USDC,
      adapterAddress: ADAPTER,
      shieldedAddress: '0zk_user',
      broadcasterFee: { amount: 15_000n, recipientAddress: '0zk_relayer' },
    })
    // Two bundles: user (USDC out) + relayer fee note (USDC out).
    expect(hoisted.buildShieldRequest).toHaveBeenCalledTimes(2)
    expect(hoisted.buildShieldRequest.mock.calls[1]![0]).toEqual({ shieldedAddress: '0zk_relayer', amount: 0n, tokenAddress: USDC })
    // Redeem binding covers user + fee bundle + feeAmount.
    expect(hoisted.encodeYieldRedeemBinding).toHaveBeenCalledWith(BigInt(NPK), BUNDLE, SHIELD_KEY, BigInt(FEE_NPK), BUNDLE, SHIELD_KEY, 15_000n)
    // Redeem plans with NO SDK fee leg (fee is contract-side), token = shares (ayUSDC).
    expect(hoisted.planTransfer).toHaveBeenCalledWith({
      outputs: [],
      unshield: { recipient: ADAPTER, amount: 3_000_000n, adaptContract: ADAPTER, adaptParams: '0xredeembinding' },
      tokenAddress: VAULT,
      fee: { schedule: { transfer: '0' }, broadcasterShieldedAddress: '', feesCacheId: '', expiresAt: 0 },
    })
    expect(hoisted.encodeFunctionData).toHaveBeenCalledWith('redeemAndShield', [['TUPLE'], NPK, { encryptedBundle: BUNDLE, shieldKey: SHIELD_KEY }, FEE_NPK, { encryptedBundle: BUNDLE, shieldKey: SHIELD_KEY }, 15_000n])
    expect(r.feeShieldRandom).toBe('r-fee') // #312 — surfaced for the relayer's npk-reconstruction check
  })

  it('redeem wallet-override (no broadcaster fee): zero fee bundle, no feeShieldRandom', async () => {
    hoisted.buildShieldRequest.mockResolvedValueOnce(shieldReqReturning(NPK, 'r-user'))
    const r = await buildYieldAdaptSdk({
      mode: 'redeem',
      amount: 3_000_000n,
      unshieldToken: VAULT,
      shieldOutputToken: USDC,
      adapterAddress: ADAPTER,
      shieldedAddress: '0zk_user',
      broadcasterFee: null,
    })
    // Only the user bundle; the fee slots are zeroed and feeAmount is 0.
    expect(hoisted.buildShieldRequest).toHaveBeenCalledTimes(1)
    const zero = `0x${'00'.repeat(32)}`
    expect(hoisted.encodeYieldRedeemBinding).toHaveBeenCalledWith(BigInt(NPK), BUNDLE, SHIELD_KEY, BigInt(zero), [zero, zero, zero], zero, 0n)
    expect(r.feeShieldRandom).toBeUndefined()
  })
})
