// ABOUTME: Unit tests for the N-client network config — pins the indexed CLIENT_<n>_* env
// ABOUTME: scheme, client ordering, role/domain/chainId lookups, and CCTP address merging.

import { expect } from "chai";

// Env keys the config reads that a test might set — cleared between tests so one case
// can't leak chain topology into the next (getNetworkConfig caches, so we also re-require).
const MANAGED_PREFIXES = ["CLIENT_", "HUB_", "CCTP_", "DEPLOY_ENV", "DEPLOYER_PRIVATE_KEY",
  "REVENUE_LOCK_", "TREASURY_ADDRESS", "SECURITY_COUNCIL_ADDRESS", "LAUNCH_TEAM_ADDRESS"];

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
