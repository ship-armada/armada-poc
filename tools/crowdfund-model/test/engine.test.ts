// ABOUTME: Unit tests for the crowdfund model's allocation engine (the BigInt port of ArmadaCrowdfund.finalize).
// ABOUTME: Hand-derived golden vectors per waterfall branch; contract parity is asserted in test/crowdfund_model_parity.ts.

import { expect } from "chai";
import { loadModel } from "./loadModel";

const { engine } = loadModel();

const U = (dollars: number) => BigInt(dollars) * 1_000_000n; // whole USDC → 6-dec units
const ARM = (usdcUnits: bigint) => usdcUnits * 10n ** 12n; // ARM_PRICE = $1 → 1 USDC unit = 1e12 ARM wei

const BASE = U(1_200_000);
const MAX = U(1_800_000);

/** A participant with the same commit at each listed hop, one invite each. */
function participant(commits: [number, number, number], invites: [number, number, number] = [1, 1, 1]) {
  return { commits: commits.map(U), invitesReceived: invites };
}

/** The 33k self-fill: seed $15k, 3 self-invites → hop-1 $12k, 6 self-invites → hop-2 $6k. */
const selfFilled = () => participant([15_000, 12_000, 6_000], [1, 3, 6]);

const repeat = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

describe("crowdfund model engine — computeHopAllocations", function () {
  // WHY: with zero demand every hop's full ceiling rolls forward, exposing each raw ceiling
  //      (47% / remainingAvailable-capped hop-1 / 15% floor + rollover) in one vector.
  it("derives the BASE_SALE ceilings with full rollover at zero demand", function () {
    const r = engine.computeHopAllocations(BASE, [0n, 0n, 0n]);
    expect(r.ceilings).to.deep.equal([U(564_000), U(1_020_000), U(1_200_000)]);
    expect(r.allocs).to.deep.equal([0n, 0n, 0n]);
    expect(r.leftovers).to.deep.equal([U(564_000), U(1_020_000)]);
    expect(r.totalAllocUsdc).to.equal(0n);
  });

  // WHY: every ceiling scales with saleSize; pins the expanded-sale numbers the team will compare
  //      against.
  it("derives the MAX_SALE ceilings with full rollover at zero demand", function () {
    const r = engine.computeHopAllocations(MAX, [0n, 0n, 0n]);
    expect(r.ceilings).to.deep.equal([U(846_000), U(1_530_000), U(1_800_000)]);
  });

  // WHY: hop-1's effective ceiling is clamped to remainingAvailable after hop-0 takes its share,
  //      which is what keeps total allocation <= saleSize when every hop is oversubscribed.
  it("clamps hop-1 to remainingAvailable when every hop is oversubscribed", function () {
    const r = engine.computeHopAllocations(BASE, [U(700_000), U(700_000), U(300_000)]);
    expect(r.ceilings).to.deep.equal([U(564_000), U(456_000), U(180_000)]);
    expect(r.allocs).to.deep.equal([U(564_000), U(456_000), U(180_000)]);
    expect(r.leftovers).to.deep.equal([0n, 0n]);
    expect(r.totalAllocUsdc).to.equal(BASE);
  });

  // WHY: rollover is unconditional; an under-filled hop-0/hop-1 must enlarge hop-2 beyond its 15%
  //      floor.
  it("rolls unused hop-0 and hop-1 ceiling into hop-2", function () {
    const r = engine.computeHopAllocations(BASE, [U(400_000), U(200_000), U(500_000)]);
    expect(r.ceilings).to.deep.equal([U(564_000), U(620_000), U(600_000)]);
    expect(r.allocs).to.deep.equal([U(400_000), U(200_000), U(500_000)]);
    expect(r.leftovers).to.deep.equal([U(164_000), U(420_000)]);
    expect(r.demands).to.deep.equal([U(400_000), U(200_000), U(500_000)]);
  });
});

