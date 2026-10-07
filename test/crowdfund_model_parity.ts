// ABOUTME: Differential test: the crowdfund allocation model (tools/crowdfund-model) vs the real ArmadaCrowdfund.
// ABOUTME: Builds each scenario on-chain (seeds, invites, commits), finalizes, and asserts every output matches exactly.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { loadModel } from "../tools/crowdfund-model/test/loadModel";

const { engine } = loadModel();

const U = (dollars: number) => BigInt(dollars) * 1_000_000n; // whole USDC → 6-dec units

interface Participant {
  commits: [bigint, bigint, bigint];
  invitesReceived: [number, number, number];
}

const participant = (commits: [number, number, number], invites: [number, number, number] = [1, 1, 1]): Participant => ({
  commits: commits.map(U) as [bigint, bigint, bigint],
  invitesReceived: invites,
});
const selfFilled = () => participant([15_000, 12_000, 6_000], [1, 3, 6]);
const repeat = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

// Deterministic PRNG (mulberry32) so a failing random scenario can be replayed from its seed.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random commit in [MIN_COMMIT, 1.3 × cap] with arbitrary 6-decimal precision (exercises floors). */
function randomCommit(rand: () => number, cap: bigint): bigint {
  const lo = engine.CONSTANTS.MIN_COMMIT as bigint;
  const hi = (cap * 13n) / 10n;
  return lo + BigInt(Math.floor(rand() * Number(hi - lo)));
}

/** A random scenario mixing seeds, full self-fillers, stacked hop-1/hop-2 invitees and multi-hop nodes. */
function randomScenario(seed: number): Participant[] {
  const rand = prng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const cap = (hop: number, invites: number) => engine.effectiveCap(hop, invites) as bigint;
  const out: Participant[] = [];
  const count = int(60, 150);
  for (let i = 0; i < count; i++) {
    const kind = rand();
    if (kind < 0.25) {
      out.push({ commits: [randomCommit(rand, cap(0, 1)), 0n, 0n], invitesReceived: [1, 1, 1] });
    } else if (kind < 0.45) {
      out.push(selfFilled());
    } else if (kind < 0.65) {
      const r1 = int(1, 10);
      out.push({ commits: [0n, randomCommit(rand, cap(1, r1)), 0n], invitesReceived: [1, r1, 1] });
    } else if (kind < 0.85) {
      const r2 = int(1, 20);
      out.push({ commits: [0n, 0n, randomCommit(rand, cap(2, r2))], invitesReceived: [1, 1, r2] });
    } else {
      const r1 = int(1, 4);
      const r2 = int(1, 8);
      out.push({ commits: [randomCommit(rand, cap(0, 1)), randomCommit(rand, cap(1, r1)), randomCommit(rand, cap(2, r2))], invitesReceived: [1, r1, r2] });
    }
  }
  return out;
}

