// ABOUTME: Tests the governor bootstrap rows of verify_deployment against a real governor proxy.
// ABOUTME: A hardened launch must fail on a retained deployer or a missing crowdfund registration.
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployGovernorProxy } from "./helpers/deploy-governor";
import { governorBootstrapChecks } from "../scripts/verify-governor";

describe("governorBootstrapChecks", function () {
  async function fixture() {
    const [deployer, treasury, crowdfund, other] = await ethers.getSigners();
    const timelock = await (await ethers.getContractFactory("TimelockController"))
      .deploy(0, [deployer.address], [deployer.address], deployer.address);
    const token = await (await ethers.getContractFactory("ArmadaToken"))
      .deploy(deployer.address, await timelock.getAddress());
    const governor: any = await deployGovernorProxy(
      await token.getAddress(), await timelock.getAddress(), treasury.address);
    return { governor, address: await governor.getAddress(), crowdfund, other };
  }

  const statuses = (checks: { check: string; status: string }[]) =>
    Object.fromEntries(checks.map((c) => [c.check, c.status]));

  // WHY: the launch deploy registers the crowdfund and then clears the deployer; a governor in that
  // state must pass both rows.
  it("passes once the crowdfund is registered and the deployer cleared", async function () {
    const { governor, address, crowdfund } = await fixture();
    await governor.setCrowdfundAddress(crowdfund.address);
    await governor.clearDeployer();
    expect(statuses(await governorBootstrapChecks(address, crowdfund.address, true))).to.deep.equal({
      "Governor deployer cleared": "PASS",
      "Governor crowdfund registered": "PASS",
    });
  });

  // WHY: a retained deployer keeps one-time bootstrap powers (e.g. setSecurityCouncil) outside
  // governance and the veto. A hardened launch must fail on it; a partial deployment only warns.
  it("fails a retained deployer when hardened and warns otherwise", async function () {
    const { governor, address, crowdfund } = await fixture();
    await governor.setCrowdfundAddress(crowdfund.address);
    expect(statuses(await governorBootstrapChecks(address, crowdfund.address, true))["Governor deployer cleared"])
      .to.equal("FAIL");
    expect(statuses(await governorBootstrapChecks(address, crowdfund.address, false))["Governor deployer cleared"])
      .to.equal("WARN");
  });

  // WHY: the governance quiet period and the 70-day veto bootstrap both read the registered
  // crowdfund's finalizedAt. An unset or wrong registration silently disables both, so it must fail.
  it("fails when the crowdfund is unregistered or a different address", async function () {
    const unset = await fixture();
    expect(statuses(await governorBootstrapChecks(unset.address, unset.crowdfund.address, true))["Governor crowdfund registered"])
      .to.equal("FAIL");

    const wrong = await fixture();
    await wrong.governor.setCrowdfundAddress(wrong.other.address);
    expect(statuses(await governorBootstrapChecks(wrong.address, wrong.crowdfund.address, true))["Governor crowdfund registered"])
      .to.equal("FAIL");
  });

  // WHY: without a crowdfund manifest there is nothing to compare the registration against; the
  // row is omitted rather than guessed (the crowdfund group already reports the missing manifest).
  it("omits the crowdfund row when no crowdfund address is expected", async function () {
    const { address } = await fixture();
    expect(Object.keys(statuses(await governorBootstrapChecks(address, null, false))))
      .to.deep.equal(["Governor deployer cleared"]);
  });
});
