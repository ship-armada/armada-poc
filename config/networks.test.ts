// ABOUTME: Unit tests for the N-client network config — pins the indexed CLIENT_<n>_* env
// ABOUTME: scheme, client ordering, role/domain/chainId lookups, and CCTP address merging.

import { expect } from "chai";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Env keys the config reads that a test might set — cleared between tests so one case
// can't leak chain topology into the next (getNetworkConfig caches, so we also re-require).
const MANAGED_PREFIXES = ["CLIENT_", "HUB_", "CCTP_", "DEPLOY_ENV", "DEPLOYER_PRIVATE_KEY", "DEPLOYER_LEDGER_ADDRESS",
  "REVENUE_LOCK_", "REVENUE_RESERVE_", "TREASURY_ADDRESS", "SECURITY_COUNCIL_ADDRESS", "LAUNCH_TEAM_ADDRESS",
  "CCTP_MODE", "WINDDOWN_", "OUTFLOW_", "CROWDFUND_", "HARDEN_TIMELOCK", "INITIAL_STEWARD_", "STEWARD_BUDGET_"];

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
// INITIAL_STEWARD_ADDRESS is mainnet-required; mainnet cases that isolate another field supply it.
const TEST_STEWARD = "0x0000000000000000000000000000000000000003";
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

