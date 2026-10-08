// ABOUTME: Deploy-time initial steward election + USDC steward budget (#221, #222): pre-flight
// ABOUTME: checks, timelock seeding with read-back, verify checks, and the sale-window risk bound.
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployGovernorProxy } from "./helpers/deploy-governor";
import {
  assertInitialStewardPreflight,
  assertUsdcDecimals,
  initialStewardChecks,
  seedInitialSteward,
  stewardBudgetLimit,
} from "../scripts/initial-steward";
import type { InitialStewardConfig } from "../config/networks";

const ONE_DAY = 86400;
const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

/** Schedule + execute through a delay-0 timelock — the hardened bootstrap path timelockCall takes. */
function timelockExecutor(timelock: any) {
  return async (target: string, calldata: string, description: string) => {
    const salt = ethers.id(description);
    await (await timelock.schedule(target, 0, calldata, ethers.ZeroHash, salt, 0)).wait();
    await (await timelock.execute(target, 0, calldata, ethers.ZeroHash, salt)).wait();
  };
}

describe("Initial steward deployment (#221, #222)", function () {
  async function fixture() {
    const [deployer, a, b, c, sc, launchTeam, stewardEoa] = await ethers.getSigners();
    const timelock = await (await ethers.getContractFactory("TimelockController"))
      .deploy(0, [deployer.address], [deployer.address], deployer.address);
    const timelockAddress = await timelock.getAddress();
    const steward = await (await ethers.getContractFactory("TreasurySteward")).deploy(timelockAddress);
    const treasury = await (await ethers.getContractFactory("ArmadaTreasuryGov")).deploy(timelockAddress);
    const usdc = await (await ethers.getContractFactory("MockUSDCV2")).deploy("Mock USDC", "USDC");
    const safe = await (await ethers.getContractFactory("ReserveAllocatorIntrospectionMock"))
      .deploy([a.address, b.address, c.address], 2);
    const contracts = {
      steward: await steward.getAddress(),
      treasury: await treasury.getAddress(),
      usdc: await usdc.getAddress(),
    };
    const config: InitialStewardConfig = { address: await safe.getAddress(), budgetUsdc: "60000", budgetWindow: 30 * ONE_DAY };
    const otherRoles = [
      { label: "deployer", address: deployer.address },
      { label: "security council", address: sc.address },
      { label: "launch team", address: launchTeam.address },
    ];
    return { deployer, a, b, c, sc, stewardEoa, timelock, steward, treasury, usdc, contracts, config, otherRoles };
  }

  describe("assertInitialStewardPreflight", function () {
    // WHY: control case — a 2-of-3 Safe that holds no other launch role is the intended steward.
    it("accepts a 2-of-3 Safe distinct from the other launch roles", async function () {
      const { config, otherRoles } = await fixture();
      await assertInitialStewardPreflight(config, otherRoles, true);
    });

    // WHY: the steward can create pass-by-default spend proposals; a single key (or a 1-of-n
    // Safe) turns one compromised signer into treasury spending authority.
    it("rejects an EOA and a Safe with the wrong threshold when a multisig is required", async function () {
      const { config, otherRoles, stewardEoa, a, b, c } = await fixture();
      await expect(assertInitialStewardPreflight({ ...config, address: stewardEoa.address }, otherRoles, true))
        .to.be.rejectedWith("Initial steward must be a deployed multisig");
      const oneOfThree = await (await ethers.getContractFactory("ReserveAllocatorIntrospectionMock"))
        .deploy([a.address, b.address, c.address], 1);
      await expect(assertInitialStewardPreflight({ ...config, address: await oneOfThree.getAddress() }, otherRoles, true))
        .to.be.rejectedWith("Initial steward must report exactly three distinct owners and threshold two");
    });

    // WHY: the security council vetoes steward proposals and the launch team / deployer hold
    // other launch powers; sharing an address with any of them collapses that separation.
    it("rejects a steward that equals another launch role, ignoring address case", async function () {
      const { config, otherRoles } = await fixture();
      for (const role of otherRoles) {
        await expect(assertInitialStewardPreflight({ ...config, address: role.address.toLowerCase() }, otherRoles, false))
          .to.be.rejectedWith(`Initial steward must differ from the ${role.label}`);
      }
    });

    // WHY: a mixed-case address with a bad EIP-55 checksum is almost always a typo. The election
    // call rejects it, but only after the crowdfund stage has spent its one-shot setters, so the
    // pre-flight must refuse it before the first transaction.
    it("rejects a mixed-case address with a bad checksum", async function () {
      const { config, otherRoles } = await fixture();
      const lower = config.address.toLowerCase();
      const badChecksum = "0x" + lower.slice(2).replace(/[a-f]/, ch => ch.toUpperCase());
      await expect(assertInitialStewardPreflight({ ...config, address: badChecksum }, otherRoles, true))
        .to.be.rejectedWith("bad address checksum");
    });

    // WHY: unset optional roles (e.g. no reserve allocator) arrive as empty strings and must
    // not be treated as a collision or crash the check.
    it("skips unset roles", async function () {
      const { config, otherRoles } = await fixture();
      await assertInitialStewardPreflight(config, [...otherRoles, { label: "reserve allocator", address: "" }], true);
    });

    // WHY: local stacks use Anvil EOAs for every role; the Safe check applies off-local only.
    it("accepts an EOA when no multisig is required (local)", async function () {
      const { config, otherRoles, stewardEoa } = await fixture();
      await assertInitialStewardPreflight({ ...config, address: stewardEoa.address }, otherRoles, false);
    });
  });

  describe("assertUsdcDecimals", function () {
    // WHY: the budget is configured in whole USDC and scaled by 6 decimals; an 18-decimal
    // token would receive a budget 10^12 times smaller than intended (or larger, if the
    // scaling were ever inverted), so the deploy must stop instead.
    it("accepts 6-decimal USDC and rejects an 18-decimal token", async function () {
      const { contracts, deployer } = await fixture();
      await assertUsdcDecimals(contracts.usdc);
      const arm = await (await ethers.getContractFactory("ArmadaToken")).deploy(deployer.address, deployer.address);
      await expect(assertUsdcDecimals(await arm.getAddress())).to.be.rejectedWith("reports 18 decimals");
    });
  });

  describe("seedInitialSteward", function () {
    // WHY: the deploy must leave exactly the configured steward elected and exactly the
    // configured USDC budget authorized — nothing more permissive.
    it("elects the steward and authorizes the USDC budget through the timelock", async function () {
      const { config, contracts, timelock, steward, treasury } = await fixture();
      const { termEnd } = await seedInitialSteward(config, contracts, timelockExecutor(timelock));

      expect(await steward.currentSteward()).to.equal(config.address);
      expect(await steward.isStewardActive()).to.equal(true);
      expect(termEnd).to.equal((await steward.termStart()) + 180n * BigInt(ONE_DAY));
      const budget = await treasury.stewardBudgets(contracts.usdc);
      expect(budget.limit).to.equal(USDC(60000));
      expect(budget.window).to.equal(BigInt(30 * ONE_DAY));
      expect(budget.authorized).to.equal(true);
      expect(stewardBudgetLimit(config)).to.equal(USDC(60000));
    });

    // WHY: read-back is the only proof the timelock calls took effect; if they silently did
    // not, the deploy must abort before renouncing the roles that could still fix it.
    it("aborts when the on-chain state does not match after the timelock calls", async function () {
      const { config, contracts } = await fixture();
      await expect(seedInitialSteward(config, contracts, async () => undefined))
        .to.be.rejectedWith("Initial steward read-back failed");
    });
  });

  describe("initialStewardChecks", function () {
    // WHY: verify_deployment reports these rows; a seeded deploy must pass every one.
    it("passes after seeding", async function () {
      const { config, contracts, timelock } = await fixture();
      await seedInitialSteward(config, contracts, timelockExecutor(timelock));
      const checks = await initialStewardChecks(config, contracts);
      expect(checks.map(check => check.status)).to.deep.equal(["PASS", "PASS", "PASS"]);
    });

    // WHY: a deploy that skipped or mis-ran the seeding must show as FAIL, never PASS.
    it("fails every row when nothing was seeded", async function () {
      const { config, contracts } = await fixture();
      const checks = await initialStewardChecks(config, contracts);
      expect(checks.map(check => check.status)).to.deep.equal(["FAIL", "FAIL", "FAIL"]);
    });
  });
});

