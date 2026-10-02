// ABOUTME: Guards for the mainnet crowdfund-launch deploy — remote-network gas headroom, the
// ABOUTME: re-run refusal, the absolute crowdfund open time, pool-treasury override and harden profile.
import { expect } from "chai";
import { spawnSync } from "child_process";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";
import {
  assertNoPriorLaunch,
  saveDeployment,
  saveDeploymentInProgress,
  assertDeploymentComplete,
  INTERRUPTED_LAUNCH_RUNBOOK,
  resolveCrowdfundOpenTimestamp,
  assertDeployCommit,
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
  describe("in-progress launch manifests", function () {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-progress-")); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

    // WHY: a stage that stops part-way must still leave a manifest — it records the addresses
    // already deployed for recovery and makes the mainnet re-run guard refuse a second stack.
    it("marks an unfinished stage's manifest and trips the re-run guard", function () {
      saveDeploymentInProgress("governance-hub-mainnet.json", { contracts: { timelockController: "0x01" } }, dir);
      expect(read("governance-hub-mainnet.json")).to.deep.equal(
        { contracts: { timelockController: "0x01" }, inProgress: true });
      expect(() => assertNoPriorLaunch(["governance-hub-mainnet.json"], dir)).to.throw(/Do not re-run/);
    });

    // WHY: the stage's final save replaces the in-progress record with the complete manifest.
    it("drops the marker when the stage saves its final manifest", function () {
      saveDeploymentInProgress("governance-hub-mainnet.json", { contracts: {} }, dir);
      saveDeployment("governance-hub-mainnet.json", { contracts: { governor: "0x02" } }, dir);
      expect(read("governance-hub-mainnet.json")).to.not.have.property("inProgress");
    });

    // WHY: the crowdfund stage consumes one-shot initializers against the governance
    // contracts; building on a governance stage that did not finish must stop before any
    // transaction and point at the recovery runbook.
    it("refuses a manifest from an unfinished stage", function () {
      expect(() => assertDeploymentComplete({ contracts: {}, inProgress: true }, "governance-hub-mainnet.json"))
        .to.throw(/governance-hub-mainnet\.json[\s\S]*did not finish[\s\S]*docs\/interrupted-launch-recovery\.md/);
    });

    // WHY: complete manifests, including ones written before the marker existed, pass.
    it("accepts a complete manifest", function () {
      expect(() => assertDeploymentComplete({ contracts: {} }, "governance-hub-sepolia.json")).to.not.throw();
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
  describe("mainnet config refusals (orchestrator dry-run)", function () {
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

    // WHY: without the harden profile the deployer holds no timelock roles, so the crowdfund
    // step would revert at its first timelock-only call after spending one-shot initializers.
    // The orchestrator must refuse up front instead of warning and running anyway.
    it("refuses to start when HARDEN_TIMELOCK is disabled", function () {
      const result = dryRun({ HARDEN_TIMELOCK: "false" });
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include("HARDEN_TIMELOCK must not be disabled on mainnet");
      expect(result.stdout).to.not.include("CROWDFUND-LAUNCH DEPLOYMENT");
    });
  });
  describe("assertDeployCommit", function () {
    let repo: string;
    let head: string;

    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    };

    beforeEach(function () {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-commit-"));
      git("init", "-q");
      write("contracts/Crowdfund.sol", "uint256 constant MAX_SALE = 1_800_000;\n");
      git("add", "-A");
      git("commit", "-q", "-m", "launch");
      head = git("rev-parse", "HEAD");
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    // WHY: deploying exactly the intended commit from a clean tree is the case that must pass.
    it("passes when HEAD is DEPLOY_COMMIT and the tree is clean", function () {
      expect(assertDeployCommit(head, repo)).to.equal(head);
    });

    // WHY: a different checkout (e.g. the mini-crowdfund-constants branch) compiles different
    // bytecode, and the mistake only surfaces after one-shot initializers are spent.
    it("rejects a HEAD other than DEPLOY_COMMIT", function () {
      write("contracts/Crowdfund.sol", "uint256 constant MAX_SALE = 360;\n");
      git("add", "-A");
      git("commit", "-q", "-m", "other");
      expect(() => assertDeployCommit(head, repo)).to.throw(/HEAD is [0-9a-f]{40}, DEPLOY_COMMIT is/);
    });

    // WHY: hardhat compiles the working tree, not HEAD — a local edit or untracked file would
    // deploy code that is in no commit even though HEAD matches.
    it("rejects uncommitted changes to a tracked file", function () {
      write("contracts/Crowdfund.sol", "uint256 constant MAX_SALE = 360;\n");
      expect(() => assertDeployCommit(head, repo)).to.throw(/working tree is not clean/);
    });

    it("rejects an untracked file", function () {
      write("contracts/Extra.sol", "contract Extra {}\n");
      expect(() => assertDeployCommit(head, repo)).to.throw(/working tree is not clean/);
    });

    // WHY: a short or mistyped SHA must fail clearly rather than match by prefix.
    for (const bad of ["", "abc1234", "a".repeat(39), "a".repeat(41), "g".repeat(40)]) {
      it(`rejects the malformed DEPLOY_COMMIT "${bad}"`, function () {
        expect(() => assertDeployCommit(bad, repo)).to.throw(/full 40-character/);
      });
    }
  });
});