describe("crowdfund model engine — computeNodeAllocation", function () {
  // WHY: over-cap deposits are accepted on-chain but only the capped amount can ever be allocated.
  it("allocates the full capped amount when the hop is under-subscribed and refunds over-cap excess", function () {
    const r = engine.computeNodeAllocation(U(20_000), U(15_000), U(564_000), U(100_000));
    expect(r.allocUsdc).to.equal(U(15_000));
    expect(r.allocArm).to.equal(ARM(U(15_000)));
    expect(r.refundUsdc).to.equal(U(5_000));
  });

  // WHY: Solidity integer division rounds down; 15000 * 564000 / 601000 = 14076.5391014975...
  it("pro-rates an oversubscribed hop with floor division", function () {
    const r = engine.computeNodeAllocation(U(15_000), U(15_000), U(564_000), U(601_000));
    expect(r.allocUsdc).to.equal(14_076_539_101n);
    expect(r.refundUsdc).to.equal(U(15_000) - 14_076_539_101n);
  });

  // WHY: mirrors the contract's early return; a hop a participant never committed to yields
  //      nothing.
  it("returns zeros for a zero commitment", function () {
    const r = engine.computeNodeAllocation(0n, U(15_000), U(564_000), U(601_000));
    expect([r.allocUsdc, r.allocArm, r.refundUsdc]).to.deep.equal([0n, 0n, 0n]);
  });
});

