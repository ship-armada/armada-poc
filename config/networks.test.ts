// ABOUTME: Unit tests for the N-client network config — pins the indexed CLIENT_<n>_* env
// ABOUTME: scheme, client ordering, role/domain/chainId lookups, and CCTP address merging.

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

// Env keys the config reads that a test might set — cleared between tests so one case
// can't leak chain topology into the next (getNetworkConfig caches, so we also re-require).
const MANAGED_PREFIXES = ["CLIENT_", "HUB_", "CCTP_", "DEPLOY_ENV", "DEPLOYER_PRIVATE_KEY",
  "REVENUE_LOCK_", "REVENUE_RESERVE_", "TREASURY_ADDRESS", "SECURITY_COUNCIL_ADDRESS", "LAUNCH_TEAM_ADDRESS",
  "CCTP_MODE", "WINDDOWN_", "OUTFLOW_", "CROWDFUND_"];

function clearManagedEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (MANAGED_PREFIXES.some((p) => key === p || key.startsWith(p))) {
      delete process.env[key];
    }
  }
}

/**
 * Load a fresh copy of config/networks with the given env. getNetworkConfig memoizes into a
 * module-level cache, so we drop the module from require.cache and re-require to get a clean
 * build per scenario.
 */
function freshConfig(env: Record<string, string>) {
  clearManagedEnv();
  Object.assign(process.env, env);
  const modPath = require.resolve("./networks");
  delete require.cache[modPath];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./networks") as typeof import("./networks");
}

// Non-local envs require an explicit revenue-lock config or the builder fails loud before
// it ever reaches client construction — supply a placeholder so these tests exercise clients.
const REVENUE_LOCK_JSON = JSON.stringify([{ address: "0x0000000000000000000000000000000000000001", amount: "1", label: "test" }]);
const SEPOLIA_BASE = {
  DEPLOY_ENV: "sepolia",
  // Non-local envs require DEPLOYER_PRIVATE_KEY to be non-empty; the config never parses it,
  // so an obviously-fake placeholder suffices (and keeps a real key shape out of the repo).
  DEPLOYER_PRIVATE_KEY: "test-placeholder-not-a-real-key",
  REVENUE_LOCK_BENEFICIARIES_JSON: REVENUE_LOCK_JSON,
};

