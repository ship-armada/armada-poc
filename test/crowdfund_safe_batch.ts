// ABOUTME: Safe Transaction Builder batches for launch-team seeds/invites and the security-council
// ABOUTME: cancel: CSV parsing, contract-state validation, batching, file format, and execution via a real Safe.
import { expect } from "chai";
import { ethers } from "ethers";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  parseLaunchCsv,
  validateLaunchRows,
  planLaunchBatches,
  launchBatchFile,
  renderLaunchSummary,
  txBuilderChecksum,
  LAUNCH_TEAM_METHODS,
  CANCEL_METHOD,
  type LaunchRow,
  type LaunchState,
  type TxBuilderFile,
} from "../scripts/safe-batch";

const A = "0x00000000000000000000000000000000000000A1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000C3";
const LAUNCH_TEAM = "0x0000000000000000000000000000000000001A7E";
const CROWDFUND = "0x000000000000000000000000000000000000CF01";

/** Contract state for validation cases: open sale, empty budgets, nobody whitelisted yet. */
function openState(overrides: Partial<LaunchState> = {}): LaunchState {
  return {
    chainId: 1, crowdfund: CROWDFUND, launchTeam: LAUNCH_TEAM, now: 2_000,
    phase: 0, armLoaded: true, windowStart: 1_000, launchTeamInviteEnd: 3_000,
    maxSeeds: 180, seedCount: 0, hop1Budget: 100, hop1Used: 0, hop2Budget: 120, hop2Used: 0,
    maxInvitesReceived: [1, 10, 20], slots: {},
    ...overrides,
  };
}
const row = (line: number, address: string, hop: 0 | 1 | 2, label = ""): LaunchRow => ({ line, address, hop, label });

/**
 * Mirrors how the Safe Transaction Builder turns an imported file into calldata
 * (safe-react-apps apps/tx-builder/src/utils.ts: parseInputValue / parseStringToArray, and
 * convertToProposedTransactions). A file the builder cannot encode silently becomes "0x", so the
 * values we write must survive exactly this parsing.
 */
