// ABOUTME: Tests for FeeCalculator.getScheduleByCacheId — resolving a quote to the schedule it was
// issued from (current or one-deep previous within the variance buffer).
// ABOUTME: WHY: with profitMarginBps=0, re-pricing an in-flight quote against a freshly-regenerated
// (higher-gas) schedule spuriously rejects honest proofs as FEE_INSUFFICIENT. The fix verifies
// against the schedule the quote actually came from — these tests pin that resolution + its bound.

import { expect } from "chai";
import { ethers } from "ethers";
import { FeeCalculator } from "../../modules/fee-calculator";

/** Stub provider whose gas price we can move between schedule generations. */
function stubProvider(gasPriceRef: { value: bigint }): ethers.JsonRpcProvider {
  return {
    getFeeData: async () => ({ gasPrice: gasPriceRef.value }),
  } as unknown as ethers.JsonRpcProvider;
}

const ADDR = "0zk1qy00000000000000000000000000000000000000000000000000000000000000";

describe("FeeCalculator.getScheduleByCacheId", function () {
  it("resolves the current schedule's cacheId", async function () {
    const calc = new FeeCalculator(stubProvider({ value: 1_000_000_000n }), 31337, ADDR);
    const s = await calc.generateFeeSchedule();
    expect(calc.getScheduleByCacheId(s.cacheId)).to.equal(s);
  });

  it("still resolves the PREVIOUS schedule's cacheId after a regeneration, with ITS OWN prices", async function () {
    // WHY: this is the security/UX fix. A quote issued against s1 (cheap gas) must keep verifying
    // against s1's fees even after s2 regenerates at a higher gas price — otherwise the honest user
    // who built their proof against the s1 quote is rejected through no fault of their own.
    const gas = { value: 1_000_000_000n };
    const calc = new FeeCalculator(stubProvider(gas), 31337, ADDR);
    const s1 = await calc.generateFeeSchedule();

    gas.value = 5_000_000_000n; // gas price jumps before the next quote
    const s2 = await calc.generateFeeSchedule();

    expect(s2.fees.transfer).to.not.equal(s1.fees.transfer); // prices really did change
    const resolved = calc.getScheduleByCacheId(s1.cacheId);
    expect(resolved).to.equal(s1);
    expect(resolved!.fees.transfer).to.equal(s1.fees.transfer); // verified against s1, not s2
  });

  it("returns null for an unknown cacheId", async function () {
    const calc = new FeeCalculator(stubProvider({ value: 1_000_000_000n }), 31337, ADDR);
    await calc.generateFeeSchedule();
    expect(calc.getScheduleByCacheId("fee-31337-0-999")).to.equal(null);
  });

  it("history is one-deep: a cacheId two regenerations old no longer resolves", async function () {
    // WHY: bounds memory + replay window. After s3, s1 has fallen out of {current, previous} and
    // must be rejected (forcing a re-fetch), while s2 and s3 still resolve.
    const calc = new FeeCalculator(stubProvider({ value: 1_000_000_000n }), 31337, ADDR);
    const s1 = await calc.generateFeeSchedule();
    const s2 = await calc.generateFeeSchedule();
    const s3 = await calc.generateFeeSchedule();

    expect(calc.getScheduleByCacheId(s1.cacheId)).to.equal(null);
    expect(calc.getScheduleByCacheId(s2.cacheId)).to.equal(s2);
    expect(calc.getScheduleByCacheId(s3.cacheId)).to.equal(s3);
  });
});