describe("networks config — N clients", () => {
  afterEach(() => {
    clearManagedEnv();
    delete process.env.REVENUE_LOCK_BENEFICIARIES_JSON;
  });

  it("defaults local to a hub plus two Anvil clients (client1, client2)", () => {
    // WHY: local dev must work with zero client env set — the historical two-Anvil topology
    // (8546/8547, domains 101/102) is preserved as the default so `npm run chains`/setup is
    // unchanged by the array refactor.
    const { getNetworkConfig } = freshConfig({ DEPLOY_ENV: "local" });
    const c = getNetworkConfig();
    expect(c.clients).to.have.length(2);
    expect(c.clients.map((x) => x.role)).to.deep.equal(["client1", "client2"]);
    expect(c.clients[0]).to.include({ chainId: 31338, cctpDomain: 101, deploymentPrefix: "client1", hardhatNetwork: "client1" });
    expect(c.clients[1]).to.include({ chainId: 31339, cctpDomain: 102, deploymentPrefix: "client2", hardhatNetwork: "client2" });
  });

  it("getAllChains lists the hub first, then clients in order", () => {
    // WHY: deploy drivers and scanners iterate getAllChains(); hub-first ordering is relied on
    // by callers that treat index 0 as the hub.
    const { getAllChains } = freshConfig({ DEPLOY_ENV: "local" });
    const roles = getAllChains().map((c) => c.role);
    expect(roles).to.deep.equal(["hub", "client1", "client2"]);
  });

  it("builds N clients from the indexed CLIENT_<n>_* scheme (CLIENT_COUNT=3)", () => {
    // WHY: the whole point of the refactor — CLIENT_COUNT plus per-index vars must yield an
    // arbitrary-length client list, not a fixed two.
    const { getNetworkConfig, getClientChains } = freshConfig({
      ...SEPOLIA_BASE,
      HUB_CHAIN_ID: "11155111", HUB_CCTP_DOMAIN: "0",
      CLIENT_COUNT: "3",
      CLIENT_1_RPC: "https://c1", CLIENT_1_CHAIN_ID: "11155420", CLIENT_1_CCTP_DOMAIN: "2", CLIENT_1_USDC: "0xc1",
      CLIENT_2_RPC: "https://c2", CLIENT_2_CHAIN_ID: "998", CLIENT_2_CCTP_DOMAIN: "19", CLIENT_2_USDC: "0xc2",
      CLIENT_3_RPC: "https://c3", CLIENT_3_CHAIN_ID: "84532", CLIENT_3_CCTP_DOMAIN: "6", CLIENT_3_USDC: "0xc3",
    });
    expect(getNetworkConfig().clients).to.have.length(3);
    expect(getClientChains().map((c) => c.role)).to.deep.equal(["client1", "client2", "client3"]);
    expect(getClientChains()[2]).to.include({ chainId: 84532, cctpDomain: 6, hardhatNetwork: "sepoliaClient3" });
  });

  it("resolves chains by role, chainId, and CCTP domain", () => {
    // WHY: the deploy/link/relayer code all cross-reference by these three keys; a wrong lookup
    // silently wires the wrong remote pool.
    const { getChainByRole, getChainRole, getChainByDomain, getChainByChainId } = freshConfig({
      ...SEPOLIA_BASE, HUB_CHAIN_ID: "11155111", HUB_CCTP_DOMAIN: "0",
      CLIENT_COUNT: "2",
      CLIENT_1_RPC: "https://c1", CLIENT_1_CHAIN_ID: "11155420", CLIENT_1_CCTP_DOMAIN: "2",
      CLIENT_2_RPC: "https://c2", CLIENT_2_CHAIN_ID: "998", CLIENT_2_CCTP_DOMAIN: "19",
    });
    expect(getChainByRole("client2").chainId).to.equal(998);
    expect(getChainRole(11155420)).to.equal("client1");
    expect(getChainRole(999999)).to.equal(null);
    expect(getChainByDomain(19)?.role).to.equal("client2");
    expect(getChainByChainId(11155111)?.role).to.equal("hub");
  });

  it("getCCTPAddresses merges shared infra with the chain's own USDC", () => {
    // WHY: messenger/transmitter/minter are the same CREATE2 address on every EVM testnet, but
    // USDC differs per chain — a client must get shared infra + its own token, never another
    // chain's USDC.
    const { getCCTPAddresses } = freshConfig({
      ...SEPOLIA_BASE, HUB_CHAIN_ID: "11155111", HUB_CCTP_DOMAIN: "0", HUB_USDC: "0xhub",
      CCTP_TOKEN_MESSENGER: "0xmsgr", CCTP_MESSAGE_TRANSMITTER: "0xxmit", CCTP_TOKEN_MINTER: "0xmint",
      CLIENT_COUNT: "1",
      CLIENT_1_RPC: "https://c1", CLIENT_1_CHAIN_ID: "11155420", CLIENT_1_CCTP_DOMAIN: "2", CLIENT_1_USDC: "0xc1usdc",
    });
    expect(getCCTPAddresses("client1")).to.deep.equal({
      tokenMessenger: "0xmsgr", messageTransmitter: "0xxmit", tokenMinter: "0xmint", usdc: "0xc1usdc",
    });
    expect(getCCTPAddresses("hub").usdc).to.equal("0xhub");
  });

  it("throws when CLIENT_COUNT is 0", () => {
    // WHY: a hub-and-spoke deployment with no spokes is a misconfiguration; fail loud rather
    // than produce an empty client list that silently no-ops the link step.
    expect(() => freshConfig({ ...SEPOLIA_BASE, CLIENT_COUNT: "0" }).getNetworkConfig()).to.throw(/CLIENT_COUNT/);
  });

  it("throws when a non-local client is missing required env", () => {
    // WHY: on testnet/mainnet there are no safe defaults for a client's RPC/chainId/domain —
    // a missing var must fail loud, not fall back to localhost.
    expect(() => freshConfig({
      ...SEPOLIA_BASE, HUB_CHAIN_ID: "11155111", HUB_CCTP_DOMAIN: "0",
      CLIENT_COUNT: "1",
      // CLIENT_1_RPC intentionally omitted
      CLIENT_1_CHAIN_ID: "11155420", CLIENT_1_CCTP_DOMAIN: "2",
    }).getNetworkConfig()).to.throw(/CLIENT_1_RPC/);
  });
});


describe("reserve configuration", () => {
  afterEach(clearManagedEnv);

  // WHY: An omitted half of the reserve configuration must not silently disable its deployment.
  it("requires allocator and amount together", () => {
    for (const env of [{ REVENUE_RESERVE_ALLOCATOR: "0x0000000000000000000000000000000000000001" },
      { REVENUE_RESERVE_AMOUNT: "360000" }] as Record<string, string>[]) {
      const { getNetworkConfig } = freshConfig({ DEPLOY_ENV: "local", ...env });
      expect(() => getNetworkConfig()).to.throw("Set both REVENUE_RESERVE");
    }
  });

  // WHY: The scripts must receive exactly the configured cap without changing any direct allocations.
  it("retains an explicit reserve and defaults to none", () => {
    const allocator = "0x0000000000000000000000000000000000000001";
    const configured = freshConfig({ DEPLOY_ENV: "local", REVENUE_RESERVE_ALLOCATOR: allocator,
      REVENUE_RESERVE_AMOUNT: "360000" }).getNetworkConfig();
    expect(configured.revenueReserve).to.deep.equal({ allocator, amount: "360000" });
    expect(freshConfig({ DEPLOY_ENV: "local" }).getNetworkConfig().revenueReserve).to.equal(undefined);
  });

  // WHY: The committed Sepolia schedule must exhaust the lock budget in either
  // mode; the previous 200 ARM file would strand 2,399,800 ARM on activation.
  it("pins fresh Sepolia beneficiary totals for direct and reserve rehearsals", () => {
    const total = (file: string) => (JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8")) as
      { amount: string }[]).reduce((sum, row) => sum + BigInt(row.amount), 0n);
    expect(total("revenue-lock-beneficiaries-sepolia.json")).to.equal(2_400_000n);
    expect(total("revenue-lock-beneficiaries-sepolia-reserve.json") + 360_000n).to.equal(2_400_000n);
  });
});

