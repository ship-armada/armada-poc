// ABOUTME: Unit tests for the SDK history adapter — covers every category mapping (Shield, TransferSend, TransferReceive, Unshield, Unknown) and the yield-adapter detection heuristic.
// ABOUTME: Hand-rolls TransactionHistoryItem fixtures so no @railgun-community runtime is touched.

import { describe, it, expect } from 'vitest'
import {
  TransactionHistoryItemCategory,
  RailgunWalletBalanceBucket,
  TXIDVersion,
  type TransactionHistoryItem,
} from '@railgun-community/shared-models'
import {
  historyItemToTxRecord,
  historyItemsToTxRecords,
  isSyntheticTxId,
  runHistoryScan,
  syntheticTxId,
  type HistoryMapContext,
} from './history'

const WALLET_ID = 'rg-1'
const HUB_CHAIN_ID = 31337
const ADAPTER = '0xfeedfacefeedfacefeedfacefeedfacefeedface'

const CTX: HistoryMapContext = { hubChainId: HUB_CHAIN_ID, adapterAddress: ADAPTER }
const CTX_NO_ADAPTER: HistoryMapContext = { hubChainId: HUB_CHAIN_ID }

/* Fixture helpers — every test starts from the empty base shape and overrides only what
   matters for that scenario. Keeps the per-category arms self-contained. */

function baseItem(overrides: Partial<TransactionHistoryItem>): TransactionHistoryItem {
  return {
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    txid: 'abc123',
    version: 0,
    timestamp: 1_700_000_000,
    blockNumber: 1234,
    receiveERC20Amounts: [],
    transferERC20Amounts: [],
    changeERC20Amounts: [],
    unshieldERC20Amounts: [],
    receiveNFTAmounts: [],
    transferNFTAmounts: [],
    unshieldNFTAmounts: [],
    category: TransactionHistoryItemCategory.Unknown,
    ...overrides,
  }
}

describe('syntheticTxId / isSyntheticTxId', () => {
  it('encodes txid + category', () => {
    // WHY: the id is the idempotency key for OCC. Two scans seeing the same txid+category
    // produce the same id, so re-runs are no-ops at the storage layer.
    expect(syntheticTxId('abc', 'ShieldERC20s')).toBe('synth:abc:ShieldERC20s')
  })
  it('distinguishes synthetic from authored ids', () => {
    // WHY: future code (incoming-transfer detector, UI affordances) needs a cheap classifier
    // to tell "I authored this" (ulid) from "recovered from chain" (synth:*).
    expect(isSyntheticTxId(syntheticTxId('abc', 'ShieldERC20s'))).toBe(true)
    expect(isSyntheticTxId('01J5XYZULID0001')).toBe(false)
  })
})

describe('historyItemToTxRecord — shield', () => {
  it('reconstructs the user input amount by adding shieldFee back to the receive amount', () => {
    // WHY: the on-chain commitment credits (amount - shieldFee); the user remembers entering
    // the full pre-fee amount. The history row must match the user's memory, not the wire-level
    // post-fee credit.
    const item = baseItem({
      category: TransactionHistoryItemCategory.ShieldERC20s,
      receiveERC20Amounts: [{
        tokenAddress: '0xusdc',
        amount: 99_500_000n, // received after 0.5 USDC shield fee
        senderAddress: null,
        memoText: null,
        shieldFee: '500000', // 0.5 USDC
        hasValidPOIForActiveLists: true,
        balanceBucket: RailgunWalletBalanceBucket.Spendable,
      }],
    })
    const r = historyItemToTxRecord(item, WALLET_ID, CTX)
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('shield')
    expect(r!.meta.amount).toBe(100_000_000n)
    expect(r!.executionState).toBe('completed')
    expect(r!.stage).toBe('hub-confirmed')
    expect(r!.stagesCompleted.length).toBe(3)
  })

  it('falls back to raw receive amount when shieldFee is missing', () => {
    const item = baseItem({
      category: TransactionHistoryItemCategory.ShieldERC20s,
      receiveERC20Amounts: [{
        tokenAddress: '0xusdc',
        amount: 50_000_000n,
        senderAddress: null,
        memoText: null,
        shieldFee: undefined,
        hasValidPOIForActiveLists: true,
        balanceBucket: RailgunWalletBalanceBucket.Spendable,
      }],
    })
    const r = historyItemToTxRecord(item, WALLET_ID, CTX)
    expect(r!.meta.amount).toBe(50_000_000n)
  })

  it('returns null when receiveERC20Amounts is empty (corrupted item)', () => {
    const item = baseItem({ category: TransactionHistoryItemCategory.ShieldERC20s })
    expect(historyItemToTxRecord(item, WALLET_ID, CTX)).toBeNull()
  })
})