describe("Crowdfund model parity (tools/crowdfund-model vs ArmadaCrowdfund)", function () {
  this.timeout(600_000);

  async function deployFixture() {
    const [deployer, treasury] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory("MockUSDCV2")).deploy("Mock USDC", "USDC");
    const armToken = await (await ethers.getContractFactory("ArmadaToken")).deploy(deployer.address, deployer.address);
    await armToken.initWhitelist([deployer.address]);

    const openTimestamp = (await time.latest()) + 300;
    const crowdfund = await (await ethers.getContractFactory("ArmadaCrowdfund")).deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasury.address,
      deployer.address, // launchTeam
      deployer.address, // securityCouncil
      openTimestamp,
    );
    const cfAddr = await crowdfund.getAddress();
    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);
    await armToken.transfer(cfAddr, ethers.parseUnits("1800000", 18));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());

    return { crowdfund, usdc, treasury };
  }

  // Deterministic, non-precompile addresses; participants and invite-only fillers never collide.
  const participantAddress = (i: number) => ethers.getAddress(ethers.toBeHex(0x1000000 + i, 20));
  const fillerAddress = (i: number) => ethers.getAddress(ethers.toBeHex(0x2000000 + i, 20));

  /**
   * Builds the scenario on-chain so each participant's node at hop h has exactly
   * invitesReceived[h] invites. Invites come from the participant's own nodes first
   * (self-fill), then the launch team, then any other node with budget left, and finally
   * invite-only filler nodes (which never commit, so only affect the rounding buffer).
   */
  async function realize(crowdfund: any, usdc: any, participants: Participant[]): Promise<string[]> {
    const signers = new Map<string, any>();
    async function signer(addr: string) {
      if (!signers.has(addr)) {
        await setBalance(addr, 10n ** 20n);
        signers.set(addr, await ethers.getImpersonatedSigner(addr));
      }
      return signers.get(addr);
    }

    const addrs = participants.map((_, i) => participantAddress(i));
    // Remaining outgoing invites per inviting node, keyed by address, for hop-0 and hop-1 nodes.
    const budget: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
    const launchTeamBudget = [Number(await crowdfund.LAUNCH_TEAM_HOP1_BUDGET()), Number(await crowdfund.LAUNCH_TEAM_HOP2_BUDGET())];
    let fillers = 0;

    const seeds = addrs.filter((_, i) => participants[i].commits[0] > 0n);
    if (seeds.length > 0) await crowdfund.addSeeds(seeds);
    seeds.forEach((a) => budget[0].set(a, 3));

    async function fillerNode(fromHop: 0 | 1): Promise<string> {
      const addr = fillerAddress(fillers++);
      if (fromHop === 0) {
        await crowdfund.addSeed(addr);
      } else {
        await inviteOnce(addr, 1, null);
      }
      budget[fromHop].set(addr, fromHop === 0 ? 3 : 2);
      return addr;
    }

    // Issues one invite to `invitee` at `hop`, preferring the invitee's own node one hop up.
    async function inviteOnce(invitee: string, hop: 1 | 2, self: string | null) {
      const fromHop = (hop - 1) as 0 | 1;
      const pool = budget[fromHop];
      if (self && (pool.get(self) ?? 0) > 0) {
        await crowdfund.connect(await signer(self)).invite(invitee, fromHop);
        pool.set(self, pool.get(self)! - 1);
      } else if (launchTeamBudget[fromHop] > 0) {
        await crowdfund.launchTeamInvite(invitee, fromHop);
        launchTeamBudget[fromHop]--;
      } else {
        let inviter = [...pool.entries()].find(([, left]) => left > 0)?.[0];
        if (!inviter) inviter = await fillerNode(fromHop);
        await crowdfund.connect(await signer(inviter)).invite(invitee, fromHop);
        pool.set(inviter, pool.get(inviter)! - 1);
      }
    }

    for (const hop of [1, 2] as const) {
      for (let i = 0; i < participants.length; i++) {
        if (participants[i].commits[hop] === 0n) continue;
        for (let k = 0; k < participants[i].invitesReceived[hop]; k++) {
          await inviteOnce(addrs[i], hop, participants[i].commits[hop - 1] > 0n ? addrs[i] : null);
        }
        if (hop === 1) budget[1].set(addrs[i], 2 * participants[i].invitesReceived[1]);
      }
    }

    const cfAddr = await crowdfund.getAddress();
    for (let i = 0; i < participants.length; i++) {
      const total = participants[i].commits.reduce((a, b) => a + b, 0n);
      if (total === 0n) continue;
      const s = await signer(addrs[i]);
      await usdc.mint(addrs[i], total);
      await usdc.connect(s).approve(cfAddr, total);
      for (let hop = 0; hop < 3; hop++) {
        if (participants[i].commits[hop] > 0n) await crowdfund.connect(s).commit(hop, participants[i].commits[hop]);
      }
    }
    return addrs;
  }

  async function assertParity(participants: Participant[]) {
    const { crowdfund, usdc, treasury } = await loadFixture(deployFixture);
    const addrs = await realize(crowdfund, usdc, participants);
    await time.increaseTo((await crowdfund.windowEnd()) + 1n);
    await crowdfund.finalize();

    const model = engine.finalize(participants);

    expect(await crowdfund.refundMode(), "refundMode").to.equal(model.refundMode);
    expect(await crowdfund.saleSize(), "saleSize").to.equal(model.saleSize);
    expect(await crowdfund.cappedDemand(), "cappedDemand").to.equal(model.cappedDemand);
    expect(await crowdfund.totalCommitted(), "totalCommitted").to.equal(model.totalCommitted);
    expect(await crowdfund.totalAllocatedUsdc(), "totalAllocatedUsdc").to.equal(model.totalAllocUsdc);
    expect(await crowdfund.totalAllocatedArm(), "totalAllocatedArm").to.equal(model.totalAllocatedArm);

    for (let hop = 0; hop < 3; hop++) {
      const stats = await crowdfund.getHopStats(hop);
      expect(stats[0], `hop ${hop} totalCommitted`).to.equal(model.perHopCommitted[hop]);
      expect(stats[1], `hop ${hop} cappedCommitted`).to.equal(model.perHopCapped[hop]);
      expect(Number(stats[2]), `hop ${hop} uniqueCommitters`).to.equal(model.uniqueCommitters[hop]);
      expect(await crowdfund.finalCeilings(hop), `hop ${hop} finalCeiling`).to.equal(model.hopAllocation?.ceilings[hop] ?? 0n);
      expect(await crowdfund.finalDemands(hop), `hop ${hop} finalDemand`).to.equal(model.hopAllocation?.demands[hop] ?? 0n);
    }

    // The model counts committing nodes; on-chain the buffer also counts invite-only fillers.
    const onChainNodes = Number(await crowdfund.getParticipantCount());
    const expectedProceeds = model.refundMode ? 0n : engine.netProceeds(model.totalAllocUsdc, onChainNodes);
    expect(await usdc.balanceOf(treasury.address), "treasury proceeds").to.equal(expectedProceeds);

    for (let i = 0; i < participants.length; i++) {
      const p = model.participants[i];
      const [arm, refund] = await crowdfund.computeAllocation(addrs[i]);
      expect(arm, `participant ${i} ARM`).to.equal(p.allocArm);
      expect(refund, `participant ${i} refund`).to.equal(p.refundUsdc);
      for (let hop = 0; hop < 3; hop++) {
        const h = p.hops[hop];
        if (!h) continue;
        expect(await crowdfund.getEffectiveCap(addrs[i], hop), `participant ${i} hop ${hop} cap`).to.equal(h.effectiveCap);
        const [hopArm, hopRefund] = await crowdfund.computeAllocationAtHop(addrs[i], hop);
        expect(hopArm, `participant ${i} hop ${hop} ARM`).to.equal(h.allocArm);
        expect(hopRefund, `participant ${i} hop ${hop} refund`).to.equal(h.refundUsdc);
      }
    }
    return model;
  }

  // WHY: the model hardcodes mainnet constants; a contract constants change (like PR #572) must
  //      fail here, not silently skew forecasts.
  it("uses the contract's constants", async function () {
    const { crowdfund } = await loadFixture(deployFixture);
    const C = engine.CONSTANTS;
    for (const name of [
      "BASE_SALE", "MAX_SALE", "MIN_SALE", "ELASTIC_TRIGGER", "ARM_PRICE", "HOP2_BASE_FLOOR_BPS",
      "HOP2_EXTRA_FLOOR_BPS", "MIN_COMMIT", "MAX_SEEDS", "LAUNCH_TEAM_HOP1_BUDGET",
      "LAUNCH_TEAM_HOP2_BUDGET", "MAX_FINALIZE_NODES",
    ]) {
      expect(BigInt(C[name]), name).to.equal(await crowdfund[name]());
    }
    for (let hop = 0; hop < 3; hop++) {
      const cfg = await crowdfund.hopConfigs(hop);
      const model = engine.HOP_CONFIGS[hop];
      expect(model.ceilingBps, `hop ${hop} ceilingBps`).to.equal(cfg.ceilingBps);
      expect(model.capUsdc, `hop ${hop} capUsdc`).to.equal(cfg.capUsdc);
      expect(BigInt(model.maxInvites), `hop ${hop} maxInvites`).to.equal(cfg.maxInvites);
      expect(BigInt(model.maxInvitesReceived), `hop ${hop} maxInvitesReceived`).to.equal(cfg.maxInvitesReceived);
    }
  });

  describe("curated scenarios", function () {
    // WHY: first refund exit: finalize() returns before the waterfall.
    it("capped demand below MIN_SALE → refund mode", async function () {
      const m = await assertParity(repeat(66, () => participant([15_000, 0, 0])));
      expect(m.refundReason).to.equal("capped-demand-below-min");
    });

    // WHY: only capped amounts count toward the minimum raise.
    it("over-cap deposits do not count toward MIN_SALE → refund mode", async function () {
      const m = await assertParity(repeat(60, () => participant([20_000, 0, 0])));
      expect(m.refundReason).to.equal("capped-demand-below-min");
    });

    // WHY: second refund exit: demand passes $1M but the hop-0 ceiling allocates less.
    it("hop-0-only demand allocates below MIN_SALE → refund mode", async function () {
      const m = await assertParity(repeat(67, () => participant([15_000, 0, 0])));
      expect(m.refundReason).to.equal("allocation-below-min");
    });

    // WHY: the expected common case; every capped dollar allocates.
    it("under-subscribed self-fillers at BASE_SALE", async function () {
      const m = await assertParity(repeat(34, selfFilled));
      expect(m.saleSize).to.equal(engine.CONSTANTS.BASE_SALE);
      expect(m.refundMode).to.equal(false);
    });

    // WHY: expansion changes every ceiling.
    it("elastic expansion to MAX_SALE", async function () {
      const m = await assertParity(repeat(46, selfFilled));
      expect(m.saleSize).to.equal(engine.CONSTANTS.MAX_SALE);
    });

    // WHY: the contract expands on `capped >= ELASTIC_TRIGGER`; only an exact-boundary
    //      scenario distinguishes >= from >.
    it("capped demand exactly at ELASTIC_TRIGGER expands to MAX_SALE", async function () {
      const m = await assertParity([...repeat(45, selfFilled), participant([15_000, 0, 0])]);
      expect(m.cappedDemand).to.equal(engine.CONSTANTS.ELASTIC_TRIGGER);
      expect(m.saleSize).to.equal(engine.CONSTANTS.MAX_SALE);
    });

    // WHY: the contract refunds on `capped < MIN_SALE` and `allocated < MIN_SALE`; exactly
    //      $1M of fully-allocated demand must succeed at both checks.
    it("capped demand and allocation exactly at MIN_SALE succeeds", async function () {
      const m = await assertParity([...repeat(30, selfFilled), participant([0, 10_000, 0], [1, 3, 1])]);
      expect(m.cappedDemand).to.equal(engine.CONSTANTS.MIN_SALE);
      expect(m.totalAllocUsdc).to.equal(engine.CONSTANTS.MIN_SALE);
      expect(m.refundMode).to.equal(false);
    });

    // WHY: pro-rata floor division at every hop, including the remainingAvailable clamp on hop-1.
    it("every hop oversubscribed (pro-rata at all three hops)", async function () {
      const m = await assertParity(repeat(40, selfFilled));
      expect(m.hopAllocation.demands[0] > m.hopAllocation.ceilings[0]).to.equal(true);
      expect(m.hopAllocation.demands[2] > m.hopAllocation.ceilings[2]).to.equal(true);
    });

    // WHY: invites from others stack on self-invites up to the per-hop limit; caps and over-cap
    //      refunds must match.
    it("stacked invites from others on top of self-fill, with over-cap commits", async function () {
      await assertParity([
        ...repeat(38, selfFilled),
        participant([15_000, 45_000, 25_000], [1, 10, 20]),
        participant([0, 41_000, 0], [1, 10, 1]),
        participant([0, 0, 19_999], [1, 1, 20]),
        participant([12_345, 9_999, 0], [1, 2, 1]),
      ]);
    });

    // ~$1.8M capped: hop-0 (~$873k vs $846k) and hop-1 (~$721k vs $684k) both pro-rate.
    it("oversubscribed MAX_SALE with uneven amounts (floor-division dust)", async function () {
      const uneven = (i: number): Participant => ({
        commits: [U(14_500) + BigInt(i) * 777_777n, U(12_000) + BigInt(i) * 333_331n, U(3_500) + BigInt(i) * 123_457n],
        invitesReceived: [1, 4, 4],
      });
      const m = await assertParity(Array.from({ length: 60 }, (_, i) => uneven(i)));
      expect(m.saleSize).to.equal(engine.CONSTANTS.MAX_SALE);
      expect(m.hopAllocation.demands[1] > m.hopAllocation.ceilings[1]).to.equal(true);
    });
  });

  describe("random scenarios", function () {
    // WHY: 60–150 mixed participants per seed land in every regime (refund, under- and
    //      oversubscribed hops at both sale sizes) with arbitrary 6-decimal amounts, catching
    //      divergences no hand-picked vector anticipates. Seeds are fixed so failures replay.
    for (let seed = 1; seed <= 16; seed++) {
      it(`seed ${seed}`, async function () {
        await assertParity(randomScenario(seed));
      });
    }
  });
});