describe("wind-down deadline", () => {
  afterEach(() => {
    clearManagedEnv();
    delete process.env.REVENUE_LOCK_BENEFICIARIES_JSON;
  });

  // Non-local envs must pass the client builder before the wind-down field is read.
  const ONE_CLIENT = {
    CLIENT_COUNT: "1",
    CLIENT_1_RPC: "https://c1", CLIENT_1_CHAIN_ID: "8453", CLIENT_1_CCTP_DOMAIN: "6",
  };
  // CROWDFUND_OPEN_TIME is also mainnet-required; set it so these cases isolate the deadline.
  const MAINNET_BASE = {
    ...SEPOLIA_BASE, ...ONE_CLIENT, DEPLOY_ENV: "mainnet", CCTP_MODE: "real",
    CROWDFUND_OPEN_TIME: "2026-10-08T17:00:00Z",
  };

  // WHY: the deadline arms a permissionless, terminal wind-down and is fixed at the
  // crowdfund deploy; a mainnet deploy must never pick it up from a silent default.
  it("requires WINDDOWN_DEADLINE on mainnet", () => {
    expect(() => freshConfig(MAINNET_BASE).getNetworkConfig()).to.throw(/WINDDOWN_DEADLINE/);
  });

  // WHY: an explicitly chosen mainnet deadline must reach the deploy script unchanged.
  it("uses the explicit WINDDOWN_DEADLINE on mainnet", () => {
    const c = freshConfig({ ...MAINNET_BASE, WINDDOWN_DEADLINE: "2028-06-30T00:00:00Z" }).getNetworkConfig();
    expect(c.windDownDeadline).to.equal("2028-06-30T00:00:00Z");
  });

  // WHY: local and testnet deploys keep working with no wind-down env set; the default sits
  // well clear of the constructor's "deadline in past" check.
  it("defaults local and Sepolia to 2027-12-31", () => {
    expect(freshConfig({ DEPLOY_ENV: "local" }).getNetworkConfig().windDownDeadline)
      .to.equal("2027-12-31T00:00:00Z");
    expect(freshConfig({ ...SEPOLIA_BASE, ...ONE_CLIENT }).getNetworkConfig().windDownDeadline)
      .to.equal("2027-12-31T00:00:00Z");
  });
});

describe("crowdfund open time", () => {
  afterEach(() => {
    clearManagedEnv();
    delete process.env.REVENUE_LOCK_BENEFICIARIES_JSON;
  });

  const ONE_CLIENT = {
    CLIENT_COUNT: "1",
    CLIENT_1_RPC: "https://c1", CLIENT_1_CHAIN_ID: "8453", CLIENT_1_CCTP_DOMAIN: "6",
  };
  const MAINNET_BASE = {
    ...SEPOLIA_BASE, ...ONE_CLIENT, DEPLOY_ENV: "mainnet", CCTP_MODE: "real",
    WINDDOWN_DEADLINE: "2027-12-31T00:00:00Z",
  };

  // WHY: windowStart is immutable and the launch is announced for a fixed time; a mainnet
  // deploy must never fall back to a relative delay that drifts with deploy duration.
  it("requires CROWDFUND_OPEN_TIME on mainnet", () => {
    expect(() => freshConfig(MAINNET_BASE).getNetworkConfig()).to.throw(/CROWDFUND_OPEN_TIME/);
  });

  // WHY: the announced open time must reach the deploy script unchanged.
  it("uses the explicit CROWDFUND_OPEN_TIME on mainnet", () => {
    const c = freshConfig({ ...MAINNET_BASE, CROWDFUND_OPEN_TIME: "2026-10-08T17:00:00Z" }).getNetworkConfig();
    expect(c.crowdfundOpenTime).to.equal("2026-10-08T17:00:00Z");
  });

  // WHY: local and Sepolia deploys keep working with no open-time env set, opening after
  // the relative delay; the absolute time is an optional override there (e.g. rehearsals).
  it("leaves the open time unset on local and Sepolia, keeping the delay fallback", () => {
    const local = freshConfig({ DEPLOY_ENV: "local" }).getNetworkConfig();
    expect(local.crowdfundOpenTime).to.equal(undefined);
    expect(local.crowdfundOpenDelay).to.equal(600);
    const sepolia = freshConfig({ ...SEPOLIA_BASE, ...ONE_CLIENT, CROWDFUND_OPEN_TIME: "2026-10-08T17:00:00Z" })
      .getNetworkConfig();
    expect(sepolia.crowdfundOpenTime).to.equal("2026-10-08T17:00:00Z");
  });
});

