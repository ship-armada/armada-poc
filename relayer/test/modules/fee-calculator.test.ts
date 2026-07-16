// ABOUTME: Unit tests for FeeCalculator — pins the one-RPC-read-per-schedule property (quota
// ABOUTME: guard) plus the fee math invariants: tier proportionality, min-fee floor, TTL caching.

import { expect } from "chai";
import type { ethers } from "ethers";
import { FeeCalculator } from "../../modules/fee-calculator";

/** Fake provider that records getFeeData calls and returns a fixed gas price. */
function stubProvider(gasPrice: bigint): { provider: ethers.JsonRpcProvider; calls: () => number } {
  let count = 0;
  const provider = {
    getFeeData: async () => {
      count++;
      return { gasPrice };
    },
  } as unknown as ethers.JsonRpcProvider;
  return { provider, calls: () => count };
}

const CHAIN_ID = 11155111;
const BROADCASTER = "0zk-test-address";

describe("FeeCalculator", () => {
  it("makes exactly one getFeeData call per schedule generation", async () => {
    // WHY: schedule generation prices seven operation tiers. A regression back to per-tier
    // getFeeData calls would 7x the RPC cost of every schedule regeneration on every chain —
    // this is the load-reduction property the fee calculator is built around.
    const { provider, calls } = stubProvider(2_000_000_000n);
    const calc = new FeeCalculator(provider, CHAIN_ID, BROADCASTER);

    await calc.generateFeeSchedule();
    expect(calls()).to.equal(1);

    await calc.generateFeeSchedule();
    expect(calls()).to.equal(2);
  });

  it("serves getCurrentFees from cache within the TTL without touching the provider", async () => {
    // WHY: /fees is polled by frontends; the 5-minute TTL cache is what keeps that polling off
    // the RPC endpoint. A regression that regenerated per request would multiply RPC load by
    // the number of /fees hits.
    const { provider, calls } = stubProvider(2_000_000_000n);
    const calc = new FeeCalculator(provider, CHAIN_ID, BROADCASTER);

    const first = await calc.getCurrentFees();
    const second = await calc.getCurrentFees();
    expect(calls()).to.equal(1);
    expect(second.cacheId).to.equal(first.cacheId);
  });

  it("prices all tiers off the same gas reading, proportional to their gas estimates", async () => {
    // WHY: all seven tiers must be mutually consistent — quoted from one gas-price observation.
    // If tiers came from different readings (or different formulas), a user comparing quotes
    // would see incoherent relative pricing, and operator fee accounting couldn't reconcile.
    // 1000 gwei keeps every tier far above the 0.01 USDC min-fee floor so proportionality is
    // exact for any configured ETH price ≥ 1.
    const { provider } = stubProvider(1_000_000_000_000n);
    const calc = new FeeCalculator(provider, CHAIN_ID, BROADCASTER);

    const { fees } = await calc.generateFeeSchedule();
    const transfer = BigInt(fees.transfer);

    // Gas estimates: transfer/unshield/crossChainShield/crossChainUnshield 500k,
    // crossContract 2M (4x), shield 300k (3/5), shieldXchain 400k (4/5).
    expect(BigInt(fees.unshield)).to.equal(transfer);
    expect(BigInt(fees.crossChainShield)).to.equal(transfer);
    expect(BigInt(fees.crossChainUnshield)).to.equal(transfer);
    expect(BigInt(fees.crossContract)).to.equal(transfer * 4n);
    expect(BigInt(fees.shield)).to.equal((transfer * 3n) / 5n);
    expect(BigInt(fees.shieldXchain)).to.equal((transfer * 4n) / 5n);
  });

  it("enforces the 0.01 USDC minimum fee when gas is effectively free", async () => {
    // WHY: dust-fee floor. With a 1-wei gas price the formula rounds to zero — the floor is what
    // prevents publishing a 0-fee schedule that invites free relaying.
    const { provider } = stubProvider(1n);
    const calc = new FeeCalculator(provider, CHAIN_ID, BROADCASTER);

    const { fees } = await calc.generateFeeSchedule();
    for (const fee of Object.values(fees)) {
      expect(BigInt(fee)).to.equal(10_000n);
    }
  });

  it("falls back to 1 gwei when the provider reports no gas price", async () => {
    // WHY: getFeeData().gasPrice can be null (some RPCs omit it post-EIP-1559). The schedule
    // must still be generated — a throw here would take down /fees for the whole chain.
    let count = 0;
    const provider = {
      getFeeData: async () => {
        count++;
        return { gasPrice: null };
      },
    } as unknown as ethers.JsonRpcProvider;
    const calc = new FeeCalculator(provider, CHAIN_ID, BROADCASTER);

    const schedule = await calc.generateFeeSchedule();
    expect(count).to.equal(1);
    // 500k gas x 1 gwei = 5e14 wei; exact fee depends on configured ETH price, but it must be
    // a positive value at or above the min-fee floor.
    expect(BigInt(schedule.fees.transfer) >= 10_000n).to.equal(true);
  });

  it("embeds the chainId in the cacheId", async () => {
    // WHY: cross-chain quote replay defense — privacy-relay validates cacheId against the
    // schedule for the request's chainId, and humans grep cacheIds when debugging. A cacheId
    // without the chainId would make both silently weaker.
    const { provider } = stubProvider(2_000_000_000n);
    const calc = new FeeCalculator(provider, CHAIN_ID, BROADCASTER);

    const schedule = await calc.generateFeeSchedule();
    expect(schedule.cacheId).to.match(new RegExp(`^fee-${CHAIN_ID}-`));
    expect(schedule.chainId).to.equal(CHAIN_ID);
    expect(schedule.broadcasterRailgunAddress).to.equal(BROADCASTER);
  });
});

