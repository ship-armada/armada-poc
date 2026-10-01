// ABOUTME: Guards for the mainnet crowdfund-launch deploy — remote-network gas headroom, the
// ABOUTME: re-run refusal, the absolute crowdfund open time, and the pool-treasury override.
import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";
import {
  assertNoPriorLaunch,
  INTERRUPTED_LAUNCH_RUNBOOK,
  resolveCrowdfundOpenTimestamp,
  CROWDFUND_OPEN_MIN_LEAD_SECONDS,
  CROWDFUND_OPEN_MAX_LEAD_SECONDS,
} from "../scripts/deploy-utils";

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
  describe("resolveCrowdfundOpenTimestamp", function () {
    const NOW = 1_790_000_000; // 2026-09-21T14:13:20Z
    const OPEN_TIME = "2026-10-08T17:00:00Z";
    const OPEN_TS = Date.UTC(2026, 9, 8, 17, 0, 0) / 1000;

    // WHY: the announced UTC open time must become exactly that unix timestamp — windowStart
    // is immutable, so an off-by-timezone or seconds/milliseconds slip cannot be fixed later.
    it("converts an absolute ISO 8601 UTC open time to unix seconds", function () {
      expect(resolveCrowdfundOpenTimestamp(OPEN_TIME, 600, NOW, CROWDFUND_OPEN_MIN_LEAD_SECONDS))
        .to.equal(OPEN_TS);
    });

    // WHY: local and Sepolia deploys without an absolute time keep opening after the delay.
    it("falls back to now + delay when no absolute open time is set", function () {
      expect(resolveCrowdfundOpenTimestamp(undefined, 600, NOW, CROWDFUND_OPEN_MIN_LEAD_SECONDS))
        .to.equal(NOW + 600);
    });

    // WHY: only an explicit UTC "Z" timestamp is unambiguous. A missing zone is parsed in the
    // operator's local timezone, and a bare number could be seconds or milliseconds.
    for (const bad of ["2026-10-08T17:00:00", "2026-10-08 17:00:00Z", "2026-10-08T17:00:00+02:00",
      "2026-10-08", "1791478800", "2026-13-08T17:00:00Z", "2026-10-08T17:00:00.000Z"]) {
      it(`rejects the non-canonical format "${bad}"`, function () {
        expect(() => resolveCrowdfundOpenTimestamp(bad, 600, NOW, CROWDFUND_OPEN_MIN_LEAD_SECONDS))
          .to.throw(/CROWDFUND_OPEN_TIME/);
      });
    }

    // WHY: the post-deploy steps (wiring, verification, manifest publish, frontend pin,
    // indexer start) must fit before the sale opens, and the check runs before any
    // transaction so a too-close time cannot strand a half-deployed launch.
    it("rejects an open time closer than the minimum lead", function () {
      const tooSoon = NOW + CROWDFUND_OPEN_MIN_LEAD_SECONDS - 1;
      const iso = new Date(tooSoon * 1000).toISOString().replace(".000Z", "Z");
      expect(() => resolveCrowdfundOpenTimestamp(iso, 600, NOW, CROWDFUND_OPEN_MIN_LEAD_SECONDS))
        .to.throw(/at least/);
    });

    // WHY: the crowdfund step runs after governance, so it re-checks with a zero lead — the
    // constructor's own "not in the past" rule — rather than failing a run the pre-flight passed.
    it("accepts an open time inside the minimum lead when the caller passes a zero lead", function () {
      const soon = NOW + 60;
      const iso = new Date(soon * 1000).toISOString().replace(".000Z", "Z");
      expect(resolveCrowdfundOpenTimestamp(iso, 600, NOW, 0)).to.equal(soon);
      expect(() => resolveCrowdfundOpenTimestamp(iso, 600, NOW + 61, 0)).to.throw(/at least/);
    });

    // WHY: a far-future open time is almost certainly a typo (wrong year or month), and the
    // immutable window would lock the sale ARM until then.
    it("rejects an open time beyond the maximum lead", function () {
      const tooFar = NOW + CROWDFUND_OPEN_MAX_LEAD_SECONDS + 1;
      const iso = new Date(tooFar * 1000).toISOString().replace(".000Z", "Z");
      expect(() => resolveCrowdfundOpenTimestamp(iso, 600, NOW, CROWDFUND_OPEN_MIN_LEAD_SECONDS))
        .to.throw(/at most/);
    });

    // WHY: end to end on a chain — the resolved absolute time must land in the deployed
    // crowdfund's immutable window boundaries unchanged.
    it("sets the deployed crowdfund's windowStart to the absolute open time", async function () {
      const latest = await hre.ethers.provider.getBlock("latest");
      const openTs = latest!.timestamp + 2 * 86400;
      const iso = new Date(openTs * 1000).toISOString().replace(".000Z", "Z");
      const resolved = resolveCrowdfundOpenTimestamp(iso, 600, latest!.timestamp, 0);

      const signers = await hre.ethers.getSigners();
      const addr = (i: number) => signers[i].address;
      const Crowdfund = await hre.ethers.getContractFactory("ArmadaCrowdfund");
      const crowdfund = await Crowdfund.deploy(addr(1), addr(2), addr(3), addr(4), addr(5), resolved);
      await crowdfund.waitForDeployment();

      expect(await crowdfund.windowStart()).to.equal(BigInt(openTs));
      expect(await crowdfund.windowEnd()).to.equal(BigInt(openTs) + (await crowdfund.WINDOW_DURATION()));
    });
  });
  describe("TREASURY_ADDRESS on mainnet (orchestrator dry-run)", function () {
    // Spawning ts-node compiles the orchestrator and config on each run.
    this.timeout(120_000);

    /** Env for `deploy_mainnet.ts --dry-run`: the committed mainnet.env plus launch-time inputs. */
    function mainnetDryRunEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
      const template = fs.readFileSync(path.join(__dirname, "..", "config", "mainnet.env"), "utf8");
      for (const line of template.split("\n")) {
        const m = line.match(/^export ([A-Z0-9_]+)=(.*)$/);
        if (m) env[m[1]] = m[2];
      }
      // Two days out: inside the orchestrator's open-time lead bounds.
      const openTs = Math.floor(Date.now() / 1000) + 2 * 86400;
      return {
        ...env,
        DEPLOYER_PRIVATE_KEY: "test-placeholder-not-a-real-key",
        REVENUE_LOCK_BENEFICIARIES_JSON: JSON.stringify(
          [{ address: "0x0000000000000000000000000000000000000001", amount: "2400000", label: "test" }]),
        CROWDFUND_OPEN_TIME: new Date(openTs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        ...extra,
      };
    }

    function dryRun(extra: Record<string, string>) {
      return spawnSync("npx", ["ts-node", "scripts/deploy_mainnet.ts", "--dry-run"], {
        cwd: path.join(__dirname, ".."), env: mainnetDryRunEnv(extra), encoding: "utf8",
      });
    }

    // WHY: control case — the committed mainnet template (plus launch-time inputs) must reach
    // the dry-run plan, so the refusal below is attributable to TREASURY_ADDRESS alone.
    it("prints the launch plan when TREASURY_ADDRESS is unset", function () {
      const result = dryRun({});
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.include("CROWDFUND-LAUNCH DEPLOYMENT");
    });

    // WHY: the privacy pool fee recipient is fixed at initialize(); a mainnet override would
    // send all protocol fees outside governance for good. The launch must stop before any
    // step runs, not at the later privacy-pool deploy.
    it("refuses to start when TREASURY_ADDRESS is set", function () {
      const result = dryRun({ TREASURY_ADDRESS: "0x0000000000000000000000000000000000000002" });
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include("TREASURY_ADDRESS must not be set on mainnet");
      expect(result.stdout).to.not.include("CROWDFUND-LAUNCH DEPLOYMENT");
    });
  });
});
