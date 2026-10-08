// ABOUTME: Guards for the mainnet crowdfund-launch deploy — remote-network gas headroom, the
// ABOUTME: re-run refusal, the absolute crowdfund open time, pool-treasury override, harden profile and reserve.
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
  resolveCrowdfundOpenMinLead,
  assertDeployCommit,
  CROWDFUND_OPEN_MIN_LEAD_SECONDS,
  CROWDFUND_OPEN_MIN_LEAD_FLOOR_SECONDS,
  CROWDFUND_OPEN_MAX_LEAD_SECONDS,
} from "../scripts/deploy-utils";
import { assertLaunchRoleMultisigs } from "../scripts/revenue-reserve";

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
  describe("resolveCrowdfundOpenMinLead", function () {
    // WHY: without an override the launch keeps the full default lead sized for a Ledger run.
    it("returns the default lead when no override is set", function () {
      expect(resolveCrowdfundOpenMinLead(undefined)).to.equal(CROWDFUND_OPEN_MIN_LEAD_SECONDS);
    });

    // WHY: the Sepolia rehearsal signed in about 20 minutes, so an announced open time a few
    // hours out must be reachable without editing code.
    it("accepts an override at or above the floor", function () {
      expect(resolveCrowdfundOpenMinLead("3600")).to.equal(3600);
      expect(resolveCrowdfundOpenMinLead("5400")).to.equal(5400);
      expect(resolveCrowdfundOpenMinLead("86400")).to.equal(86400);
    });

    // WHY: below an hour the signing plus post-deploy steps may not fit, and a run that overruns
    // fails at the crowdfund step after governance is already on chain.
    it("rejects an override below the floor", function () {
      expect(() => resolveCrowdfundOpenMinLead(String(CROWDFUND_OPEN_MIN_LEAD_FLOOR_SECONDS - 1)))
        .to.throw(/at least 3600/);
      expect(() => resolveCrowdfundOpenMinLead("0")).to.throw(/at least 3600/);
    });

    // WHY: parseInt would read "1h" as 1 second and "5400.5" as 5400; only plain whole seconds
    // are unambiguous.
    for (const bad of ["1h", "-3600", "5400.5", "3600 ", "0x1000", "1e4"]) {
      it(`rejects the non-integer override "${bad}"`, function () {
        expect(() => resolveCrowdfundOpenMinLead(bad)).to.throw(/CROWDFUND_OPEN_MIN_LEAD_SECONDS/);
      });
    }
  });
  describe("mainnet config refusals (orchestrator dry-run)", function () {
    // Spawning ts-node compiles the orchestrator and config on each run.
    this.timeout(120_000);

    const DRY_RUN_STEWARD = "0x0000000000000000000000000000000000000003";
    const DRY_RUN_ALLOCATOR = "0x0000000000000000000000000000000000000004";

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
        // The template points at the gitignored mainnet list, which a CI checkout lacks and
        // which takes precedence over the inline list below; clear it.
        REVENUE_LOCK_BENEFICIARIES_FILE: "",
        // Direct entries plus the reserve exhaust the 2.4M lock.
        REVENUE_LOCK_BENEFICIARIES_JSON: JSON.stringify(
          [{ address: "0x0000000000000000000000000000000000000001", amount: "2040000", label: "test" }]),
        REVENUE_RESERVE_ALLOCATOR: DRY_RUN_ALLOCATOR,
        REVENUE_RESERVE_AMOUNT: "360000",
        CROWDFUND_OPEN_TIME: new Date(openTs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        INITIAL_STEWARD_ADDRESS: DRY_RUN_STEWARD,
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

    // WHY: the launch elects the steward and seeds its USDC budget at deploy (#221, #222). The
    // plan must show both before any step runs, so the operator can check them against the
    // freeze sheet.
    it("prints the initial steward and its USDC budget in the launch plan", function () {
      const result = dryRun({});
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.match(new RegExp(`Steward:\\s+${DRY_RUN_STEWARD}`));
      expect(result.stdout).to.include("$60000 USDC per 2592000s");
    });

    // WHY: without INITIAL_STEWARD_ADDRESS the deploy would silently skip the election and the
    // budget; the orchestrator must refuse before any step runs.
    it("refuses to start when INITIAL_STEWARD_ADDRESS is unset", function () {
      const result = dryRun({ INITIAL_STEWARD_ADDRESS: "" });
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include("INITIAL_STEWARD_ADDRESS");
      expect(result.stdout).to.not.include("CROWDFUND-LAUNCH DEPLOYMENT");
    });

    // WHY: the reserve allocator and cap are immutable distributor constructor inputs (#582). The
    // plan must show both before any step runs, so the operator can check them against the
    // freeze sheet.
    it("prints the reserve allocator and cap in the launch plan", function () {
      const result = dryRun({});
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.match(new RegExp(`Reserve:\\s+${DRY_RUN_ALLOCATOR} — 360000 ARM cap`));
    });

    // WHY: Launch 1 ships the reserve distributor; without REVENUE_RESERVE_* the deploy would
    // fund a lock with no reserve, so the orchestrator must refuse before any step runs.
    it("refuses to start when the reserve is unset", function () {
      const result = dryRun({ REVENUE_RESERVE_ALLOCATOR: "", REVENUE_RESERVE_AMOUNT: "" });
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include("REVENUE_RESERVE_ALLOCATOR and REVENUE_RESERVE_AMOUNT are required");
      expect(result.stdout).to.not.include("CROWDFUND-LAUNCH DEPLOYMENT");
    });

    // WHY: a Ledger deploy has no private key. The plan must say transactions are signed on the
    // device, and the device pre-flight must run before the first transaction.
    // WHY: the launch's verification must run in the Launch 1 scope, so Launch 2 manifests
    // (absent on mainnet, stale on Sepolia) neither warn nor fail; the printed command is the
    // one an operator re-runs by hand.
    it("verifies in the Launch 1 scope", function () {
      const result = dryRun({});
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.include("> VERIFY_SCOPE=launch1 npx hardhat run scripts/verify_deployment.ts");
    });

    it("plans a Ledger deploy with the device pre-flight first", function () {
      const ledger = "0x00000000000000000000000000000000000000Ab";
      const result = dryRun({ DEPLOYER_PRIVATE_KEY: "", DEPLOYER_LEDGER_ADDRESS: ledger });
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.match(new RegExp(`Signer:\\s+Ledger ${ledger}`));
      const preflight = result.stdout.indexOf("Ledger pre-flight");
      expect(preflight).to.be.greaterThan(-1);
      expect(preflight).to.be.lessThan(result.stdout.indexOf("1/3 Recording real CCTP addresses"));
    });

    // WHY: a key left in secrets.env next to a Ledger address would sign instead of the device.
    it("refuses to start with both a key and a Ledger address", function () {
      const result = dryRun({ DEPLOYER_LEDGER_ADDRESS: "0x00000000000000000000000000000000000000Ab" });
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include("not both");
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

    /** ISO 8601 UTC open time `minutes` from now, in the canonical form the orchestrator accepts. */
    function openIn(minutes: number): string {
      const ts = Math.floor(Date.now() / 1000) + minutes * 60;
      return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    }

    // WHY: an announced open time a little over an hour out must be deployable with the 1h
    // override, and the plan must show the shortened lead so the operator sees it is in force.
    it("starts with an open time just past a 1h lead override and flags the override", function () {
      const result = dryRun({ CROWDFUND_OPEN_MIN_LEAD_SECONDS: "3600", CROWDFUND_OPEN_TIME: openIn(65) });
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.match(/Open lead:\s+3600s \(OVERRIDE — default 21600s\)/);
    });

    // WHY: the override shortens the lead, it does not remove it; an open time inside the
    // overridden lead must still stop the run before any transaction.
    it("refuses an open time inside the overridden lead", function () {
      const result = dryRun({ CROWDFUND_OPEN_MIN_LEAD_SECONDS: "3600", CROWDFUND_OPEN_TIME: openIn(55) });
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include("must be at least 3600s after now");
      expect(result.stdout).to.not.include("CROWDFUND-LAUNCH DEPLOYMENT");
    });

    // WHY: the 1h floor is the hard limit; an override below it must stop the run, not clamp.
    it("refuses an override below the 1h floor", function () {
      const result = dryRun({ CROWDFUND_OPEN_MIN_LEAD_SECONDS: "1800", CROWDFUND_OPEN_TIME: openIn(65) });
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include("CROWDFUND_OPEN_MIN_LEAD_SECONDS must be at least 3600");
      expect(result.stdout).to.not.include("CROWDFUND-LAUNCH DEPLOYMENT");
    });

    // WHY: with the override cleared, the 6h default applies again.
    it("refuses an open time 3h out when no override is set", function () {
      const result = dryRun({ CROWDFUND_OPEN_MIN_LEAD_SECONDS: "", CROWDFUND_OPEN_TIME: openIn(180) });
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include("must be at least 21600s after now");
      expect(result.stdout).to.not.include("CROWDFUND-LAUNCH DEPLOYMENT");
    });
  });
  describe("assertLaunchRoleMultisigs", function () {
    async function safes() {
      const [, a, b, c, eoa] = await hre.ethers.getSigners();
      const Mock = await hre.ethers.getContractFactory("ReserveAllocatorIntrospectionMock");
      const threeOwners = async (threshold: number) =>
        (await Mock.deploy([a.address, b.address, c.address], threshold)).getAddress();
      const twoOwners = await (await Mock.deploy([a.address, b.address], 1)).getAddress();
      return {
        sc: await threeOwners(2), launchTeam: await threeOwners(1), twoOfThree: await threeOwners(2),
        oneOfThree: await threeOwners(1), threeOfThree: await threeOwners(3), twoOwners, eoa: eoa.address,
      };
    }

    // WHY: control case — a 2-of-3 security council and a 1-of-3 launch team (all three launch
    // team signers on hardware wallets) are the intended mainnet roles.
    it("accepts a 2-of-3 security council and a 1-of-3 launch team", async function () {
      const { sc, launchTeam } = await safes();
      await assertLaunchRoleMultisigs(sc, launchTeam);
    });

    // WHY: 2-of-3 is strictly safer than the 1-of-3 launch team the deploy allows, so the Sepolia
    // rehearsal Safes and a team that keeps the stricter threshold must still pass.
    it("accepts a 2-of-3 launch team", async function () {
      const { sc, twoOfThree } = await safes();
      await assertLaunchRoleMultisigs(sc, twoOfThree);
    });

    // WHY: the cancel veto stays behind two signatures; relaxing the launch team must not relax it.
    it("rejects a 1-of-3 security council", async function () {
      const { launchTeam, oneOfThree } = await safes();
      await expect(assertLaunchRoleMultisigs(oneOfThree, launchTeam))
        .to.be.rejectedWith("Security council must report exactly three distinct owners and threshold two");
    });

    // WHY: both addresses are baked into the immutable crowdfund. A single key as security council
    // holds the cancel veto alone; as launch team it holds every seed and launch-team invite.
    it("rejects an EOA security council", async function () {
      const { launchTeam, eoa } = await safes();
      await expect(assertLaunchRoleMultisigs(eoa, launchTeam))
        .to.be.rejectedWith("Security council must be a deployed multisig");
    });

    // WHY: a single key as launch team holds every seed and launch-team invite, and a Safe left
    // with fewer owners while being set up must not slip through: the address alone looks right,
    // only the owner/threshold reads tell them apart. 3-of-3 loses the role if one signer is lost.
    it("rejects an EOA launch team and a launch team Safe that is not 1-of-3 or 2-of-3", async function () {
      const { sc, eoa, twoOwners, threeOfThree } = await safes();
      await expect(assertLaunchRoleMultisigs(sc, eoa)).to.be.rejectedWith("Launch team must be a deployed multisig");
      for (const launchTeam of [twoOwners, threeOfThree]) {
        await expect(assertLaunchRoleMultisigs(sc, launchTeam))
          .to.be.rejectedWith("Launch team must report exactly three distinct owners and threshold one or two");
      }
    });

    // WHY: the council's cancel is the check on launch-team placements; one Safe holding both
    // roles would check itself. A 2-of-3 Safe passes both threshold checks, so only an address
    // comparison (case-insensitive, as env values may differ in case) catches the reuse.
    it("rejects a security council that is also the launch team", async function () {
      const { sc } = await safes();
      await expect(assertLaunchRoleMultisigs(sc, sc.toLowerCase()))
        .to.be.rejectedWith("Launch team must differ from the security council");
    });

    // WHY: an unset address must name the env var, not fail later with an RPC error.
    it("names the missing env var when an address is unset", async function () {
      const { sc, launchTeam } = await safes();
      await expect(assertLaunchRoleMultisigs("", launchTeam)).to.be.rejectedWith("SECURITY_COUNCIL_ADDRESS");
      await expect(assertLaunchRoleMultisigs(sc, "")).to.be.rejectedWith("LAUNCH_TEAM_ADDRESS");
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