// Resolving a quote to the schedule it was issued from (current or one-deep previous within the
// variance buffer). WHY: with profitMarginBps=0, re-pricing an in-flight quote against a
// freshly-regenerated (higher-gas) schedule spuriously rejects honest proofs as FEE_INSUFFICIENT.
describe("FeeCalculator.getScheduleByCacheId", () => {
  it("resolves the current schedule's cacheId", async () => {
    const { provider } = stubProvider(1_000_000_000n);
    const calc = new FeeCalculator(provider, CHAIN_ID, BROADCASTER);
    const s = await calc.generateFeeSchedule();
    expect(calc.getScheduleByCacheId(s.cacheId)).to.equal(s);
  });

  it("still resolves the PREVIOUS schedule's cacheId after a regeneration, with ITS OWN prices", async () => {
    // WHY: the security/UX fix. A quote issued against s1 (cheap gas) must keep verifying against
    // s1's fees even after s2 regenerates at a higher gas price — otherwise the honest user who
    // built their proof against the s1 quote is rejected through no fault of their own.
    const gas = { value: 1_000_000_000n };
    const provider = {
      getFeeData: async () => ({ gasPrice: gas.value }),
    } as unknown as ethers.JsonRpcProvider;
    const calc = new FeeCalculator(provider, CHAIN_ID, BROADCASTER);
    const s1 = await calc.generateFeeSchedule();

    gas.value = 5_000_000_000n; // gas price jumps before the next quote
    const s2 = await calc.generateFeeSchedule();

    expect(s2.fees.transfer).to.not.equal(s1.fees.transfer); // prices really did change
    const resolved = calc.getScheduleByCacheId(s1.cacheId);
    expect(resolved).to.equal(s1);
    expect(resolved!.fees.transfer).to.equal(s1.fees.transfer); // verified against s1, not s2
  });

  it("returns null for an unknown cacheId", async () => {
    const { provider } = stubProvider(1_000_000_000n);
    const calc = new FeeCalculator(provider, CHAIN_ID, BROADCASTER);
    await calc.generateFeeSchedule();
    expect(calc.getScheduleByCacheId(`fee-${CHAIN_ID}-0-999`)).to.equal(null);
  });

  it("history is one-deep: a cacheId two regenerations old no longer resolves", async () => {
    // WHY: bounds memory + replay window. After s3, s1 has fallen out of {current, previous} and
    // must be rejected (forcing a re-fetch), while s2 and s3 still resolve.
    const { provider } = stubProvider(1_000_000_000n);
    const calc = new FeeCalculator(provider, CHAIN_ID, BROADCASTER);
    const s1 = await calc.generateFeeSchedule();
    const s2 = await calc.generateFeeSchedule();
    const s3 = await calc.generateFeeSchedule();

    expect(calc.getScheduleByCacheId(s1.cacheId)).to.equal(null);
    expect(calc.getScheduleByCacheId(s2.cacheId)).to.equal(s2);
    expect(calc.getScheduleByCacheId(s3.cacheId)).to.equal(s3);
  });
});