describe('historyItemToTxRecord — transfer-receive', () => {
  it('maps to transfer-shielded-received when the sender is not the adapter', () => {
    // WHY: this is the "someone privately paid me" path — the incoming-transfer detector
    // surfaces these rows so received funds are visible without requiring an outgoing record.
    const item = baseItem({
      category: TransactionHistoryItemCategory.TransferReceiveERC20s,
      receiveERC20Amounts: [{
        tokenAddress: '0xusdc',
        amount: 5_000_000n,
        senderAddress: '0xothersender',
        memoText: 'lunch',
        shieldFee: undefined,
        hasValidPOIForActiveLists: true,
        balanceBucket: RailgunWalletBalanceBucket.Spendable,
      }],
    })
    const r = historyItemToTxRecord(item, WALLET_ID, CTX)
    expect(r!.kind).toBe('transfer-shielded-received')
    expect(r!.meta.amount).toBe(5_000_000n)
    expect((r!.meta as { memoText?: string }).memoText).toBe('lunch')
  })

  it('relabels to yield-withdraw when sender matches adapter (case-insensitive)', () => {
    // WHY: ArmadaYieldAdapter.redeemAndShield re-shields the redeemed USDC back to the user
    // with the adapter as the on-chain sender. Without this relabel the row would render as
    // "Received from someone" which mis-describes the user's own redemption.
    const item = baseItem({
      category: TransactionHistoryItemCategory.TransferReceiveERC20s,
      receiveERC20Amounts: [{
        tokenAddress: '0xusdc',
        amount: 1_000_000n,
        senderAddress: ADAPTER.toUpperCase(),
        memoText: null,
        shieldFee: undefined,
        hasValidPOIForActiveLists: true,
        balanceBucket: RailgunWalletBalanceBucket.Spendable,
      }],
    })
    const r = historyItemToTxRecord(item, WALLET_ID, CTX)
    expect(r!.kind).toBe('yield-withdraw')
    expect((r!.meta as { shares: bigint }).shares).toBe(0n)
  })

  it('falls back to transfer-shielded-received when no adapter address is configured', () => {
    // WHY: deployments without a yield manifest set `adapterAddress: undefined`. The mapper
    // must not crash on the missing address — it just skips the heuristic and labels as a
    // plain incoming transfer.
    const item = baseItem({
      category: TransactionHistoryItemCategory.TransferReceiveERC20s,
      receiveERC20Amounts: [{
        tokenAddress: '0xusdc',
        amount: 2_000_000n,
        senderAddress: ADAPTER,
        memoText: null,
        shieldFee: undefined,
        hasValidPOIForActiveLists: true,
        balanceBucket: RailgunWalletBalanceBucket.Spendable,
      }],
    })
    const r = historyItemToTxRecord(item, WALLET_ID, CTX_NO_ADAPTER)
    expect(r!.kind).toBe('transfer-shielded-received')
  })
})

describe('historyItemToTxRecord — transfer-send', () => {
  it('maps to transfer-shielded with "unknown" recipient', () => {
    // WHY: the recipient's 0zk address isn't recoverable from the on-chain commitment
    // (only the NPK is on-chain). We render the row with a sentinel rather than fabricate
    // a recipient string.
    const item = baseItem({
      category: TransactionHistoryItemCategory.TransferSendERC20s,
      transferERC20Amounts: [{
        tokenAddress: '0xusdc',
        amount: 3_000_000n,
        recipientAddress: '0xreceiver',
        walletSource: null,
        memoText: null,
        hasValidPOIForActiveLists: true,
      }],
      broadcasterFeeERC20Amount: {
        tokenAddress: '0xusdc',
        amount: 100_000n,
        hasValidPOIForActiveLists: true,
      },
    })
    const r = historyItemToTxRecord(item, WALLET_ID, CTX)
    expect(r!.kind).toBe('transfer-shielded')
    expect((r!.meta as { recipient: string }).recipient).toBe('unknown')
    expect((r!.meta as { broadcasterFeeAmount: bigint }).broadcasterFeeAmount).toBe(100_000n)
  })

  it('relabels to yield-deposit when recipient matches adapter', () => {
    // WHY: ArmadaYieldAdapter.lendAndShield consumes the unshield leg by being the recipient.
    // Detecting this lets the activity row render as a vault deposit rather than a mystery
    // outgoing transfer.
    const item = baseItem({
      category: TransactionHistoryItemCategory.TransferSendERC20s,
      transferERC20Amounts: [{
        tokenAddress: '0xusdc',
        amount: 7_000_000n,
        recipientAddress: ADAPTER,
        walletSource: null,
        memoText: null,
        hasValidPOIForActiveLists: true,
      }],
    })
    const r = historyItemToTxRecord(item, WALLET_ID, CTX)
    expect(r!.kind).toBe('yield-deposit')
    expect(r!.meta.amount).toBe(7_000_000n)
  })
})

