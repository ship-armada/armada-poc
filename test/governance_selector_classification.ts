// ABOUTME: Regression tests for ArmadaGovernor.initialize() selector classification.
// ABOUTME: Locks in the Standard vs. Extended assignment for spec-critical selectors.

import { expect } from "chai";
import { ethers } from "hardhat";
import { deployGovernorProxy } from "./helpers/deploy-governor";

// Inline keccak256 selector helper to avoid coupling to ABI fragments.
function sel(sig: string): string {
  return ethers.id(sig).slice(0, 10);
}

describe("Governance Selector Classification", function () {
  let governor: any;

  before(async function () {
    const [deployer] = await ethers.getSigners();

    // Minimal dependency set: the classification test doesn't exercise any
    // token / treasury / timelock logic, just the mappings populated by
    // initialize(). We still need non-zero addresses for the proxy call
    // because initialize() stores them.

    const TimelockController = await ethers.getContractFactory("TimelockController");
    const timelock = await TimelockController.deploy(2 * 86400, [], [], deployer.address);
    await timelock.waitForDeployment();

    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    const token = await ArmadaToken.deploy(deployer.address, await timelock.getAddress());
    await token.waitForDeployment();

    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    const treasury = await ArmadaTreasuryGov.deploy(await timelock.getAddress());
    await treasury.waitForDeployment();

    governor = await deployGovernorProxy(
      await token.getAddress(),
      await timelock.getAddress(),
      await treasury.getAddress(),
    );
  });

  // WHY: Under the asymmetric governance principle ("tightening is easy,
  // loosening is hard"), routine operational actions and tightening actions
  // (revoking adapter access, attesting revenue, adjusting wind-down
  // operational params) belong at the Standard bar (20% quorum / 7d). Pin
  // the exact assignment so a refactor cannot silently flip one back to
  // Extended and re-raise the bar on operational governance.
  describe("Standard-classified selectors", function () {
    const standardSelectors: [string, string][] = [
      ["deauthorizeAdapter(address)", "tightening — revokes adapter access"],
      ["fullDeauthorizeAdapter(address)", "tightening — fully removes adapter"],
      ["setRevenueThreshold(uint256)", "operational wind-down parameter"],
      ["setWindDownDeadline(uint256)", "operational wind-down parameter"],
      ["attestRevenue(uint256)", "operational non-stablecoin revenue attestation"],
    ];

    for (const [sig, reason] of standardSelectors) {
      it(`registers ${sig} as Standard (${reason})`, async function () {
        expect(await governor.standardSelectors(sel(sig))).to.equal(true);
        expect(await governor.extendedSelectors(sel(sig))).to.equal(false);
      });
    }
  });

  // WHY: authorizeAdapter is the loosening counterpart to deauthorize.
  // Granting a new contract access to the shielded yield surface must stay
  // Extended (30% quorum / 14d) per the spec's directional split. This
  // guards the split from an over-eager refactor that moves both sides of
  // the pair to Standard together.
  describe("Extended-classified selectors (spec-pinned)", function () {
    it("keeps authorizeAdapter(address) as Extended", async function () {
      const s = sel("authorizeAdapter(address)");
      expect(await governor.extendedSelectors(s)).to.equal(true);
      expect(await governor.standardSelectors(s)).to.equal(false);
    });
  });
});
