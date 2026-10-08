// ABOUTME: Guards for human-paced (Ledger) live deploys — the send guard's nonce/hash logging and
// ABOUTME: pre-broadcast retry, the Ledger signer wiring, the nonce handoff and the Ledger pre-flight.
import { expect } from "chai";
import { spawnSync } from "child_process";
import * as path from "path";
import hre from "hardhat";
import { ethers } from "ethers";
import type { RequestArguments } from "hardhat/types";
import {
  SendGuardProvider, LedgerOnlyAccountsProvider, GasHeadroomProvider, withGasHeadroom,
  TRANSACTION_GAS_LIMIT_CAP, LEDGER_PLUGIN_NAME, type SendGuardIO,
} from "../scripts/send-guard";
import {
  awaitExpectedNonce, crowdfundHandoffNonce, CROWDFUND_OPEN_MIN_LEAD_SECONDS, CROWDFUND_OPEN_MIN_LEAD_FLOOR_SECONDS,
} from "../scripts/deploy-utils";
import { assertLedgerSigner, assertSignedBy, ledgerPreflightMessage } from "../scripts/ledger-preflight";

/** Records every request and replays scripted results (a value, or an Error to throw). */
function scriptedProvider(results: Array<unknown>) {
  const calls: RequestArguments[] = [];
  return {
    calls,
    provider: {
      async request(args: RequestArguments): Promise<unknown> {
        calls.push(args);
        const next = results.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      on() { return this; }, once() { return this; }, off() { return this; },
      addListener() { return this; }, removeListener() { return this; }, removeAllListeners() { return this; },
      emit() { return false; }, listeners() { return []; }, listenerCount() { return 0; },
      prependListener() { return this; }, prependOnceListener() { return this; }, rawListeners() { return []; },
      eventNames() { return []; }, setMaxListeners() { return this; }, getMaxListeners() { return 10; },
    } as any,
  };
}

/** Collects log lines and answers retry prompts from a script. */
function scriptedIO(answers: boolean[]) {
  const lines: string[] = [];
  const questions: string[] = [];
  const io: SendGuardIO = {
    log: (m) => { lines.push(m); },
    confirmRetry: async (q) => { questions.push(q); return answers.shift() ?? false; },
  };
  return { io, lines, questions };
}

/** An error shaped like the ones @nomicfoundation/hardhat-ledger throws before broadcast. */
function ledgerError(message: string): Error {
  return Object.assign(new Error(message), { pluginName: LEDGER_PLUGIN_NAME });
}

const HASH = "0x" + "ab".repeat(32);
const LEDGER_TX = {
  from: "0x00000000000000000000000000000000000000ab", to: "0x00000000000000000000000000000000000000cd",
  gas: "0x5208", maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x1", nonce: "0x2a", value: "0x0",
};

describe("Human-paced deploy guards", function () {
  describe("SendGuardProvider", function () {
    // WHY: a stuck or dropped transaction can only be chased (runbook step 1) if its nonce and
    // hash were printed when it was sent, not after a receipt that may never come.
    it("logs the nonce and hash of a Ledger-signed send", async function () {
      const { provider } = scriptedProvider([HASH]);
      const { io, lines } = scriptedIO([]);
      const guard = new SendGuardProvider(provider, io);
      expect(await guard.request({ method: "eth_sendTransaction", params: [LEDGER_TX] })).to.equal(HASH);
      expect(lines.join("\n")).to.include("nonce 42").and.include(HASH);
    });

    // WHY: hot-key runs sign locally and reach the guard as raw transactions; they need the same
    // visibility, so the nonce is decoded from the signed payload.
    it("logs the nonce and hash of a locally signed raw send", async function () {
      const wallet = ethers.Wallet.createRandom();
      const raw = await wallet.signTransaction({
        chainId: 1, nonce: 7, to: LEDGER_TX.to, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 2,
      });
      const { provider } = scriptedProvider([HASH]);
      const { io, lines } = scriptedIO([]);
      await new SendGuardProvider(provider, io).request({ method: "eth_sendRawTransaction", params: [raw] });
      expect(lines.join("\n")).to.include("nonce 7").and.include(HASH);
    });

    // WHY: a rejected or missed device prompt fails before anything is broadcast. Retrying the
    // identical request re-signs the same nonce and fee fields, so no nonce is skipped and the
    // launch pauses instead of becoming an interrupted launch.
    it("retries a pre-broadcast Ledger failure with the identical request when the operator agrees", async function () {
      const { provider, calls } = scriptedProvider([ledgerError("denied by the user (0x6985)"), HASH]);
      const { io, questions } = scriptedIO([true]);
      const result = await new SendGuardProvider(provider, io)
        .request({ method: "eth_sendTransaction", params: [LEDGER_TX] });
      expect(result).to.equal(HASH);
      expect(calls).to.have.length(2);
      expect(calls[1]).to.deep.equal(calls[0]);
      expect(questions[0]).to.include("nothing was broadcast").and.include("nonce 42");
    });

    // WHY: the operator decides; declining must surface the original error and stop the stage.
    it("rethrows the Ledger error when the operator declines", async function () {
      const { provider, calls } = scriptedProvider([ledgerError("locked device (0x5515)")]);
      const { io } = scriptedIO([false]);
      await expect(new SendGuardProvider(provider, io)
        .request({ method: "eth_sendTransaction", params: [LEDGER_TX] })).to.be.rejectedWith(/locked device/);
      expect(calls).to.have.length(1);
    });

    // WHY: an RPC error from eth_sendRawTransaction may mean the transaction WAS broadcast.
    // Re-sending could not be judged safe, so only Ledger-plugin errors are ever retried.
    it("never retries a non-Ledger error", async function () {
      const { provider, calls } = scriptedProvider([new Error("connection reset")]);
      const { io, questions } = scriptedIO([true]);
      await expect(new SendGuardProvider(provider, io)
        .request({ method: "eth_sendTransaction", params: [LEDGER_TX] })).to.be.rejectedWith(/connection reset/);
      expect(calls).to.have.length(1);
      expect(questions).to.have.length(0);
    });

    // WHY: reads and estimates must pass straight through without logging noise.
    it("passes other methods through untouched", async function () {
      const { provider, calls } = scriptedProvider(["0x1"]);
      const { io, lines } = scriptedIO([]);
      expect(await new SendGuardProvider(provider, io).request({ method: "eth_chainId" })).to.equal("0x1");
      expect(calls).to.deep.equal([{ method: "eth_chainId" }]);
      expect(lines).to.have.length(0);
    });
  });

  describe("LedgerOnlyAccountsProvider", function () {
    // WHY: hardhat-ledger lists the RPC node's own accounts BEFORE the Ledger. A node that exposes
    // unlocked accounts (Anvil, a local node, a misconfigured RPC) would become signer[0] and sign
    // the deploy instead of the device. Found by the Sepolia-fork rehearsal of the orchestrator.
    it("reports only the Ledger address, whatever the node exposes", async function () {
      const ledger = "0x00000000000000000000000000000000000000Ab";
      for (const method of ["eth_accounts", "eth_requestAccounts"]) {
        const { provider, calls } = scriptedProvider([["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", ledger]]);
        expect(await new LedgerOnlyAccountsProvider(provider, ledger).request({ method })).to.deep.equal([ledger]);
        expect(calls, method).to.have.length(0);
      }
    });

    // WHY: everything else, including sends, must reach the Ledger provider unchanged.
    it("passes other methods through", async function () {
      const { provider, calls } = scriptedProvider([HASH]);
      const args = { method: "eth_sendTransaction", params: [LEDGER_TX] };
      expect(await new LedgerOnlyAccountsProvider(provider, LEDGER_TX.from).request(args)).to.equal(HASH);
      expect(calls).to.deep.equal([args]);
    });
  });

  describe("gas headroom (gasMultiplier)", function () {
    // WHY: hardhat-ethers sets each transaction's gas limit from its own eth_estimateGas call, so
    // Hardhat's gasMultiplier (applied only when a send has no limit) never took effect: every
    // launch transaction was signed at exactly its estimate. The multiplier is applied to the
    // estimate instead.
    it("scales an estimate by the multiplier, rounding up", function () {
      expect(withGasHeadroom(100_000n, 2)).to.equal(200_000n);
      expect(withGasHeadroom(100_001n, 1.5)).to.equal(150_002n);
      expect(withGasHeadroom(100_000n, 1)).to.equal(100_000n);
    });

    // WHY: since Fusaka a transaction may not exceed 2^24 gas. Doubling a large estimate (the
    // RevenueLock deploy with many beneficiaries) past that would make the transaction invalid,
    // so headroom stops at the cap, and an estimate already above it is left for the node to reject.
    it("never raises a limit above the per-transaction gas cap", function () {
      expect(TRANSACTION_GAS_LIMIT_CAP).to.equal(16_777_216n);
      expect(withGasHeadroom(9_000_000n, 2)).to.equal(TRANSACTION_GAS_LIMIT_CAP);
      expect(withGasHeadroom(17_000_000n, 2)).to.equal(17_000_000n);
    });

    // WHY: only estimates change; every other call, and estimate errors (e.g. the timelock's
    // "not ready" retry signal), pass through untouched.
    it("rewrites eth_estimateGas results only", async function () {
      const { provider } = scriptedProvider(["0x186a0", "0x1", new Error("operation is not ready")]);
      const headroom = new GasHeadroomProvider(provider, 2);
      expect(await headroom.request({ method: "eth_estimateGas", params: [{}] })).to.equal("0x30d40");
      expect(await headroom.request({ method: "eth_chainId" })).to.equal("0x1");
      await expect(headroom.request({ method: "eth_estimateGas", params: [{}] })).to.be.rejectedWith(/not ready/);
    });
  });

  describe("Ledger signer wiring (hardhat.config.ts)", function () {
    // Each case loads the Hardhat config in a fresh process, since config is read once per process.
    this.timeout(120_000);
    const LEDGER = "0x00000000000000000000000000000000000000Ab";
    const REPO = path.join(__dirname, "..");

    /** Run a node snippet after `require("hardhat")` with only the given deploy env set. */
    function withHardhat(env: Record<string, string>, snippet: string) {
      return spawnSync(process.execPath, ["-r", "ts-node/register", "-e", snippet], {
        cwd: REPO, encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TS_NODE_TRANSPILE_ONLY: "true", ...env },
      });
    }
    const PRINT_NETWORKS = `
      const n = require("hardhat").config.networks;
      const pick = (x) => ({ accounts: x.accounts, ledgerAccounts: x.ledgerAccounts });
      console.log(JSON.stringify({ mainnetHub: pick(n.mainnetHub), sepoliaHub: pick(n.sepoliaHub),
        mainnetClient1: pick(n.mainnetClient1), sepoliaClient1: pick(n.sepoliaClient1) }));`;

    // WHY: with a Ledger configured, every live network must sign through the device and hold
    // NO local account — Hardhat lists local accounts first, so a leftover key (or the Anvil
    // fallback) would become signer[0] and deploy instead of the Ledger.
    it("routes every live network through the Ledger and drops local accounts", function () {
      const r = withHardhat({ DEPLOYER_LEDGER_ADDRESS: LEDGER }, PRINT_NETWORKS);
      expect(r.status, r.stderr).to.equal(0);
      const nets = JSON.parse(r.stdout.trim().split("\n").pop()!);
      for (const [name, net] of Object.entries(nets) as Array<[string, any]>) {
        expect(net.ledgerAccounts, name).to.deep.equal([LEDGER]);
        expect(net.accounts, name).to.equal("remote");
      }
    });

    // WHY: the hot-key path is unchanged and does not load the Ledger plugin.
    it("keeps the private-key path when no Ledger is configured", function () {
      const r = withHardhat({ DEPLOYER_PRIVATE_KEY: "0x" + "11".repeat(32) }, PRINT_NETWORKS);
      expect(r.status, r.stderr).to.equal(0);
      const nets = JSON.parse(r.stdout.trim().split("\n").pop()!);
      expect(nets.mainnetHub.accounts).to.have.length(1);
      expect(nets.mainnetHub.ledgerAccounts).to.equal(undefined);
    });

    // WHY: secrets.env sets a key by default; adding a Ledger on top must stop, not pick one.
    it("refuses to load with both a key and a Ledger address", function () {
      const r = withHardhat({ DEPLOYER_PRIVATE_KEY: "0x" + "11".repeat(32), DEPLOYER_LEDGER_ADDRESS: LEDGER },
        PRINT_NETWORKS);
      expect(r.status).to.not.equal(0);
      expect(r.stderr).to.include("not both");
    });

    // WHY: end to end through Hardhat's real provider stack — the send guard must wrap the Ledger
    // provider, or a rejected prompt would end the run without the pre-broadcast retry. With no
    // device attached the plugin fails to connect; the guard must report it as pre-broadcast,
    // and the stub RPC must never see a raw transaction. The stub also exposes a node account,
    // which must not appear ahead of (or alongside) the Ledger.
    it("puts the send guard outside the Ledger provider on a live network", function () {
      this.timeout(120_000);
      const snippet = `
        const http = require("http");
        const seen = [];
        const srv = http.createServer((req, res) => {
          let body = ""; req.on("data", (d) => body += d);
          req.on("end", () => {
            const r = JSON.parse(body); seen.push(r.method);
            const results = { eth_chainId: "0xaa36a7", net_version: "11155111",
              eth_accounts: ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"] };
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: results[r.method] ?? null }));
          });
        });
        srv.listen(0, "127.0.0.1", async () => {
          process.env.HUB_RPC = "http://127.0.0.1:" + srv.address().port;
          const hre = require("hardhat");
          const accounts = await hre.network.provider.request({ method: "eth_accounts" });
          console.log("ACCOUNTS " + JSON.stringify(accounts));
          try {
            await hre.network.provider.request({ method: "eth_sendTransaction", params: [{
              from: "${LEDGER}", to: "0x00000000000000000000000000000000000000cd", gas: "0x5208",
              maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x1", nonce: "0x5", value: "0x0" }] });
            console.log("RESULT sent");
          } catch (e) {
            console.log("RESULT " + JSON.stringify({ pluginName: e.pluginName, seen }));
          }
          srv.close(); process.exit(0);
        });`;
      const r = withHardhat({ DEPLOYER_LEDGER_ADDRESS: LEDGER, DEPLOY_ENV: "sepolia", HARDHAT_NETWORK: "sepoliaHub" }, snippet);
      expect(r.status, r.stderr).to.equal(0);
      const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "))!;
      const result = JSON.parse(line.slice("RESULT ".length));
      const accountsLine = r.stdout.split("\n").find((l) => l.startsWith("ACCOUNTS "))!;
      expect(JSON.parse(accountsLine.slice("ACCOUNTS ".length))).to.deep.equal([LEDGER]);
      expect(result.pluginName).to.equal(LEDGER_PLUGIN_NAME);
      expect(result.seen).to.not.include("eth_sendRawTransaction");
      expect(r.stderr).to.include("nothing was broadcast — nonce 5 is still unused");
      expect(r.stderr).to.include("stdin is not interactive — not retrying");
    });
  });

  describe("awaitExpectedNonce (stage-to-stage nonce handoff)", function () {
    /** A nonce reader that returns the scripted values in order, then repeats the last. */
    const readsOf = (...values: number[]) => async () => values.length > 1 ? values.shift()! : values[0];

    // Retries log a "read-back failed" line per attempt; capture them so the cases can assert
    // on the expected lag output instead of printing it.
    let logged: string[];
    let log: typeof console.log;
    beforeEach(() => { logged = []; log = console.log; console.log = (line: string) => { logged.push(line); }; });
    afterEach(() => { console.log = log; });

    // WHY: the crowdfund stage starts seconds after governance's last transaction. A lagging
    // load-balanced RPC node can still report the older, already-used nonce; seeding from it
    // makes the first send fail "nonce too low" or hang on a transaction that can never mine.
    it("waits out a lagging node until the nonce reaches the recorded handoff", async function () {
      expect(await awaitExpectedNonce(readsOf(20, 20, 21), 21, 5, 0)).to.equal(21);
      expect(logged).to.have.length(2);
      expect(logged[0]).to.include("Deployer nonce: read-back failed (possible RPC lag)");
    });

    // WHY: a node that stays behind is not lag the deploy can safely wait out forever.
    it("gives up when the node never catches up", async function () {
      await expect(awaitExpectedNonce(readsOf(20), 21, 3, 0)).to.be.rejectedWith(/behind/);
      expect(logged).to.have.length(2);
    });

    // WHY: in a hardened run governance and crowdfund are back to back. A higher nonce means the
    // deployer key signed something outside the deploy (another wallet, or a compromised key):
    // stop immediately rather than retry, and point at the recovery runbook.
    it("aborts at once when the deployer nonce is ahead of the handoff", async function () {
      let reads = 0;
      const read = async () => { reads++; return 23; };
      await expect(awaitExpectedNonce(read, 21, 5, 0))
        .to.be.rejectedWith(/2 transaction\(s\) outside this deploy[\s\S]*interrupted-launch-recovery/);
      expect(reads).to.equal(1);
      expect(logged).to.have.length(0);
    });

    // WHY: against a real chain the handoff is exactly the signer's next nonce after its sends.
    it("matches a real signer's nonce after its sends", async function () {
      const [signer] = await hre.ethers.getSigners();
      await (await signer.sendTransaction({ to: signer.address, value: 0n })).wait();
      const next = await signer.getNonce();
      expect(await awaitExpectedNonce(() => signer.getNonce(), next, 1, 0)).to.equal(next);
      await expect(awaitExpectedNonce(() => signer.getNonce(), next - 1, 1, 0)).to.be.rejectedWith(/outside this deploy/);
    });
  });

  describe("crowdfundHandoffNonce", function () {
    // WHY: a hardened run is CCTP-record → governance → crowdfund with nothing in between
    // (deploy_mainnet.ts), so the crowdfund stage must start exactly where governance ended.
    it("returns governance's recorded nonce for a hardened live run", function () {
      expect(crowdfundHandoffNonce({ deployerNonceAfterGovernance: 21 }, true, false)).to.equal(21);
    });

    // WHY: without the record the stage would fall back to a single, possibly stale, nonce read —
    // the exact failure the handoff exists to prevent. Refuse before any transaction.
    it("refuses a hardened live run whose governance manifest has no recorded nonce", function () {
      expect(() => crowdfundHandoffNonce({}, true, false)).to.throw(/deployerNonceAfterGovernance/);
    });

    // WHY: non-hardened runs (e.g. the full Sepolia pipeline) deploy other stages between
    // governance and crowdfund, so governance's final nonce is not the crowdfund's start nonce.
    // Local runs let ethers pick nonces.
    it("does not apply to non-hardened or local runs", function () {
      expect(crowdfundHandoffNonce({ deployerNonceAfterGovernance: 21 }, false, false)).to.equal(undefined);
      expect(crowdfundHandoffNonce({}, true, true)).to.equal(undefined);
    });
  });

  describe("crowdfund open-time lead", function () {
    // WHY: the lead is checked once, before compile. A Ledger run signs ~63 transactions at
    // 30–60s each, then verification, manifest publish, frontend pin and indexer start must also
    // fit. One hour could run out: the crowdfund deploy would revert ("openTimestamp in past") or
    // the 21-day sale window would start while the launch is still being wired.
    it("requires at least six hours between the pre-flight and the sale opening", function () {
      expect(CROWDFUND_OPEN_MIN_LEAD_SECONDS).to.be.at.least(6 * 60 * 60);
    });

    // WHY: the Sepolia rehearsal signed its transactions in about 20 minutes, so an operator may
    // shorten the lead (CROWDFUND_OPEN_MIN_LEAD_SECONDS) for an announced open time. One hour
    // still leaves room for signing plus a margin; below that an overrun strands the launch.
    it("never lets an override go below one hour", function () {
      expect(CROWDFUND_OPEN_MIN_LEAD_FLOOR_SECONDS).to.equal(60 * 60);
    });
  });

  describe("Ledger pre-flight checks", function () {
    const wallet = ethers.Wallet.createRandom();

    // WHY: if a local account shadowed the Ledger (a leftover key, the Anvil fallback), signer[0]
    // would not be the device. Catch it before the first transaction, not after it is signed.
    it("rejects a signer[0] that is not the configured Ledger address", function () {
      expect(() => assertLedgerSigner(wallet.address, wallet.address.toLowerCase())).to.not.throw();
      expect(() => assertLedgerSigner(wallet.address, "0x00000000000000000000000000000000000000cd"))
        .to.throw(/not the Ledger/);
    });

    // WHY: the signed message proves the device is connected, unlocked, in the Ethereum app and
    // holds the deployer key — the conditions every later prompt depends on.
    it("accepts a signature from the Ledger address and rejects any other signer", async function () {
      const message = ledgerPreflightMessage(1, "a".repeat(40));
      const other = ethers.Wallet.createRandom();
      expect(() => assertSignedBy(message, wallet.signMessageSync(message), wallet.address)).to.not.throw();
      expect(() => assertSignedBy(message, other.signMessageSync(message), wallet.address)).to.throw(/signed by/);
    });

    // WHY: the operator reads the message on the device; it must say which chain and build the
    // approval is for, and that approving it sends no transaction.
    it("names the chain and commit, and says no transaction is sent", function () {
      const message = ledgerPreflightMessage(1, "a".repeat(40));
      expect(message).to.include("Chain: 1").and.include("a".repeat(40)).and.include("No transaction");
      expect(ledgerPreflightMessage(11155111, undefined)).to.include("not pinned");
    });
  });

  describe("gas headroom through Hardhat's provider stack", function () {
    // WHY: end to end for the real bug — a hot-key send on a live network, through hardhat-ethers
    // and Hardhat's full provider stack, must be signed with ~2x the node's estimate (the network's
    // gasMultiplier). The stub RPC estimates 100,000 gas and captures the signed raw transaction.
    it("signs live-network transactions with the configured gasMultiplier", function () {
      this.timeout(120_000);
      const key = "0x" + "11".repeat(32);
      const snippet = `
        const http = require("http");
        const { Transaction } = require("ethers");
        let raw;
        const results = {
          eth_chainId: "0xaa36a7", net_version: "11155111", eth_blockNumber: "0x10",
          eth_estimateGas: "0x186a0", eth_getTransactionCount: "0x0", eth_gasPrice: "0x3b9aca00",
          eth_maxPriorityFeePerGas: "0x1",
          eth_feeHistory: { oldestBlock: "0xf", baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0.5], reward: [["0x1"]] },
          eth_getBlockByNumber: { number: "0x10", baseFeePerGas: "0x3b9aca00", timestamp: "0x1", transactions: [] },
          eth_getTransactionByHash: null,
        };
        const srv = http.createServer((req, res) => {
          let body = ""; req.on("data", (d) => body += d);
          req.on("end", () => {
            const r = JSON.parse(body);
            let result = results[r.method] ?? null;
            if (r.method === "eth_sendRawTransaction") { raw = r.params[0]; result = Transaction.from(raw).hash; }
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
          });
        });
        srv.listen(0, "127.0.0.1", async () => {
          process.env.HUB_RPC = "http://127.0.0.1:" + srv.address().port;
          const hre = require("hardhat");
          console.log("ESTIMATE " + await hre.ethers.provider.estimateGas({ to: "0x00000000000000000000000000000000000000cd" }));
          const [signer] = await hre.ethers.getSigners();
          signer.sendTransaction({ to: "0x00000000000000000000000000000000000000cd", value: 0 }).catch(() => {});
          for (let i = 0; i < 200 && !raw; i++) await new Promise((r) => setTimeout(r, 50));
          console.log("GASLIMIT " + (raw ? Transaction.from(raw).gasLimit : "none"));
          srv.close(); process.exit(0);
        });`;
      const r = spawnSync(process.execPath, ["-r", "ts-node/register", "-e", snippet], {
        cwd: path.join(__dirname, ".."), encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TS_NODE_TRANSPILE_ONLY: "true",
          DEPLOY_ENV: "sepolia", HARDHAT_NETWORK: "sepoliaHub", DEPLOYER_PRIVATE_KEY: key },
      });
      expect(r.status, r.stderr).to.equal(0);
      expect(r.stdout).to.include("ESTIMATE 200000");
      expect(r.stdout).to.include("GASLIMIT 200000");
    });
  });
});