describe("crowdfund model engine — finalize", function () {
  // WHY: the tool opens empty, so the zero-demand outcome must be the contract's refund path, not
  //      a crash.
  it("enters refund mode with no participants", function () {
    const r = engine.finalize([]);
    expect(r.refundMode).to.equal(true);
    expect(r.refundReason).to.equal("capped-demand-below-min");
    expect(r.saleSize).to.equal(0n);
    expect(r.hopAllocation).to.equal(null);
  });

  // WHY: the first refund-mode exit returns before any waterfall runs; every participant gets
  //      their full commit back.
  it("enters refund mode when capped demand is below MIN_SALE and refunds everything", function () {
    const r = engine.finalize(repeat(66, () => participant([15_000, 0, 0]))); // $990k
    expect(r.cappedDemand).to.equal(U(990_000));
    expect(r.refundMode).to.equal(true);
    expect(r.refundReason).to.equal("capped-demand-below-min");
    expect(r.participants[0].allocArm).to.equal(0n);
    expect(r.participants[0].refundUsdc).to.equal(U(15_000));
    expect(r.totalAllocUsdc).to.equal(0n);
  });

  // WHY: only capped amounts count toward the minimum raise — $1.2M raw is still $900k capped.
  it("ignores over-cap deposits when checking the minimum raise", function () {
    const r = engine.finalize(repeat(60, () => participant([20_000, 0, 0])));
    expect(r.totalCommitted).to.equal(U(1_200_000));
    expect(r.cappedDemand).to.equal(U(900_000));
    expect(r.refundReason).to.equal("capped-demand-below-min");
  });

  // WHY: hop-0 alone can never reach MIN_SALE, so $1.005M of hop-0-only demand passes the
  //      capped-demand check but fails the post-allocation check at BASE_SALE.
  it("enters refund mode when allocated USDC falls below MIN_SALE", function () {
    const r = engine.finalize(repeat(67, () => participant([15_000, 0, 0])));
    expect(r.cappedDemand).to.equal(U(1_005_000));
    expect(r.refundMode).to.equal(true);
    expect(r.refundReason).to.equal("allocation-below-min");
    expect(r.saleSize).to.equal(BASE);
    expect(r.hopAllocation.totalAllocUsdc).to.equal(U(564_000));
    expect(r.totalAllocUsdc).to.equal(0n);
    expect(r.participants[0].refundUsdc).to.equal(U(15_000));
  });

  // WHY: the $33k self-fill is the expected common case; under-subscribed hops must allocate every
  //      capped dollar.
  it("fully allocates under-subscribed self-filled participants at BASE_SALE", function () {
    const r = engine.finalize(repeat(34, selfFilled)); // $1.122M
    expect(r.refundMode).to.equal(false);
    expect(r.refundReason).to.equal(null);
    expect(r.saleSize).to.equal(BASE);
    expect(r.hopAllocation.ceilings).to.deep.equal([U(564_000), U(510_000), U(282_000)]);
    expect(r.totalAllocUsdc).to.equal(U(1_122_000));
    expect(r.totalAllocatedArm).to.equal(ARM(U(1_122_000)));
    expect(r.nodeCount).to.equal(102);
    expect(r.netProceeds).to.equal(U(1_122_000) - 102n);
    expect(r.participants[0].allocArm).to.equal(ARM(U(33_000)));
    expect(r.participants[0].refundUsdc).to.equal(0n);
    expect(r.perHopCommitted).to.deep.equal([U(510_000), U(408_000), U(204_000)]);
    expect(r.uniqueCommitters).to.deep.equal([34, 34, 34]);
  });

  // WHY: expansion changes every ceiling; the MAX_SALE waterfall must use the expanded sale size.
  it("expands to MAX_SALE when capped demand reaches the elastic trigger", function () {
    const r = engine.finalize(repeat(46, selfFilled)); // $1.518M
    expect(r.saleSize).to.equal(MAX);
    expect(r.hopAllocation.ceilings).to.deep.equal([U(846_000), U(840_000), U(558_000)]);
    expect(r.totalAllocUsdc).to.equal(U(1_518_000));
  });

  // WHY: expansion is `capped >= ELASTIC_TRIGGER`, so exactly $1.5M must expand.
  it("expands at exactly the elastic trigger", function () {
    const r = engine.finalize([...repeat(45, selfFilled), participant([15_000, 0, 0])]);
    expect(r.cappedDemand).to.equal(U(1_500_000));
    expect(r.saleSize).to.equal(MAX);
  });

  // WHY: both refund checks are strict `< MIN_SALE`, so exactly $1M allocated must succeed.
  it("succeeds with capped demand and allocation exactly at MIN_SALE", function () {
    const r = engine.finalize([...repeat(30, selfFilled), participant([0, 10_000, 0], [1, 3, 1])]);
    expect(r.cappedDemand).to.equal(U(1_000_000));
    expect(r.totalAllocUsdc).to.equal(U(1_000_000));
    expect(r.refundMode).to.equal(false);
  });

  // WHY: a self-filled participant holds three nodes; each is pro-rated independently and summed,
  //      as claim() does.
  it("pro-rates every hop of a multi-hop participant when all hops are oversubscribed", function () {
    const r = engine.finalize(repeat(40, selfFilled)); // $1.32M
    expect(r.saleSize).to.equal(BASE);
    expect(r.hopAllocation.ceilings).to.deep.equal([U(564_000), U(456_000), U(180_000)]);
    const p = r.participants[0];
    expect(p.hops.map((h: any) => h.allocUsdc)).to.deep.equal([U(14_100), U(11_400), U(4_500)]);
    expect(p.allocArm).to.equal(ARM(U(30_000)));
    expect(p.refundUsdc).to.equal(U(3_000));
    expect(r.totalAllocUsdc).to.equal(BASE);
  });

  // WHY: stacked invites scale the cap (invitesReceived × per-slot cap); excess over it is refunded.
  it("scales caps by stacked invites and refunds the excess", function () {
    const stacked = participant([0, 50_000, 25_000], [1, 10, 20]);
    const r = engine.finalize([...repeat(34, selfFilled), stacked]);
    const hops = r.participants[34].hops;
    expect(hops[0]).to.equal(null);
    expect(hops[1].effectiveCap).to.equal(U(40_000));
    expect(hops[1].cappedCommitted).to.equal(U(40_000));
    expect(hops[2].effectiveCap).to.equal(U(20_000));
    expect(r.perHopCapped).to.deep.equal([U(510_000), U(448_000), U(224_000)]);
    expect(r.participants[34].refundUsdc).to.equal(U(15_000));
    expect(r.participants[34].allocArm).to.equal(ARM(U(60_000)));
  });

  // WHY: the treasury push keeps a rounding buffer and never goes negative.
  it("computes net proceeds as allocated USDC minus one unit per node", function () {
    expect(engine.netProceeds(U(1_000_000), 1800)).to.equal(U(1_000_000) - 1800n);
    expect(engine.netProceeds(100n, 1800)).to.equal(0n);
  });
});