describe("Sale-window steward exposure with a deploy-time budget (accepted risk, #222)", function () {
  this.timeout(300_000);

  // Production-shaped launch: all 12M ARM sits in the treasury (cannot delegate), the
  // crowdfund (unclaimed) and a locked-allocation stand-in, so no address holds voting power
  // during the sale. The steward is an EOA here only so it can sign proposals directly.
  async function launchFixture() {
    const signers = await ethers.getSigners();
    const [deployer, sc, stewardKey, recipient, lockStandIn] = signers;
    const seeds = signers.slice(10, 110);
    // Hop-1 committers: under the revised waterfall hop-0 alone is capped below MIN_SALE ($846k at
    // the expanded sale), so the sale needs hop-1 demand to finalize successfully and fund the treasury.
    const hop1 = signers.slice(5, 10);

    const timelock = await (await ethers.getContractFactory("TimelockController"))
      .deploy(0, [deployer.address], [deployer.address], deployer.address);
    const timelockAddress = await timelock.getAddress();
    const armToken = await (await ethers.getContractFactory("ArmadaToken")).deploy(deployer.address, timelockAddress);
    const usdc = await (await ethers.getContractFactory("MockUSDCV2")).deploy("Mock USDC", "USDC");
    const treasury = await (await ethers.getContractFactory("ArmadaTreasuryGov")).deploy(timelockAddress);
    const treasuryAddress = await treasury.getAddress();
    const governor = await deployGovernorProxy(await armToken.getAddress(), timelockAddress, treasuryAddress) as any;
    const governorAddress = await governor.getAddress();
    const steward = await (await ethers.getContractFactory("TreasurySteward")).deploy(timelockAddress);
    const crowdfund = await (await ethers.getContractFactory("ArmadaCrowdfund")).deploy(
      await usdc.getAddress(), await armToken.getAddress(), treasuryAddress,
      deployer.address, sc.address, (await time.latest()) + 300);
    const crowdfundAddress = await crowdfund.getAddress();

    for (const role of [await timelock.PROPOSER_ROLE(), await timelock.EXECUTOR_ROLE(), await timelock.CANCELLER_ROLE()]) {
      await timelock.grantRole(role, governorAddress);
    }
    await governor.setStewardContract(await steward.getAddress());
    await governor.setCrowdfundAddress(crowdfundAddress);
    await governor.setSecurityCouncil(sc.address);

    await armToken.initWhitelist([deployer.address, crowdfundAddress, treasuryAddress]);
    await armToken.initAuthorizedDelegators([crowdfundAddress]);
    await armToken.transfer(crowdfundAddress, ARM(1_800_000));
    await crowdfund.loadArm();
    await armToken.transfer(treasuryAddress, ARM(7_800_000));
    await armToken.transfer(lockStandIn.address, ARM(2_400_000));

    const asTimelock = timelockExecutor(timelock);
    await asTimelock(treasuryAddress, treasury.interface.encodeFunctionData("initOutflowConfig",
      [await usdc.getAddress(), 30 * ONE_DAY, 1000, USDC(100_000), USDC(50_000)]), "initOutflowConfig(USDC)");
    await seedInitialSteward(
      { address: stewardKey.address, budgetUsdc: "60000", budgetWindow: 30 * ONE_DAY },
      { steward: await steward.getAddress(), treasury: treasuryAddress, usdc: await usdc.getAddress() },
      asTimelock);

    return { deployer, sc, stewardKey, recipient, seeds, hop1, timelock, governor, treasury, steward, usdc, crowdfund, asTimelock };
  }

  async function proposeSpend(governor: any, stewardKey: any, usdc: any, recipient: string, amount: bigint) {
    const id = (await governor.proposalCount()) + 1n;
    await governor.connect(stewardKey).proposeStewardSpend([await usdc.getAddress()], [recipient], [amount], "ops");
    return id;
  }

  // WHY: this pins the risk accepted when seeding the budget at deploy. During the sale nobody
  // can vote a steward spend down, an empty treasury does not stop it being queued, and it pays
  // out once finalize funds the treasury. What bounds it: one budget per window, the security
  // council veto, and steward removal killing the queued backlog. A change that widens any of
  // these must fail here.
  it("bounds a sale-window steward spend to one budget per window, vetoable and removable", async function () {
    const { sc, stewardKey, recipient, seeds, hop1, governor, treasury, steward, usdc, crowdfund, asTimelock } =
      await launchFixture();
    const QUEUED = 4n, CANCELED = 6n;
    const UNDERLYING_REVERT = "TimelockController: underlying transaction reverted";

    // Sale opens; seeds are added. Three $60k spend proposals are created during the sale.
    await time.increaseTo(await crowdfund.windowStart());
    await crowdfund.addSeeds(seeds.map(s => s.address));
    // The launch team invites each hop-1 committer 10 times, stacking its cap to $40k.
    for (const p of hop1) {
      for (let i = 0; i < 10; i++) await crowdfund.launchTeamInvite(p.address, 0);
    }
    const first = await proposeSpend(governor, stewardKey, usdc, recipient.address, USDC(60_000));
    const second = await proposeSpend(governor, stewardKey, usdc, recipient.address, USDC(60_000));
    const third = await proposeSpend(governor, stewardKey, usdc, recipient.address, USDC(60_000));

    // Nobody holds voting power during the sale, so the proposals cannot be voted down.
    await expect(governor.connect(seeds[0]).castVote(first, 0)).to.be.revertedWithCustomError(governor, "Gov_NoVotingPower");

    // They queue against an empty treasury; execution reverts until USDC arrives.
    await time.increase(7 * ONE_DAY + 1);
    for (const id of [first, second, third]) await governor.queue(id);
    expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(0n);
    await time.increase(2 * ONE_DAY + 1);
    await expect(governor.execute(first)).to.be.revertedWith(UNDERLYING_REVERT);

    // The security council vetoes one queued proposal; it can never execute.
    await governor.connect(sc).veto(third, ethers.id("compromised steward"));
    expect(await governor.state(third)).to.equal(CANCELED);

    // Seeds commit; the sale finalizes and pushes proceeds to the treasury.
    for (const seed of seeds) {
      await usdc.mint(seed.address, USDC(15_000));
      await usdc.connect(seed).approve(await crowdfund.getAddress(), USDC(15_000));
      await crowdfund.connect(seed).commit(0, USDC(15_000));
    }
    // $1.5M hop-0 (expanded sale, $846k allocated) + $200k hop-1 clears the $1M minimum.
    for (const p of hop1) {
      await usdc.mint(p.address, USDC(40_000));
      await usdc.connect(p).approve(await crowdfund.getAddress(), USDC(40_000));
      await crowdfund.connect(p).commit(1, USDC(40_000));
    }
    await time.increaseTo((await crowdfund.windowEnd()) + 1n);
    await crowdfund.finalize();
    expect(await usdc.balanceOf(await treasury.getAddress())).to.be.gt(USDC(120_000));

    // The first queued spend now pays out; the second exceeds the 30-day budget. stewardSpend
    // checks the budget before the outflow limit, so a zero remaining budget is the revert.
    await governor.execute(first);
    expect(await usdc.balanceOf(recipient.address)).to.equal(USDC(60_000));
    expect((await treasury.getStewardBudget(await usdc.getAddress())).remaining).to.equal(0n);
    await expect(governor.execute(second)).to.be.revertedWith(UNDERLYING_REVERT);
    await expect(governor.execute(third)).to.be.revertedWithCustomError(governor, "Gov_NotQueued");
    // New steward proposals are blocked during the post-finalize quiet period.
    await expect(proposeSpend(governor, stewardKey, usdc, recipient.address, USDC(1)))
      .to.be.revertedWithCustomError(governor, "Gov_QuietPeriodActive");

    // After the 10-day quiet period another proposal queues; the backlog drips one budget per window.
    await time.increase(10 * ONE_DAY + 1);
    const fourth = await proposeSpend(governor, stewardKey, usdc, recipient.address, USDC(60_000));
    await time.increase(7 * ONE_DAY + 1);
    await governor.queue(fourth);
    await time.increase(17 * ONE_DAY);
    await governor.execute(second);
    expect(await usdc.balanceOf(recipient.address)).to.equal(USDC(120_000));
    expect(await governor.state(fourth)).to.equal(QUEUED);

    // Removing the steward (a passed Standard proposal on mainnet) kills the queued backlog.
    await asTimelock(await steward.getAddress(), steward.interface.encodeFunctionData("removeSteward"), "removeSteward");
    await time.increase(30 * ONE_DAY + 1);
    await expect(governor.execute(fourth)).to.be.revertedWithCustomError(governor, "Gov_StewardProposerNoLongerActive");
    expect(await usdc.balanceOf(recipient.address)).to.equal(USDC(120_000));
  });
});
