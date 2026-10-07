// ABOUTME: Tests for the Launch Team's UpgradeGate approval tooling: Transaction Builder file format, refusals,
// ABOUTME: automated review findings, and approve/revoke files executed through a real 2-of-3 Safe.
import { expect } from "chai";
import { ethers } from "ethers";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import { txBuilderChecksum, type TxBuilderFile } from "../scripts/safe-batch";
import { GATE_METHODS, gateBatchFile, type GateProposal } from "../scripts/upgrade-gate-batch";
import { builderCalldata, deploySafeInfra, executeFile } from "./helpers/safe-tx-builder";
import { deployGovernorProxy } from "./helpers/deploy-governor";

const ONE_DAY = 86400;
const Vote = { For: 1 };

describe("Launch Team UpgradeGate approval batches", function () {
  describe("gateBatchFile", function () {
    const proposal: GateProposal = {
      chainId: 1, governor: "0x0000000000000000000000000000000000006070",
      gate: "0x0000000000000000000000000000000000007A7E", launchTeam: "0x0000000000000000000000000000000000001A7E",
      proposalId: 42n, state: 4, approved: false,
      targets: ["0x0000000000000000000000000000000000006070", "0x00000000000000000000000000000000000070CE"],
      values: [0n, 0n],
      calldatas: [
        new ethers.Interface(["function upgradeTo(address)"]).encodeFunctionData("upgradeTo",
          ["0x0000000000000000000000000000000000000111"]),
        "0x",
      ],
      gated: [true, false], findings: [],
    };

    // WHY: the Safe app encodes calls from the declared method and input values. If the declared
    // method drifts from the gate's ABI, the Safe would send different calldata than intended.
    it("declares approve/revoke methods that match the UpgradeGate ABI", async function () {
      const gate = (await hre.ethers.getContractFactory("UpgradeGate")).interface;
      for (const name of ["approve", "revoke"] as const) {
        const fragment = gate.getFunction(name)!;
        expect(GATE_METHODS[name].inputs.map((i) => i.type)).to.deep.equal(fragment.inputs.map((i) => i.type));
      }
    });

    // WHY: the file must encode, through the builder's own parsing, to exactly the gate call over
    // this proposal's id and actions — including empty calldata entries.
    it("encodes, through the builder's parsing, to approve/revoke over the exact proposal", async function () {
      const gate = (await hre.ethers.getContractFactory("UpgradeGate")).interface;
      for (const kind of ["approve", "revoke"] as const) {
        const file = gateBatchFile(kind, proposal, 1);
        expect(file.transactions).to.have.length(1);
        expect(file.transactions[0].to).to.equal(proposal.gate);
        expect(builderCalldata(file.transactions[0])).to.equal(gate.encodeFunctionData(kind,
          [proposal.proposalId, proposal.targets, proposal.values, proposal.calldatas]));
      }
    });

    // WHY: the Transaction Builder warns about modified files when the checksum does not match.
    it("carries the chain, the Launch Team Safe and a valid checksum", function () {
      const file = gateBatchFile("approve", proposal, 1);
      expect(file.chainId).to.equal("1");
      expect(file.meta.createdFromSafeAddress).to.equal(proposal.launchTeam);
      // On import the builder deletes meta.checksum and recomputes it over the rest.
      const { checksum, ...meta } = file.meta;
      expect(checksum).to.equal(txBuilderChecksum({ ...file, meta }));
    });
  });

  describe("with a real Safe (gate-safe-approve task)", function () {
    let tmp: string;
    let logged: string[];
    let log: typeof console.log;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-batch-"));
      logged = []; log = console.log; console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
    });
    afterEach(() => { console.log = log; fs.rmSync(tmp, { recursive: true, force: true }); });

    async function fixture() {
      const [deployer, alice, o1, o2, o3, outsider] = await hre.ethers.getSigners();
      const { multiSend, createSafe } = await deploySafeInfra(deployer, [o1, o2, o3]);
      const teamSafe = await createSafe();

      const timelock = await (await hre.ethers.getContractFactory("TimelockController"))
        .deploy(2 * ONE_DAY, [], [], deployer.address);
      const timelockAddr = await timelock.getAddress();
      const armToken = await (await hre.ethers.getContractFactory("ArmadaToken")).deploy(deployer.address, timelockAddr);
      const treasury = await (await hre.ethers.getContractFactory("ArmadaTreasuryGov")).deploy(timelockAddr);
      const gate = await (await hre.ethers.getContractFactory("UpgradeGate")).deploy(await teamSafe.getAddress());
      const governor: any = await deployGovernorProxy(
        await armToken.getAddress(), timelockAddr, await treasury.getAddress(), await gate.getAddress(),
      );
      const governorAddr = await governor.getAddress();
      await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddr);
      await timelock.grantRole(await timelock.EXECUTOR_ROLE(), governorAddr);
      const admin = await timelock.TIMELOCK_ADMIN_ROLE();
      await timelock.revokeRole(admin, timelockAddr);
      await timelock.renounceRole(admin, deployer.address);

      await armToken.initWhitelist([deployer.address, alice.address]);
      await armToken.transfer(alice.address, ethers.parseUnits("4800000", 18));
      await armToken.connect(alice).delegate(alice.address);
      await mine(1);

      // Pass and queue a proposal through to its execution time; returns its id.
      const passProposal = async (targets: string[], calldatas: string[]) => {
        await governor.connect(alice).propose(1, targets, targets.map(() => 0n), calldatas, "upgrade");
        const id = await governor.proposalCount();
        await time.increase(2 * ONE_DAY + 1);
        await governor.connect(alice).castVote(id, Vote.For);
        await time.increase(14 * ONE_DAY + 1);
        await governor.queue(id);
        await time.increase(7 * ONE_DAY + 1);
        return id;
      };
      const newImpl = async (gateAddress: string) => {
        const impl = await (await hre.ethers.getContractFactory("ArmadaGovernor")).deploy(gateAddress);
        return impl.getAddress();
      };
      const upgradeTo = (impl: string) => governor.interface.encodeFunctionData("upgradeTo", [impl]);
      return { governor, governorAddr, gate, armToken, teamSafe, multiSend, owners: [o1, o2], outsider,
        passProposal, newImpl, upgradeTo };
    }

    const readJson = (dir: string, name: string) =>
      JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as TxBuilderFile;

    // WHY: end to end — the task's approve file, executed through the 2-of-3 Launch Team Safe
    // exactly as the Safe app would, must let the gated proposal execute; the revoke file must
    // block it again. This is the whole operational path for a governor upgrade.
    it("writes approve and revoke files that the Launch Team Safe executes", async function () {
      const f = await fixture();
      const id = await f.passProposal([f.governorAddr], [f.upgradeTo(await f.newImpl(await f.gate.getAddress()))]);

      const approveDir: string = await hre.run("gate-safe-approve",
        { proposal: String(id), governor: f.governorAddr, out: tmp, revoke: false });
      const approveFile = readJson(approveDir, "approve.json");
      expect(approveFile.meta.createdFromSafeAddress).to.equal(await f.teamSafe.getAddress());
      const summary = fs.readFileSync(path.join(approveDir, "summary.md"), "utf8");
      expect(summary).to.include(`Proposal ${id}`).and.include("upgradeTo(").and.include("GATED");
      await executeFile(f.teamSafe, f.multiSend, f.owners, approveFile);

      const revokeDir: string = await hre.run("gate-safe-approve",
        { proposal: String(id), governor: f.governorAddr, out: tmp, revoke: true });
      await executeFile(f.teamSafe, f.multiSend, f.owners, readJson(revokeDir, "revoke.json"));
      await expect(f.governor.execute(id)).to.be.revertedWithCustomError(f.gate, "Gate_NotApproved");

      const reapproveDir: string = await hre.run("gate-safe-approve",
        { proposal: String(id), governor: f.governorAddr, out: tmp, revoke: false });
      await executeFile(f.teamSafe, f.multiSend, f.owners, readJson(reapproveDir, "approve.json"));
      await f.governor.execute(id);
      expect(await f.governor.state(id)).to.equal(5n);
    });

    // WHY: a file the gate does not need, or one that changes nothing, should never reach the
    // Safe queue — refuse without writing anything.
    it("refuses proposals with no gated action, repeat approvals, and executed proposals", async function () {
      const f = await fixture();
      const plain = await f.passProposal([f.governorAddr], [f.governor.interface.encodeFunctionData("proposalCount")]);
      await expect(hre.run("gate-safe-approve", { proposal: String(plain), governor: f.governorAddr, out: tmp, revoke: false }))
        .to.be.rejectedWith(/no gated action/);

      const gated = await f.passProposal([f.governorAddr], [f.upgradeTo(await f.newImpl(await f.gate.getAddress()))]);
      await expect(hre.run("gate-safe-approve", { proposal: String(gated), governor: f.governorAddr, out: tmp, revoke: true }))
        .to.be.rejectedWith(/not approved/);
      const dir: string = await hre.run("gate-safe-approve",
        { proposal: String(gated), governor: f.governorAddr, out: tmp, revoke: false });
      await executeFile(f.teamSafe, f.multiSend, f.owners, readJson(dir, "approve.json"));
      const before = fs.readdirSync(tmp);
      await expect(hre.run("gate-safe-approve", { proposal: String(gated), governor: f.governorAddr, out: tmp, revoke: false }))
        .to.be.rejectedWith(/already approved/);
      await f.governor.execute(gated);
      await expect(hre.run("gate-safe-approve", { proposal: String(gated), governor: f.governorAddr, out: tmp, revoke: false }))
        .to.be.rejectedWith(/Executed/);
      expect(fs.readdirSync(tmp)).to.deep.equal(before);
    });

    // WHY: two mistakes the signers must not miss are flagged automatically: a new governor
    // implementation that trusts a different gate (it would drop or replace the co-sign), and an
    // authorized delegator that is not a contract (it cannot be canonical RevenueLock code).
    it("flags a new governor implementation with a different gate and a non-contract delegator", async function () {
      const f = await fixture();
      const otherGate = await (await hre.ethers.getContractFactory("UpgradeGate")).deploy(f.outsider.address);
      const id = await f.passProposal(
        [f.governorAddr, await f.armToken.getAddress()],
        [f.upgradeTo(await f.newImpl(await otherGate.getAddress())),
          f.armToken.interface.encodeFunctionData("addAuthorizedDelegator", [f.outsider.address])],
      );
      const dir: string = await hre.run("gate-safe-approve",
        { proposal: String(id), governor: f.governorAddr, out: tmp, revoke: false });
      const summary = fs.readFileSync(path.join(dir, "summary.md"), "utf8");
      expect(summary).to.include("trusts a different upgrade gate");
      expect(summary).to.include("is not a contract");
      expect(logged.join("\n")).to.include("WARNING");
    });
  });
});