describe('historyItemToTxRecord — unshield', () => {
  it('preserves the on-chain recipient address (visible in clear post-unshield)', () => {
    // WHY: unlike private transfers, unshields emit the EVM recipient on chain. This is one
    // of the few places synthetic records carry the real value rather than a sentinel.
    const item = baseItem({
      category: TransactionHistoryItemCategory.UnshieldERC20s,
      unshieldERC20Amounts: [{
        tokenAddress: '0xusdc',
        amount: 10_000_000n,
        recipientAddress: '0xpayee',
        walletSource: null,
        memoText: null,
        unshieldFee: '50000',
        hasValidPOIForActiveLists: true,
      }],
      broadcasterFeeERC20Amount: {
        tokenAddress: '0xusdc',
        amount: 200_000n,
        hasValidPOIForActiveLists: true,
      },
    })
    const r = historyItemToTxRecord(item, WALLET_ID, CTX)
    expect(r!.kind).toBe('unshield-local')
    expect((r!.meta as { recipient: string }).recipient).toBe('0xpayee')
    expect((r!.meta as { broadcasterFeeAmount: bigint }).broadcasterFeeAmount).toBe(200_000n)
  })
})

describe('historyItemToTxRecord — Unknown / corrupt', () => {
  it('returns null for Unknown category', () => {
    // WHY: SDK uses Unknown for items it can't categorize (custom hooks, future TX types).
    // Synthesizing a row with a made-up kind would mislead the user — better to drop silently.
    const item = baseItem({ category: TransactionHistoryItemCategory.Unknown })
    expect(historyItemToTxRecord(item, WALLET_ID, CTX)).toBeNull()
  })
})

describe('historyItemsToTxRecords', () => {
  it('drops unmapped items and sorts the rest by updatedAt desc', () => {
    // WHY: the IDB store and the UI both sort by updatedAt desc; the mapper output must match
    // so consumers don't need to re-sort.
    const older = baseItem({
      txid: 'older',
      timestamp: 1_700_000_000,
      category: TransactionHistoryItemCategory.UnshieldERC20s,
      unshieldERC20Amounts: [{
        tokenAddress: '0xusdc', amount: 1_000_000n, recipientAddress: '0xa',
        walletSource: null, memoText: null, unshieldFee: undefined,
        hasValidPOIForActiveLists: true,
      }],
    })
    const newer = baseItem({
      txid: 'newer',
      timestamp: 1_700_000_500,
      category: TransactionHistoryItemCategory.ShieldERC20s,
      receiveERC20Amounts: [{
        tokenAddress: '0xusdc', amount: 5_000_000n,
        senderAddress: null, memoText: null, shieldFee: undefined,
        hasValidPOIForActiveLists: true,
        balanceBucket: RailgunWalletBalanceBucket.Spendable,
      }],
    })
    const skipped = baseItem({ txid: 'skip', category: TransactionHistoryItemCategory.Unknown })
    const records = historyItemsToTxRecords([older, skipped, newer], WALLET_ID, CTX)
    expect(records.length).toBe(2)
    expect(records[0]!.id).toBe(syntheticTxId('newer', 'ShieldERC20s'))
    expect(records[1]!.id).toBe(syntheticTxId('older', 'UnshieldERC20s'))
  })
})

