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

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.17",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      accounts: { count: 200 },
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
    // Client Chain A
    client: {
      url: process.env.CLIENT_A_RPC || process.env.CLIENT_RPC || "http://localhost:8546",
      chainId: 31338,
      accounts: [ANVIL_KEY],
    },
    // Client Chain B
    clientB: {
      url: process.env.CLIENT_B_RPC || "http://localhost:8547",
      chainId: 31339,
      accounts: [ANVIL_KEY],
    },

    // ========== Sepolia Testnet Networks ==========

    // Hub: Ethereum Sepolia
    sepoliaHub: {
      url: process.env.HUB_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    // Client A: Base Sepolia
    sepoliaClientA: {
      url: process.env.CLIENT_A_RPC || "https://sepolia.base.org",
      chainId: 84532,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    // Client B: Arbitrum Sepolia
    sepoliaClientB: {
      url: process.env.CLIENT_B_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
