import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

// Anvil default account private key (Account 0)
const DEPLOYER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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
    // Hub Chain (uses 31337 and port 8545 to match Railgun SDK's Hardhat network config)
    hub: {
      url: process.env.HUB_RPC || "http://localhost:8545",
      chainId: 31337,
      accounts: [DEPLOYER_PRIVATE_KEY],
    },
    // Client Chain A
    client: {
      url: process.env.CLIENT_RPC || "http://localhost:8546",
      chainId: 31338,
      accounts: [DEPLOYER_PRIVATE_KEY],
    },
    // Client Chain B
    clientB: {
      url: process.env.CLIENT_B_RPC || "http://localhost:8547",
      chainId: 31339,
      accounts: [DEPLOYER_PRIVATE_KEY],
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