describe('runHistoryScan — timestamp backfill', () => {
  const hoistedScan = vi.hoisted(() => ({
    getWalletTransactionHistory: vi.fn(),
    getHubChainDescriptor: vi.fn(() => ({ type: 0 as const, id: 31337 })),
    getHubBlockTimestamps: vi.fn(async () => new Map<number, number>()),
  }))

  vi.mock('@railgun-community/wallet', () => ({
    getWalletTransactionHistory: hoistedScan.getWalletTransactionHistory,
  }))
  vi.mock('./network', () => ({
    getHubChainDescriptor: hoistedScan.getHubChainDescriptor,
    getHubBlockTimestamps: hoistedScan.getHubBlockTimestamps,
  }))

  beforeEach(() => {
    hoistedScan.getWalletTransactionHistory.mockReset()
    hoistedScan.getHubBlockTimestamps.mockReset()
    hoistedScan.getHubBlockTimestamps.mockResolvedValue(new Map())
  })

  function withoutTimestamp(txid: string, blockNumber: number, amount: bigint): TransactionHistoryItem {
    return {
      ...baseItem({
        txid,
        blockNumber,
        timestamp: undefined,
        category: TransactionHistoryItemCategory.ShieldERC20s,
        receiveERC20Amounts: [{
          tokenAddress: '0xusdc',
          amount,
          senderAddress: null,
          memoText: null,
          shieldFee: undefined,
          hasValidPOIForActiveLists: true,
          balanceBucket: RailgunWalletBalanceBucket.Spendable,
        }],
      }),
      timestamp: undefined,
    }
  }

  it('fetches block timestamps for items missing one and patches them into the record (the "Dec 31, 1969" bug fix)', async () => {
    // WHY: the SDK on local Anvil returns items with `timestamp: undefined`. Without backfill,
    // `tsMs()` returns 0 and the row renders the Unix epoch (1969). The fix is to do a bulk
    // RPC lookup so the recovered row shows the actual chain time.
    hoistedScan.getWalletTransactionHistory.mockResolvedValue([
      withoutTimestamp('aaa', 12_000, 1n),
      withoutTimestamp('bbb', 12_005, 2n),
    ])
    hoistedScan.getHubBlockTimestamps.mockResolvedValue(new Map([
      [12_000, 1_700_000_000],
      [12_005, 1_700_000_300],
    ]))
    const result = await runHistoryScan(WALLET_ID, CTX, undefined)
    expect(result.records.length).toBe(2)
    expect(result.records[0]!.updatedAt).toBe(1_700_000_300_000)
    expect(result.records[1]!.updatedAt).toBe(1_700_000_000_000)
  })

  it('dedupes block-number lookups (one RPC call per distinct block)', async () => {
    // WHY: first-scan recovery on a busy wallet might surface many items in the same block.
    // Without dedup we'd issue N redundant eth_getBlockByNumber calls. Verify the helper sees
    // each block exactly once.
    hoistedScan.getWalletTransactionHistory.mockResolvedValue([
      withoutTimestamp('a', 12_000, 1n),
      withoutTimestamp('b', 12_000, 2n),
      withoutTimestamp('c', 12_005, 3n),
    ])
    await runHistoryScan(WALLET_ID, CTX, undefined)
    expect(hoistedScan.getHubBlockTimestamps).toHaveBeenCalledTimes(1)
    const args = hoistedScan.getHubBlockTimestamps.mock.calls[0]![0] as number[]
    expect(args).toEqual([12_000, 12_000, 12_005])
  })

  it('skips the RPC lookup entirely when every item already has a timestamp', async () => {
    // WHY: when the SDK does populate timestamps (Sepolia, mainnet, future Anvil versions),
    // we shouldn't pay for an RPC round-trip we don't need. Verify the lookup is conditional.
    hoistedScan.getWalletTransactionHistory.mockResolvedValue([
      baseItem({
        txid: 'a',
        timestamp: 1_700_000_000,
        blockNumber: 12_000,
        category: TransactionHistoryItemCategory.ShieldERC20s,
        receiveERC20Amounts: [{
          tokenAddress: '0xusdc', amount: 1n, senderAddress: null, memoText: null,
          shieldFee: undefined, hasValidPOIForActiveLists: true,
          balanceBucket: RailgunWalletBalanceBucket.Spendable,
        }],
      }),
    ])
    await runHistoryScan(WALLET_ID, CTX, undefined)
    expect(hoistedScan.getHubBlockTimestamps).not.toHaveBeenCalled()
  })

  it('leaves items unchanged when the RPC lookup returns nothing (graceful degrade)', async () => {
    // WHY: a flaky RPC shouldn't crash the scan. The row still renders, just with the SDK's
    // missing-timestamp default (0 → "Dec 31, 1969"). That's strictly better than failing the
    // whole recovery for the user.
    hoistedScan.getWalletTransactionHistory.mockResolvedValue([
      withoutTimestamp('a', 12_000, 1n),
    ])
    hoistedScan.getHubBlockTimestamps.mockResolvedValue(new Map())
    const result = await runHistoryScan(WALLET_ID, CTX, undefined)
    expect(result.records.length).toBe(1)
    expect(result.records[0]!.updatedAt).toBe(0)
  })
})

describe('walletContext on synthesized records', () => {
  it('leaves evmAddress undefined (we don\'t know which EVM was held at the time)', () => {
    // WHY: TxWalletContext allows undefined for shielded-only ops. We don't fabricate an
    // EVM binding for historical records because the user may have switched EVMs since.
    const item = baseItem({
      category: TransactionHistoryItemCategory.ShieldERC20s,
      receiveERC20Amounts: [{
        tokenAddress: '0xusdc', amount: 1n, senderAddress: null, memoText: null,
        shieldFee: undefined, hasValidPOIForActiveLists: true,
        balanceBucket: RailgunWalletBalanceBucket.Spendable,
      }],
    })
    const r = historyItemToTxRecord(item, WALLET_ID, CTX)
    expect(r!.walletContext.evmAddress).toBeUndefined()
    expect(r!.walletContext.railgunWalletId).toBe(WALLET_ID)
    expect(r!.walletContext.sourceChainId).toBe(HUB_CHAIN_ID)
  })
})