function builderCalldata(tx: TxBuilderFile["transactions"][number]): string {
  if (tx.data) return tx.data;
  const method = tx.contractMethod!;
  const values = method.inputs.map((input) => {
    const raw = (tx.contractInputsValues ?? {})[input.name].trim();
    if (input.type.endsWith("[]")) {
      return raw.slice(1, -1).split(",").map((v) => v.trim().replace(/"/g, "").replace(/'/g, ""));
    }
    return raw;
  });
  const fragment = `function ${method.name}(${method.inputs.map((i) => i.type).join(",")})`;
  return new ethers.Interface([fragment]).encodeFunctionData(method.name, values);
}

describe("Safe batches for launch-team and security-council actions", function () {
  describe("parseLaunchCsv", function () {
    // WHY: one file carries seeds (hop 0) and launch-team invites (target hop 1 or 2); labels are
    // free text for the operator and may contain commas.
    it("parses seeds and invites, normalising addresses and keeping labels", function () {
      const rows = parseLaunchCsv(`Address, Hop, Label\n${A.toLowerCase()},0,Alice\n\n${B},1,Bob, Jr.\n${C},2,\n`);
      expect(rows).to.deep.equal([
        row(2, ethers.getAddress(A), 0, "Alice"),
        row(4, ethers.getAddress(B), 1, "Bob, Jr."),
        row(5, ethers.getAddress(C), 2, ""),
      ]);
    });

    // WHY: a typo'd address or hop must stop the run with every bad line named, not skip rows.
    it("reports every malformed line with its line number", function () {
      const badChecksum = A.slice(0, -1) + "a"; // mixed case with a wrong checksum
      const csv = `address,hop,label\nnot-an-address,0,x\n${badChecksum},1,y\n${B},3,z\n${C}\n`;
      expect(() => parseLaunchCsv(csv)).to.throw(/line 2[\s\S]*line 3[\s\S]*line 4[\s\S]*line 5/);
    });

    // WHY: the header pins the column order; without it a swapped column would be misread.
    it("requires the address,hop,label header and at least one row", function () {
      expect(() => parseLaunchCsv(`${A},0,x\n`)).to.throw(/header/);
      expect(() => parseLaunchCsv("address,hop,label\n")).to.throw(/no rows/);
    });
  });

  describe("txBuilderChecksum", function () {
    // The builder's own published vectors (see the fixture's _source), kept in a fixture file
    // because their 32-byte hex values trip the pre-commit secret scan.
    const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tx-builder-checksum-vectors.json"), "utf8"));

    // WHY: the builder warns that a file "was modified" unless the checksum matches its own
    // algorithm; a serializer drift from the builder's checksum.test.js vector is caught here.
    it("matches the Transaction Builder's checksum test vector", function () {
      expect(txBuilderChecksum(vectors.builderTest.file)).to.equal(vectors.builderTest.expectedChecksum);
    });

    // WHY: on import the builder deletes meta.checksum and recomputes; a file exported by the
    // builder itself must validate the same way here.
    it("validates a file exported by the Transaction Builder", function () {
      expect(txBuilderChecksum(vectors.exportedFile.file)).to.equal(vectors.exportedFile.expectedChecksum);
    });
  });

  describe("launch batch file format", function () {
    const rows = [row(2, A, 0), row(3, B, 0), row(4, C, 1), row(5, A, 2)];
    const [seeds, invites] = planLaunchBatches(rows, { maxSeeds: 100, maxInvites: 60 });

    // WHY: the method shapes in the file must match the deployed contract, or the builder would
    // encode a call to a function that does not exist.
    it("declares methods that match the ArmadaCrowdfund ABI", async function () {
      const artifact = await hre.artifacts.readArtifact("ArmadaCrowdfund");
      for (const method of [...Object.values(LAUNCH_TEAM_METHODS), CANCEL_METHOD]) {
        const abi = artifact.abi.find((f: any) => f.type === "function" && f.name === method.name);
        expect(abi, method.name).to.not.equal(undefined);
        expect(method.inputs.map((i) => [i.name, i.type])).to.deep.equal(abi.inputs.map((i: any) => [i.name, i.type]));
      }
    });

    // WHY: what the builder encodes from the file must be exactly the intended calls: target
    // hop 1 → fromHop 0, target hop 2 → fromHop 1, seeds in one addSeeds call.
    it("encodes, through the builder's own parsing, to the intended calls", function () {
      const cf = new ethers.Interface(["function addSeeds(address[])", "function launchTeamInvite(address,uint8)"]);
      const seedFile = launchBatchFile(seeds, 1, 2, openState(), 1_700_000_000_000);
      const inviteFile = launchBatchFile(invites, 2, 2, openState(), 1_700_000_000_000);
      expect(seedFile.transactions.map(builderCalldata)).to.deep.equal([cf.encodeFunctionData("addSeeds", [[A, B]])]);
      expect(inviteFile.transactions.map(builderCalldata)).to.deep.equal([
        cf.encodeFunctionData("launchTeamInvite", [C, 0]),
        cf.encodeFunctionData("launchTeamInvite", [A, 1]),
      ]);
      for (const tx of [...seedFile.transactions, ...inviteFile.transactions]) {
        expect(tx.to).to.equal(CROWDFUND);
        expect(tx.value).to.equal("0");
        expect(Object.values(tx.contractInputsValues ?? {}).every((v) => typeof v === "string")).to.equal(true);
      }
    });

    // WHY: the builder filters batches by chain and checks the checksum on import.
    it("carries the chain, the launch-team Safe and a valid checksum", function () {
      const file = launchBatchFile(seeds, 1, 2, openState(), 1_700_000_000_000);
      expect(file.chainId).to.equal("1");
      expect(file.meta.createdFromSafeAddress).to.equal(LAUNCH_TEAM);
      const { checksum, ...meta } = file.meta;
      expect(checksum).to.equal(txBuilderChecksum({ ...file, meta }));
    });
  });

  describe("planLaunchBatches", function () {
    // WHY: Ethereum caps a transaction at ~16.7M gas; all 220 launch-team invites (~84k each)
    // cannot fit in one. Batches hold one kind only (seeds first), keep file order, and respect
    // the per-batch limits.
    it("puts seeds first, then invites, one kind per batch, in file order", function () {
      const seeds = Array.from({ length: 150 }, (_, i) => row(i + 2, ethers.zeroPadValue(ethers.toBeHex(i + 1), 20), 0));
      const invites = Array.from({ length: 130 }, (_, i) => row(i + 200, ethers.zeroPadValue(ethers.toBeHex(i + 1000), 20), i % 2 ? 2 : 1));
      const batches = planLaunchBatches([...invites.slice(0, 5), ...seeds, ...invites.slice(5)], { maxSeeds: 100, maxInvites: 60 });
      expect(batches.map((b) => [b.kind, b.rows.length])).to.deep.equal(
        [["seeds", 100], ["seeds", 50], ["invites", 60], ["invites", 60], ["invites", 10]]);
      expect(batches[2].rows.map((r) => r.line)).to.deep.equal(invites.slice(0, 60).map((r) => r.line));
    });
  });

  describe("renderLaunchSummary", function () {
    // WHY: the second signer compares the Safe app's decoded calls with this file. The Safe shows
    // the contract's fromHop (target hop − 1), so the summary must show that value too, mark
    // stacked rows, and keep labels from breaking the table.
    it("lists each call with the fromHop the Safe app shows, stacked rows and escaped labels", function () {
      const rows = [row(2, A, 0, "seed"), row(3, B, 1, "Bob | Co"), row(4, B, 1, "again"), row(5, C, 2, "Carol")];
      const state = openState();
      const validation = validateLaunchRows(rows, state, { allowStack: true });
      const summary = renderLaunchSummary({ state, csvName: "launch.csv", csvSha256: "ab", batches: planLaunchBatches(rows, { maxSeeds: 100, maxInvites: 60 }), validation });
      expect(summary).to.include(`| 1 | 2 | ${A} | 0 | — | seed |  |`);
      expect(summary).to.include(`| 1 | 3 | ${B} | 1 | 0 | Bob \\| Co |  |`);
      expect(summary).to.include(`| 2 | 4 | ${B} | 1 | 0 | again | stacked |`);
      expect(summary).to.include(`| 3 | 5 | ${C} | 2 | 1 | Carol |  |`);
      expect(summary).to.include("| Launch-team hop-1 invites | 0 | 2 | 2 | 100 |");
    });
  });

  describe("validateLaunchRows", function () {
    // WHY: control case — fresh seeds and invites inside the open window and budgets pass clean.
    it("accepts seeds and invites within budget during the window", function () {
      const v = validateLaunchRows([row(2, A, 0), row(3, B, 1), row(4, C, 2)], openState(), { allowStack: false });
      expect(v).to.deep.equal({ errors: [], warnings: [], stacked: [] });
    });

    // WHY: a seed can be added once (max one invite received at hop 0); a repeat or an existing
    // seed would revert the whole batch on chain.
    it("rejects a repeated seed and an address that is already a seed", function () {
      const state = openState({ slots: { [B.toLowerCase()]: [{ isWhitelisted: true, invitesReceived: 1 }] } });
      const v = validateLaunchRows([row(2, A, 0), row(3, A, 0), row(4, B, 0)], state, { allowStack: true });
      expect(v.errors.join("\n")).to.match(/line 3.*repeats line 2/).and.match(/line 4.*already a seed/);
    });

    // WHY: the seed cap and the launch-team budgets are hard limits; exceeding them reverts.
    it("rejects seeds or invites beyond the remaining capacity", function () {
      const state = openState({ seedCount: 179, hop1Used: 100, hop2Used: 119 });
      const v = validateLaunchRows([row(2, A, 0), row(3, B, 0), row(4, C, 1), row(5, A, 2), row(6, B, 2)], state, { allowStack: true });
      expect(v.errors.join("\n")).to.match(/2 seeds, 1 left/).and.match(/1 hop-1 invite.*0 left/).and.match(/2 hop-2 invites.*1 left/);
    });

    // WHY: inviting an already-invited address raises their cap and invite budget instead of
    // failing. That must be a deliberate choice (--allow-stack), never an accident.
    it("rejects stacked invites unless allowed, then flags them", function () {
      const state = openState({ slots: { [C.toLowerCase()]: [undefined as any, { isWhitelisted: true, invitesReceived: 2 }] } });
      const rows = [row(2, A, 1), row(3, A, 1), row(4, C, 1)];
      const refused = validateLaunchRows(rows, state, { allowStack: false });
      expect(refused.errors.join("\n")).to.match(/line 3.*--allow-stack/).and.match(/line 4.*--allow-stack/);
      const allowed = validateLaunchRows(rows, state, { allowStack: true });
      expect(allowed.errors).to.deep.equal([]);
      expect(allowed.stacked.map((r) => r.line)).to.deep.equal([3, 4]);
      expect(allowed.warnings.join("\n")).to.match(/stack/);
    });

    // WHY: each hop caps how many invites one address can receive (10 at hop 1).
    it("rejects stacking past the per-hop invites-received cap", function () {
      const state = openState({ slots: { [A.toLowerCase()]: [undefined as any, { isWhitelisted: true, invitesReceived: 9 }] } });
      const v = validateLaunchRows([row(2, A, 1), row(3, A, 1)], state, { allowStack: true });
      expect(v.errors.join("\n")).to.match(/receive at most 10/);
    });

    // WHY: the contract refuses the launch team as a seed or invitee.
    it("rejects the launch-team address as a row", function () {
      const v = validateLaunchRows([row(2, LAUNCH_TEAM, 0)], openState(), { allowStack: false });
      expect(v.errors.join("\n")).to.match(/line 2.*launch team/);
    });

    // WHY: batches can be prepared and signed before the sale opens but only execute after it;
    // after the launch-team window closes, or if the sale is not active or ARM not loaded, every
    // call reverts.
    it("warns before the open time and refuses outside a usable sale", function () {
      expect(validateLaunchRows([row(2, A, 0)], openState({ now: 500 }), { allowStack: false }).warnings.join())
        .to.match(/opens at/);
      for (const [state, message] of [
        [openState({ now: 3_000 }), /window closed/],
        [openState({ phase: 2 }), /not active/],
        [openState({ armLoaded: false }), /ARM is not loaded/],
      ] as const) {
        expect(validateLaunchRows([row(2, A, 0)], state, { allowStack: false }).errors.join()).to.match(message);
      }
    });
  });

  describe("with a real Safe (cf-safe-batch / cf-safe-cancel tasks)", function () {
    // Safe v1.4.1, the version the Safe web app deploys on mainnet, from @safe-global/safe-contracts.
    const safeArtifact = (p: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "node_modules",
      "@safe-global", "safe-contracts", "build", "artifacts", "contracts", p), "utf8"));
    const SAFE = safeArtifact("Safe.sol/Safe.json");
    const FACTORY = safeArtifact("proxies/SafeProxyFactory.sol/SafeProxyFactory.json");
    const MULTISEND = safeArtifact("libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json");
    const ARM = (n: number) => ethers.parseUnits(String(n), 18);

    let tmp: string;
    let logged: string[];
    let log: typeof console.log;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-batch-"));
      // The tasks print their summary; capture it so the cases can assert on it.
      logged = []; log = console.log; console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
    });
    afterEach(() => { console.log = log; fs.rmSync(tmp, { recursive: true, force: true }); });

    async function fixture() {
      const signers = await hre.ethers.getSigners();
      const [deployer, treasury, o1, o2, o3, s1, s2, s3, x, y, z] = signers;
      const deploy = async (a: any, ...args: unknown[]) => {
        const c = await new hre.ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
        await c.waitForDeployment();
        return c as any;
      };
      const singleton = await deploy(SAFE);
      const factory = await deploy(FACTORY);
      const multiSend = await deploy(MULTISEND);
      let salt = 0;
      const createSafe = async (threshold: number) => {
        const setup = singleton.interface.encodeFunctionData("setup", [[o1.address, o2.address, o3.address], threshold,
          ethers.ZeroAddress, "0x", ethers.ZeroAddress, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
        const receipt = await (await factory.createProxyWithNonce(await singleton.getAddress(), setup, salt++)).wait();
        const created = receipt.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } })
          .find((e: any) => e?.name === "ProxyCreation");
        return new hre.ethers.Contract(created.args.proxy, SAFE.abi, deployer) as any;
      };
      // Mainnet roles: a 1-of-3 launch team and a 2-of-3 security council.
      const launchSafe = await createSafe(1);
      const councilSafe = await createSafe(2);

      const usdc = await (await hre.ethers.getContractFactory("MockUSDCV2")).deploy("Mock USDC", "USDC");
      const arm = await (await hre.ethers.getContractFactory("ArmadaToken")).deploy(deployer.address, deployer.address);
      await arm.initWhitelist([deployer.address]);
      const crowdfund = await (await hre.ethers.getContractFactory("ArmadaCrowdfund")).deploy(
        await usdc.getAddress(), await arm.getAddress(), treasury.address,
        await launchSafe.getAddress(), await councilSafe.getAddress(), (await time.latest()) + 3600);
      const cfAddress = await crowdfund.getAddress();
      await arm.addToWhitelist(cfAddress);
      await arm.initAuthorizedDelegators([cfAddress]);
      await arm.transfer(cfAddress, ARM(1_800_000));
      await crowdfund.loadArm();
      return { crowdfund, cfAddress, launchSafe, councilSafe, multiSend, launchOwners: [o1], councilOwners: [o1, o2],
        seeds: [s1, s2, s3], x, y, z };
    }

    /**
     * Execute one Transaction Builder file as the Safe app would: calldata encoded from the
     * file's method + values, several calls bundled through MultiSendCallOnly (delegatecall),
     * and the given owners' EIP-712 signatures over the SafeTx (as many as the Safe's threshold).
     */
    async function executeFile(safe: any, multiSend: any, owners: any[], file: TxBuilderFile) {
      const calls = file.transactions.map((tx) => ({ to: tx.to, value: BigInt(tx.value), data: builderCalldata(tx) }));
      const single = calls.length === 1;
      const to = single ? calls[0].to : await multiSend.getAddress();
      const data = single ? calls[0].data : multiSend.interface.encodeFunctionData("multiSend", [ethers.concat(calls.map((c) =>
        ethers.solidityPacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, c.value, ethers.dataLength(c.data), c.data])))]);
      const operation = single ? 0 : 1;
      const message = { to, value: 0n, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
        gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce: await safe.nonce() };
      const domain = { chainId: Number(file.chainId), verifyingContract: await safe.getAddress() };
      const types = { SafeTx: [
        { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" }] };
      const sigs = await Promise.all(owners.map(async (o) => ({ owner: o.address.toLowerCase(), sig: await o.signTypedData(domain, types, message) })));
      sigs.sort((a, b) => (a.owner < b.owner ? -1 : 1));
      await (await safe.connect(owners[0]).execTransaction(to, 0, data, operation, 0, 0, 0,
        ethers.ZeroAddress, ethers.ZeroAddress, ethers.concat(sigs.map((s) => s.sig)))).wait();
    }

    const readFiles = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort((a, b) =>
      Number(a.match(/batch-(\d+)/)?.[1] ?? 0) - Number(b.match(/batch-(\d+)/)?.[1] ?? 0))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as TxBuilderFile);

    // WHY: end to end — the task's files, executed through the 1-of-3 launch-team Safe with one
    // owner's signature exactly as the Safe app bundles them, must add every seed and launch-team
    // invite (including a deliberate stack) and use the budgets as the summary says. Files are
    // prepared before the sale opens and executed after, which is the intended launch-day flow.
    it("prepares batches before open that a 1-of-3 Safe executes after open", async function () {
      const { crowdfund, cfAddress, launchSafe, multiSend, launchOwners, seeds, x, y, z } = await fixture();
      const csv = path.join(tmp, "launch.csv");
      fs.writeFileSync(csv, ["address,hop,label", ...seeds.map((s, i) => `${s.address},0,seed ${i}`),
        `${x.address},1,X`, `${y.address},1,Y`, `${z.address},2,Z`, `${x.address},1,X again`].join("\n"));

      const dir: string = await hre.run("cf-safe-batch", {
        file: csv, crowdfund: cfAddress, out: tmp, maxSeeds: 2, maxInvites: 2, allowStack: true, check: false,
      });
      const files = readFiles(dir);
      expect(files.map((f) => f.transactions.length)).to.deep.equal([1, 1, 2, 2]);
      const summary = fs.readFileSync(path.join(dir, "summary.md"), "utf8");
      expect(summary).to.include("The sale opens at").and.include("stacked").and.include("| Seeds | 0 | 3 | 3 | 180 |");
      expect(logged.join("\n")).to.include("summary.md");

      await time.increaseTo(await crowdfund.windowStart());
      for (const file of files) await executeFile(launchSafe, multiSend, launchOwners, file);

      expect((await crowdfund.hopStats(0)).whitelistCount).to.equal(3n);
      for (const s of seeds) expect((await crowdfund.participants(s.address, 0)).isWhitelisted).to.equal(true);
      expect((await crowdfund.participants(x.address, 1)).invitesReceived).to.equal(2n);
      expect((await crowdfund.participants(y.address, 1)).isWhitelisted).to.equal(true);
      expect((await crowdfund.participants(z.address, 2)).isWhitelisted).to.equal(true);
      expect(await crowdfund.launchTeamHop1Used()).to.equal(3n);
      expect(await crowdfund.launchTeamHop2Used()).to.equal(1n);
    });

    // WHY: re-running a CSV after its batches executed (or with an unintended stack) must refuse
    // without writing anything, so a duplicate batch can never reach the Safe queue.
    it("refuses and writes nothing when rows are already done or stack without --allow-stack", async function () {
      const { crowdfund, cfAddress, launchSafe, multiSend, launchOwners, seeds, x } = await fixture();
      await time.increaseTo(await crowdfund.windowStart());
      const csv = path.join(tmp, "launch.csv");
      fs.writeFileSync(csv, `address,hop,label\n${seeds[0].address},0,a\n${x.address},1,x\n`);
      const dir: string = await hre.run("cf-safe-batch", { file: csv, crowdfund: cfAddress, out: tmp, maxSeeds: 100, maxInvites: 60, allowStack: false, check: false });
      for (const file of readFiles(dir)) await executeFile(launchSafe, multiSend, launchOwners, file);

      const before = fs.readdirSync(tmp);
      await expect(hre.run("cf-safe-batch", { file: csv, crowdfund: cfAddress, out: tmp, maxSeeds: 100, maxInvites: 60, allowStack: false, check: false }))
        .to.be.rejectedWith(/already a seed[\s\S]*--allow-stack/);
      expect(fs.readdirSync(tmp)).to.deep.equal(before);
    });

    // WHY: --check validates against the chain without writing files, for a dry run of a CSV.
    it("writes nothing in --check mode", async function () {
      const { cfAddress, seeds } = await fixture();
      const csv = path.join(tmp, "launch.csv");
      fs.writeFileSync(csv, `address,hop,label\n${seeds[0].address},0,a\n`);
      expect(await hre.run("cf-safe-batch", { file: csv, crowdfund: cfAddress, out: tmp, maxSeeds: 100, maxInvites: 60, allowStack: false, check: true }))
        .to.equal(undefined);
      expect(fs.readdirSync(tmp)).to.deep.equal(["launch.csv"]);
      expect(logged.join("\n")).to.include("Check passed");
    });

    // WHY: the security council's emergency cancel must be ready to execute from its Safe
    // without building calldata under pressure. The file must cancel the sale.
    it("writes a cancel() file that the security-council Safe executes", async function () {
      const { crowdfund, cfAddress, councilSafe, multiSend, councilOwners } = await fixture();
      const dir: string = await hre.run("cf-safe-cancel", { crowdfund: cfAddress, out: tmp });
      const [file] = readFiles(dir);
      expect(file.meta.createdFromSafeAddress).to.equal(await councilSafe.getAddress());
      await executeFile(councilSafe, multiSend, councilOwners, file);
      expect(await crowdfund.phase()).to.equal(2n);
      await expect(hre.run("cf-safe-cancel", { crowdfund: cfAddress, out: tmp })).to.be.rejectedWith(/not active/);
    });
  });
});