// GOVERNANCE.md §Treasury Outflow Limits: 30-day rolling window; limit is the greater of the
// absolute amount and the percentage of treasury balance; the floor is immutable once set.
const SPEC_OUTFLOW = {
  usdc: { windowDuration: 30 * 86400, limitBps: 1000, limitAbsolute: "100000000000", floorAbsolute: "50000000000" },
  arm: {
    windowDuration: 30 * 86400, limitBps: 300,
    limitAbsolute: "250000000000000000000000", floorAbsolute: "100000000000000000000000",
  },
  // USDC pattern: 30-day window, 10%, 25 ETH absolute (~$100k); floor 0 because floors can
  // only ever be raised.
  eth: { windowDuration: 30 * 86400, limitBps: 1000, limitAbsolute: "25000000000000000000", floorAbsolute: "0" },
};

describe("treasury outflow limits", () => {
  afterEach(clearManagedEnv);

  // WHY: initOutflowConfig is one-shot per token and its floor can never be lowered, so a
  // deploy that omits the OUTFLOW_* env must still install the spec limits, not looser ones.
  it("defaults USDC, ARM and ETH to the GOVERNANCE.md spec values", () => {
    const c = freshConfig({ DEPLOY_ENV: "local" }).getNetworkConfig();
    expect(c.outflowConfig).to.deep.equal(SPEC_OUTFLOW);
  });
});

describe("committed mainnet.env", () => {
  /** Read the `export KEY=VALUE` lines of a committed env template (comments ignored). */
  function readEnvTemplate(file: string): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const line of fs.readFileSync(path.join(__dirname, file), "utf8").split("\n")) {
      const m = line.match(/^export ([A-Z0-9_]+)=(.*)$/);
      if (m) vars[m[1]] = m[2];
    }
    return vars;
  }

  const MAINNET_ENV = readEnvTemplate("mainnet.env");

  // The template sets keys outside MANAGED_PREFIXES (IRIS_*, ARM_*, …); drop them all so
  // they cannot leak into later suites.
  afterEach(() => {
    clearManagedEnv();
    for (const key of Object.keys(MAINNET_ENV)) delete process.env[key];
    delete process.env.REVENUE_LOCK_BENEFICIARIES_JSON;
  });

  // WHY: deploy_mainnet.ts step 1 (CCTP-record) runs validateCCTPConfig("hub") before the
  // crowdfund can read hub USDC from its manifest. The template must carry the CCTP
  // addresses or the mainnet launch cannot get past step 1 (#535).
  it("passes the hub CCTP validation run by deploy step 1", () => {
    const { validateCCTPConfig } = freshConfig({
      ...MAINNET_ENV,
      // Supplied by secrets.env / launch-time TODOs, not the committed template.
      DEPLOYER_PRIVATE_KEY: "test-placeholder-not-a-real-key",
      REVENUE_LOCK_BENEFICIARIES_JSON: REVENUE_LOCK_JSON,
      CROWDFUND_OPEN_TIME: "2026-10-08T17:00:00Z",
    });
    expect(() => validateCCTPConfig("hub")).to.not.throw();
  });

  // WHY: the launch freeze sheet reads the outflow limits from the committed template; it
  // must state the spec values explicitly rather than rely on code defaults (#348).
  it("sets USDC, ARM and ETH outflow limits to the GOVERNANCE.md spec values", () => {
    for (const token of ["USDC", "ARM", "ETH"]) {
      for (const key of ["WINDOW", "BPS", "ABSOLUTE", "FLOOR"]) {
        expect(MAINNET_ENV).to.have.property(`OUTFLOW_${token}_${key}`);
      }
    }
    const c = freshConfig({
      ...MAINNET_ENV,
      DEPLOYER_PRIVATE_KEY: "test-placeholder-not-a-real-key",
      REVENUE_LOCK_BENEFICIARIES_JSON: REVENUE_LOCK_JSON,
      CROWDFUND_OPEN_TIME: "2026-10-08T17:00:00Z",
    }).getNetworkConfig();
    expect(c.outflowConfig).to.deep.equal(SPEC_OUTFLOW);
  });
});
