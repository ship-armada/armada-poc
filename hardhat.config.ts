import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";
import "./tasks/governance";
import "./tasks/crowdfund";

// Anvil default account private key (Account 0)
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Anvil/Hardhat default mnemonic (derives 200 accounts including ANVIL_KEY as account 0)
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

// Deployer key: use env var for testnets, Anvil default for local
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || ANVIL_KEY;

// Client networks are generated from the indexed CLIENT_<n>_* env scheme (CLIENT_COUNT clients),
// mirroring config/networks.ts so adding a client needs no manual network entry. Each client i
// yields three entries — client<i> (local), sepoliaClient<i>, mainnetClient<i> — all reading the
// same CLIENT_<i>_RPC / CLIENT_<i>_CHAIN_ID (only one env file is sourced at a time, so the chainId
// matches the selected environment). sepolia/mainnet gasMultiplier is 2.0/1.2 for the same reason
// as the hub networks below (public-RPC eth_estimateGas underestimates refund-heavy SSTOREs).
function buildClientNetworks(): Record<string, any> {
  const localDefaults: Array<{ rpc: string; chainId: number }> = [
    { rpc: "http://localhost:8546", chainId: 31338 },
    { rpc: "http://localhost:8547", chainId: 31339 },
  ];
  const count = parseInt(process.env.CLIENT_COUNT || "2", 10);
  const nets: Record<string, any> = {};
  for (let i = 1; i <= count; i++) {
    const def = localDefaults[i - 1];
    const rpc = process.env[`CLIENT_${i}_RPC`];
    const chainIdEnv = process.env[`CLIENT_${i}_CHAIN_ID`];
    const chainId = chainIdEnv ? parseInt(chainIdEnv, 10) : def?.chainId;

    nets[`client${i}`] = {
      url: rpc || def?.rpc || "http://localhost:8546",
      chainId,
      accounts: [ANVIL_KEY],
    };
    nets[`sepoliaClient${i}`] = {
      url: rpc || "",
      chainId,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
      gasMultiplier: 2.0,
    };
    nets[`mainnetClient${i}`] = {
      url: rpc || "",
      chainId,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
      gasMultiplier: 1.2,
    };
  }
  return nets;
}

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.17",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      {
        // Audit-scope (governance + crowdfund) compiles with 0.8.20 + shanghai
        // to enable PUSH0 codegen, freeing bytecode in the size-constrained governor.
        // Out-of-scope contracts (Railgun internals, privacy pool, yield) remain on
        // 0.8.17 per the project pin in CLAUDE.md.
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "shanghai",
        },
      },
    ],
    overrides: {
      "contracts/governance/ArmadaGovernor.sol": {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "shanghai",
        },
      },
      "contracts/governance/AdapterRegistry.sol":      { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/ArmadaRedemption.sol":     { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/ArmadaToken.sol":          { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/ArmadaTreasuryGov.sol":    { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/ArmadaWindDown.sol":       { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/IArmadaGovernance.sol":    { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/IFeeCollector.sol":        { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/IShieldPauseController.sol": { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/MockAdapterRegistry.sol":  { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/MockFeeCollector.sol":     { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/MockRedemptionDeps.sol":   { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/ProxyImports.sol":         { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/RevenueCounter.sol":       { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/RevenueLock.sol":          { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/ShieldPauseController.sol": { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/governance/TreasurySteward.sol":      { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/crowdfund/ArmadaCrowdfund.sol":       { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
      "contracts/crowdfund/IArmadaCrowdfund.sol":      { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
    },
  },
  networks: {
    hardhat: {
      accounts: { count: 200 },
      allowUnlimitedContractSize: true,
    },

    // ========== Local Anvil Networks ==========

    // Hub Chain (uses 31337 and port 8545 to match Railgun SDK's Hardhat network config)
    // Uses mnemonic to derive 200 accounts for populate script; account 0 matches ANVIL_KEY.
    hub: {
      url: process.env.HUB_RPC || "http://localhost:8545",
      chainId: 31337,
      accounts: {
        mnemonic: ANVIL_MNEMONIC,
        count: 200,
      },
    },
    // Client networks (client<i>, sepoliaClient<i>, mainnetClient<i>) are generated from
    // CLIENT_COUNT below via buildClientNetworks().

    // ========== Sepolia Testnet Networks ==========

    // Hub: Ethereum Sepolia
    // gasMultiplier 2.0 (not 1.2): public testnet RPCs underestimate eth_estimateGas for
    // refund-heavy SSTOREs (clearing a slot to zero), leaving < 2300 gas at the EIP-2200
    // sentry and OOG-reverting admin calls like governor.clearDeployer() / renounceRole().
    // The extra headroom is unused on success (only actual gasUsed is charged), so it's safe.
    sepoliaHub: {
      url: process.env.HUB_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
      gasMultiplier: 2.0,
    },
    // Client networks (sepoliaClient<i>) are generated from CLIENT_COUNT via buildClientNetworks().

    // ========== Mainnet Networks ==========
    // Production. RPC must be supplied via env (HUB_RPC / CLIENT_<i>_RPC);
    // the public fallbacks are last-resort defaults, not production endpoints.
    // The crowdfund/governance launch is hub-only — clients are for the later
    // shielded-pool deployment.

    // Hub: Ethereum mainnet
    mainnetHub: {
      url: process.env.HUB_RPC || "https://ethereum-rpc.publicnode.com",
      chainId: 1,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
      gasMultiplier: 1.2,
    },
    // Client networks (mainnetClient<i>) are generated from CLIENT_COUNT via buildClientNetworks().

    // Generated client networks: client<i> (local), sepoliaClient<i>, mainnetClient<i>.
    ...buildClientNetworks(),
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  // Etherscan verification (V2 API) — only active when ETHERSCAN_API_KEY is set.
  // Uses a single API key for all networks per Etherscan V2 migration.
  ...(process.env.ETHERSCAN_API_KEY && {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY,
    },
  }),
};

export default config;
