// ABOUTME: Guards for the mainnet crowdfund-launch deploy — remote-network gas headroom and
// ABOUTME: the refusal to re-run the orchestrator over manifests from an earlier launch.
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";
import { assertNoPriorLaunch, INTERRUPTED_LAUNCH_RUNBOOK } from "../scripts/deploy-utils";

describe("Mainnet launch deploy guards", function () {
  describe("remote network gas headroom", function () {
    // WHY: public RPCs underestimate eth_estimateGas for slot-clearing SSTOREs, so admin
    // calls like governor.clearDeployer() and timelock.renounceRole() run out of gas at
    // 1.2x. A revert there leaves a half-finished launch that cannot be re-run, so every
    // live network (Sepolia and mainnet, hub and clients) needs the 2.0x headroom.
    it("uses gasMultiplier >= 2.0 on every sepolia* and mainnet* network", function () {
      const remote = Object.entries(hre.config.networks)
        .filter(([name]) => name.startsWith("sepolia") || name.startsWith("mainnet"));
      expect(remote.map(([name]) => name)).to.include.members(["sepoliaHub", "mainnetHub", "mainnetClient1"]);
      for (const [name, net] of remote) {
        expect((net as { gasMultiplier?: number }).gasMultiplier, name).to.be.at.least(2.0);
      }
    });
  });

  describe("assertNoPriorLaunch", function () {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-guard-")); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    // WHY: a fresh launch has no governance/crowdfund manifests and must proceed.
    it("passes when none of the manifests exist", function () {
      expect(() => assertNoPriorLaunch(["governance-hub-mainnet.json", "crowdfund-hub-mainnet.json"], dir))
        .to.not.throw();
    });

    // WHY: a manifest means an earlier run already sent transactions. Re-running would deploy
    // a second stack and overwrite the record of the first, so the operator must be sent to
    // the recovery runbook instead.
    it("throws naming the existing manifest and the recovery runbook", function () {
      fs.writeFileSync(path.join(dir, "governance-hub-mainnet.json"), "{}");
      expect(() => assertNoPriorLaunch(["governance-hub-mainnet.json", "crowdfund-hub-mainnet.json"], dir))
        .to.throw(/governance-hub-mainnet\.json[\s\S]*docs\/interrupted-launch-recovery\.md/);
      expect(INTERRUPTED_LAUNCH_RUNBOOK).to.equal("docs/interrupted-launch-recovery.md");
    });
  });
});