describe("deployer signer", () => {
  afterEach(() => {
    clearManagedEnv();
    delete process.env.REVENUE_LOCK_BENEFICIARIES_JSON;
  });
  const LEDGER = "0x00000000000000000000000000000000000000Ab";
  const ONE_CLIENT = {
    HUB_CHAIN_ID: "11155111", HUB_CCTP_DOMAIN: "0", CLIENT_COUNT: "1",
    CLIENT_1_RPC: "https://c1", CLIENT_1_CHAIN_ID: "11155420", CLIENT_1_CCTP_DOMAIN: "2",
  };
  const { DEPLOYER_PRIVATE_KEY: _key, ...SEPOLIA_NO_KEY } = { ...SEPOLIA_BASE, ...ONE_CLIENT };

  // WHY: a Ledger deploy supplies no private key; the address alone satisfies the live-network
  // signer requirement, and no key may leak through for scripts that build a Wallet from it.
  it("accepts DEPLOYER_LEDGER_ADDRESS in place of DEPLOYER_PRIVATE_KEY", () => {
    const c = freshConfig({ ...SEPOLIA_NO_KEY, DEPLOYER_LEDGER_ADDRESS: LEDGER }).getNetworkConfig();
    expect(c.deployerLedgerAddress).to.equal(LEDGER);
    expect(c.deployerPrivateKey).to.equal("");
  });

  // WHY: a live deploy with no signer must fail at config load, naming both options.
  it("requires a key or a Ledger address on live networks", () => {
    expect(() => freshConfig(SEPOLIA_NO_KEY).getNetworkConfig())
      .to.throw(/DEPLOYER_PRIVATE_KEY or DEPLOYER_LEDGER_ADDRESS/);
  });

  // WHY: with both set Hardhat would sign with the key, not the Ledger the operator expects.
  it("refuses both a key and a Ledger address", () => {
    expect(() => freshConfig({ ...SEPOLIA_BASE, DEPLOYER_LEDGER_ADDRESS: LEDGER }).getNetworkConfig())
      .to.throw(/not both/);
  });

  // WHY: the key path is unchanged; deployerLedgerAddress stays unset.
  it("keeps the private-key path unchanged", () => {
    const c = freshConfig({ ...SEPOLIA_BASE, ...ONE_CLIENT }).getNetworkConfig();
    expect(c.deployerPrivateKey).to.equal(SEPOLIA_BASE.DEPLOYER_PRIVATE_KEY);
    expect(c.deployerLedgerAddress).to.equal(undefined);
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
    INITIAL_STEWARD_ADDRESS: TEST_STEWARD,
    CROWDFUND_OPEN_TIME: "2026-10-08T17:00:00Z", WINDDOWN_REVENUE_THRESHOLD: "10000",
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

describe("wind-down revenue threshold", () => {
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
    INITIAL_STEWARD_ADDRESS: TEST_STEWARD,
    WINDDOWN_DEADLINE: "2027-12-31T00:00:00Z", CROWDFUND_OPEN_TIME: "2026-10-08T17:00:00Z",
  };

  // WHY: once the deadline passes, recognized revenue below the threshold lets anyone
  // trigger the terminal wind-down; like the deadline, it must be chosen deliberately on
  // mainnet, never picked up from a silent default.
  it("requires WINDDOWN_REVENUE_THRESHOLD on mainnet", () => {
    expect(() => freshConfig(MAINNET_BASE).getNetworkConfig()).to.throw(/WINDDOWN_REVENUE_THRESHOLD/);
  });

  // WHY: an explicitly chosen mainnet threshold must reach the deploy script unchanged.
  it("uses the explicit WINDDOWN_REVENUE_THRESHOLD on mainnet", () => {
    const c = freshConfig({ ...MAINNET_BASE, WINDDOWN_REVENUE_THRESHOLD: "25000" }).getNetworkConfig();
    expect(c.windDownRevenueThreshold).to.equal("25000");
  });

  // WHY: local and testnet deploys keep working with no wind-down env set.
  it("defaults local and Sepolia to 10000", () => {
    expect(freshConfig({ DEPLOY_ENV: "local" }).getNetworkConfig().windDownRevenueThreshold)
      .to.equal("10000");
    expect(freshConfig({ ...SEPOLIA_BASE, ...ONE_CLIENT }).getNetworkConfig().windDownRevenueThreshold)
      .to.equal("10000");
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
    INITIAL_STEWARD_ADDRESS: TEST_STEWARD,
    WINDDOWN_DEADLINE: "2027-12-31T00:00:00Z", WINDDOWN_REVENUE_THRESHOLD: "10000",
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

describe("privacy pool treasury override", () => {
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
    INITIAL_STEWARD_ADDRESS: TEST_STEWARD,
    WINDDOWN_DEADLINE: "2027-12-31T00:00:00Z", CROWDFUND_OPEN_TIME: "2026-10-08T17:00:00Z",
    WINDDOWN_REVENUE_THRESHOLD: "10000",
  };
  const OVERRIDE = "0x0000000000000000000000000000000000000002";

  // WHY: the PrivacyPool fee recipient is fixed at initialize(). On mainnet it must be the
  // governance treasury; an override would divert all protocol fees outside governance
  // control for good, so the config must refuse it before any deploy step runs.
  it("refuses TREASURY_ADDRESS on mainnet", () => {
    expect(() => freshConfig({ ...MAINNET_BASE, TREASURY_ADDRESS: OVERRIDE }).getNetworkConfig())
      .to.throw(/TREASURY_ADDRESS/);
  });

  // WHY: an `export TREASURY_ADDRESS=` left blank (or whitespace) in an env file is not an
  // override and must not block a mainnet deploy.
  it("treats a blank TREASURY_ADDRESS on mainnet as unset", () => {
    for (const blank of ["", "  "]) {
      const c = freshConfig({ ...MAINNET_BASE, TREASURY_ADDRESS: blank }).getNetworkConfig();
      expect(c.treasuryAddress).to.equal("");
    }
  });

  // WHY: local and Sepolia keep the override (Sepolia sets one in sepolia.env).
  it("keeps the override on local and Sepolia", () => {
    expect(freshConfig({ DEPLOY_ENV: "local", TREASURY_ADDRESS: OVERRIDE }).getNetworkConfig().treasuryAddress)
      .to.equal(OVERRIDE);
    expect(freshConfig({ ...SEPOLIA_BASE, ...ONE_CLIENT, TREASURY_ADDRESS: OVERRIDE }).getNetworkConfig()
      .treasuryAddress).to.equal(OVERRIDE);
  });
});

describe("timelock harden profile", () => {
  afterEach(() => {
    clearManagedEnv();
    delete process.env.REVENUE_LOCK_BENEFICIARIES_JSON;
  });

  const MAINNET_BASE = {
    ...SEPOLIA_BASE, CLIENT_COUNT: "1",
    CLIENT_1_RPC: "https://c1", CLIENT_1_CHAIN_ID: "8453", CLIENT_1_CCTP_DOMAIN: "6",
    DEPLOY_ENV: "mainnet", CCTP_MODE: "real",
    INITIAL_STEWARD_ADDRESS: TEST_STEWARD,
    WINDDOWN_DEADLINE: "2027-12-31T00:00:00Z", CROWDFUND_OPEN_TIME: "2026-10-08T17:00:00Z",
    WINDDOWN_REVENUE_THRESHOLD: "10000",
  };

  // WHY: without the harden profile the deployer never holds timelock roles, so the crowdfund
  // step's first timelock-only call reverts after its one-shot initializers are spent — an
  // interrupted launch. Mainnet must refuse before any step runs, not warn.
  it("refuses HARDEN_TIMELOCK=false on mainnet", () => {
    for (const off of ["false", "0"]) {
      expect(() => freshConfig({ ...MAINNET_BASE, HARDEN_TIMELOCK: off }).getNetworkConfig())
        .to.throw(/HARDEN_TIMELOCK/);
    }
  });

  // WHY: mainnet hardens by default, so leaving the variable unset must still deploy.
  it("hardens mainnet when HARDEN_TIMELOCK is unset or true", () => {
    expect(freshConfig(MAINNET_BASE).getNetworkConfig().hardenTimelock).to.equal(true);
    expect(freshConfig({ ...MAINNET_BASE, HARDEN_TIMELOCK: "true" }).getNetworkConfig().hardenTimelock)
      .to.equal(true);
  });

  // WHY: local and Sepolia ops deploys keep the deployer's timelock roles; only the #319
  // dry-run opts in to hardening there.
  it("keeps hardening opt-in on local and Sepolia", () => {
    expect(freshConfig({ DEPLOY_ENV: "local" }).getNetworkConfig().hardenTimelock).to.equal(false);
    expect(freshConfig({ ...SEPOLIA_BASE, CLIENT_COUNT: "1", CLIENT_1_RPC: "https://c1",
      CLIENT_1_CHAIN_ID: "84532", CLIENT_1_CCTP_DOMAIN: "6", HARDEN_TIMELOCK: "false" })
      .getNetworkConfig().hardenTimelock).to.equal(false);
  });
});

describe("RevenueLock max revenue increase per day", () => {
  afterEach(clearManagedEnv);

  // WHY: the ratchet rate cap is an immutable RevenueLock constructor input; the spec value
  // ($10k/day, issue #225: >= 100 days for a malicious $0 -> $1M unlock) must be the default.
  it("defaults to the $10,000/day spec value in whole USD", () => {
    const c = freshConfig({ DEPLOY_ENV: "local" }).getNetworkConfig();
    expect(c.revenueLockMaxIncreasePerDayUsd).to.equal("10000");
  });

  // WHY: an explicitly configured cap must reach the deploy scripts unchanged.
  it("uses an explicit REVENUE_LOCK_MAX_INCREASE_PER_DAY_USD", () => {
    const c = freshConfig({ DEPLOY_ENV: "local", REVENUE_LOCK_MAX_INCREASE_PER_DAY_USD: "5000" })
      .getNetworkConfig();
    expect(c.revenueLockMaxIncreasePerDayUsd).to.equal("5000");
  });

  // WHY: the value is whole USD, scaled to 18 decimals at deploy. A pre-scaled entry (10000e18)
  // or one above the $1M full-unlock milestone disables the cap, and zero freezes every unlock;
  // RevenueLock has no setter, so these must fail before deploy rather than on-chain.
  for (const bad of ["0", "10000.5", "1e22", "10000000000000000000000", "1000001", "-10000", "$10000"]) {
    it(`rejects "${bad}"`, () => {
      expect(() => freshConfig({ DEPLOY_ENV: "local", REVENUE_LOCK_MAX_INCREASE_PER_DAY_USD: bad })
        .getNetworkConfig()).to.throw(/REVENUE_LOCK_MAX_INCREASE_PER_DAY_USD/);
    });
  }
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

describe("initial steward and USDC steward budget", () => {
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
    WINDDOWN_DEADLINE: "2027-12-31T00:00:00Z", CROWDFUND_OPEN_TIME: "2026-10-08T17:00:00Z",
    WINDDOWN_REVENUE_THRESHOLD: "10000",
  };

  // WHY: the steward is elected and funded at deploy only when explicitly configured; local
  // and Sepolia stacks without INITIAL_STEWARD_ADDRESS keep the governance-elected path.
  it("defaults local and Sepolia to no initial steward", () => {
    expect(freshConfig({ DEPLOY_ENV: "local" }).getNetworkConfig().initialSteward).to.equal(undefined);
    expect(freshConfig({ ...SEPOLIA_BASE, ...ONE_CLIENT }).getNetworkConfig().initialSteward).to.equal(undefined);
  });

  // WHY: GOVERNANCE.md §Treasury Steward sets the launch budget at $60,000 per rolling 30 days;
  // a configured steward must get exactly that budget when the budget env is omitted.
  it("defaults the budget to the $60,000 / 30-day spec value", () => {
    const c = freshConfig({ DEPLOY_ENV: "local", INITIAL_STEWARD_ADDRESS: TEST_STEWARD }).getNetworkConfig();
    expect(c.initialSteward).to.deep.equal({ address: TEST_STEWARD, budgetUsdc: "60000", budgetWindow: 2592000 });
  });

  // WHY: explicitly configured values must reach the deploy scripts unchanged.
  it("uses an explicit budget and window", () => {
    const c = freshConfig({
      DEPLOY_ENV: "local", INITIAL_STEWARD_ADDRESS: TEST_STEWARD,
      STEWARD_BUDGET_USDC: "25000", STEWARD_BUDGET_WINDOW: "604800",
    }).getNetworkConfig();
    expect(c.initialSteward).to.deep.equal({ address: TEST_STEWARD, budgetUsdc: "25000", budgetWindow: 604800 });
  });

  // WHY: the launch elects the steward at deploy; a mainnet run that forgot the address would
  // silently skip the election and the budget, so the config must refuse to build.
  it("requires INITIAL_STEWARD_ADDRESS on mainnet", () => {
    expect(() => freshConfig(MAINNET_BASE).getNetworkConfig()).to.throw(/INITIAL_STEWARD_ADDRESS/);
  });

  // WHY: a budget without a steward is spending authority nobody can use, and almost always
  // means the address was dropped from the env by mistake.
  for (const key of ["STEWARD_BUDGET_USDC", "STEWARD_BUDGET_WINDOW"]) {
    it(`refuses ${key} without INITIAL_STEWARD_ADDRESS`, () => {
      expect(() => freshConfig({ DEPLOY_ENV: "local", [key]: "60000" }).getNetworkConfig())
        .to.throw(/STEWARD_BUDGET_\* is set but INITIAL_STEWARD_ADDRESS is not/);
    });
  }

  // WHY: the steward address is a deploy input with no later setter short of an Extended
  // governance proposal; a malformed or zero address must fail before any transaction.
  for (const bad of ["0x123", "not-an-address", "0x0000000000000000000000000000000000000000"]) {
    it(`rejects the steward address "${bad}"`, () => {
      expect(() => freshConfig({ DEPLOY_ENV: "local", INITIAL_STEWARD_ADDRESS: bad }).getNetworkConfig())
        .to.throw(/INITIAL_STEWARD_ADDRESS/);
    });
  }

  // WHY: the budget is whole USD, scaled by USDC's 6 decimals at deploy. A pre-scaled entry
  // (60000000000) or anything above the $100,000 USDC outflow absolute limit is a units mistake
  // that would hand the steward a far larger budget than the spec; zero is no budget at all.
  for (const bad of ["0", "60000.5", "6e4", "60000000000", "100001", "-60000", "$60000"]) {
    it(`rejects the budget "${bad}"`, () => {
      expect(() => freshConfig({
        DEPLOY_ENV: "local", INITIAL_STEWARD_ADDRESS: TEST_STEWARD, STEWARD_BUDGET_USDC: bad,
      }).getNetworkConfig()).to.throw(/STEWARD_BUDGET_USDC/);
    });
  }

  // WHY: addStewardBudgetToken reverts below a 1-day window; catching it in config keeps the
  // revert from landing mid-deploy after one-shot initializers are spent.
  for (const bad of ["0", "86399", "30d", "2592000.5"]) {
    it(`rejects the window "${bad}"`, () => {
      expect(() => freshConfig({
        DEPLOY_ENV: "local", INITIAL_STEWARD_ADDRESS: TEST_STEWARD, STEWARD_BUDGET_WINDOW: bad,
      }).getNetworkConfig()).to.throw(/STEWARD_BUDGET_WINDOW/);
    });
  }
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
      INITIAL_STEWARD_ADDRESS: TEST_STEWARD,
    });
    expect(() => validateCCTPConfig("hub")).to.not.throw();
  });

  // WHY: the freeze sheet (PARAMETER_MANIFEST.md §8.2) reads the ratchet rate cap from the
  // committed template; it must state the spec value explicitly, in whole USD (#530).
  it("sets the RevenueLock max revenue increase to the $10,000/day spec value", () => {
    expect(MAINNET_ENV.REVENUE_LOCK_MAX_INCREASE_PER_DAY_USD).to.equal("10000");
  });

  // WHY: the freeze sheet (PARAMETER_MANIFEST.md §8.2) reads the wind-down threshold from the
  // committed template; it must state the $10,000 spec value (GOVERNANCE.md §Wind-Down), in
  // whole USD (#550).
  it("sets the wind-down revenue threshold to the $10,000 spec value", () => {
    expect(MAINNET_ENV.WINDDOWN_REVENUE_THRESHOLD).to.equal("10000");
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
      INITIAL_STEWARD_ADDRESS: TEST_STEWARD,
    }).getNetworkConfig();
    expect(c.outflowConfig).to.deep.equal(SPEC_OUTFLOW);
  });

  // WHY: the freeze sheet (PARAMETER_MANIFEST.md §8.2) reads the steward budget from the
  // committed template; it must state the GOVERNANCE.md spec values explicitly (#222).
  it("sets the USDC steward budget to the $60,000 / 30-day spec value", () => {
    expect(MAINNET_ENV.STEWARD_BUDGET_USDC).to.equal("60000");
    expect(MAINNET_ENV.STEWARD_BUDGET_WINDOW).to.equal("2592000");
  });

  // WHY: on mainnet the pool fee recipient must default to ArmadaTreasuryGov; the template
  // must not carry an override (the config would refuse it and abort the launch).
  it("leaves TREASURY_ADDRESS unset", () => {
    expect(MAINNET_ENV).to.not.have.property("TREASURY_ADDRESS");
  });
});

describe("env templates keep a private RPC from secrets.env", () => {
  /**
   * Source a committed env template in bash with `preset` already exported (as secrets.env
   * would have done) and return the resulting values of `keys`. Runs from a temp dir holding
   * only the template, so a developer's real config/secrets.env is never sourced.
   */
  function sourceTemplate(file: string, preset: Record<string, string>, keys: string[]): Record<string, string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-template-"));
    try {
      fs.mkdirSync(path.join(dir, "config"));
      fs.copyFileSync(path.join(__dirname, file), path.join(dir, "config", file));
      const script = `source config/${file} >/dev/null; ` + keys.map((k) => `echo "${k}=$${k}"`).join("; ");
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...preset };
      const out = execFileSync("bash", ["-c", script], { cwd: dir, env, encoding: "utf8" });
      return Object.fromEntries(out.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const RPC_KEYS = ["HUB_RPC", "CLIENT_1_RPC", "CLIENT_2_RPC"];

  for (const file of ["mainnet.env", "sepolia.env"]) {
    // WHY: the templates source secrets.env first; an unconditional `export HUB_RPC=<public>`
    // afterwards silently replaced the operator's private (keyed) RPC, so the mainnet deploy
    // ran over the rate-limited public endpoint (#556).
    it(`${file} keeps RPC URLs that were already set`, () => {
      const preset = Object.fromEntries(RPC_KEYS.map((k) => [k, `https://private.example/${k}`]));
      expect(sourceTemplate(file, preset, RPC_KEYS)).to.deep.equal(preset);
    });

    // WHY: without a private RPC the public fallbacks must still apply.
    it(`${file} falls back to public RPC URLs when none are set`, () => {
      const values = sourceTemplate(file, {}, RPC_KEYS);
      for (const k of RPC_KEYS) expect(values[k], k).to.match(/^https:\/\//);
    });
  }
});

