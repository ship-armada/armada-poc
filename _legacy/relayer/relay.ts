import { ethers } from "ethers";
import {
  ChainConfig,
  allChains,
  accounts,
  relayerSettings,
} from "./config";
import * as fs from "fs";
import * as path from "path";

/**
 * Multi-Chain CCTP Relayer
 *
 * Watches for BurnForDeposit events on all chains and relays them to the
 * destination chain by calling receiveMessage().
 *
 * Supports N client chains connecting to a single hub:
 *   Client A → Hub (Shield)
 *   Client B → Hub (Shield)
 *   Hub → Client A (Unshield)
 *   Hub → Client B (Unshield)
 */

// ============ Types ============

interface BurnEvent {
  nonce: bigint;
  sender: string;
  amount: bigint;
  destinationChainId: number;
  destinationAddress: string;
  payload: string;
  txHash: string;
  blockNumber: number;
  sourceChainId: number;
}

interface ChainState {
  config: ChainConfig;
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  mockUSDCAddress: string;
  lastProcessedBlock: number;
  processedNonces: Set<string>; // "chainId-nonce" format
  pendingNonce: number | null; // Track next nonce to use for this chain
}

// ============ ABIs ============

const BURN_EVENT_ABI = [
  "event BurnForDeposit(uint64 indexed nonce, address indexed sender, uint256 amount, uint32 destinationChainId, address destinationAddress, bytes payload)",
];

const MOCK_USDC_ABI = [
  "function receiveMessage(uint32 sourceChainId, uint64 sourceNonce, address recipient, uint256 amount, bytes calldata payload) external",
  "function relayer() view returns (address)",
];

// ============ Deployment Loading ============

function loadDeployment(filename: string): any | null {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const filePath = path.join(deploymentsDir, filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// ============ Event Parsing ============

function parseBurnEvent(log: ethers.Log, sourceChainId: number): BurnEvent | null {
  try {
    const iface = new ethers.Interface(BURN_EVENT_ABI);
    const parsed = iface.parseLog({
      topics: log.topics as string[],
      data: log.data,
    });

    if (!parsed) return null;

    return {
      nonce: parsed.args.nonce,
      sender: parsed.args.sender,
      amount: parsed.args.amount,
      destinationChainId: Number(parsed.args.destinationChainId),
      destinationAddress: parsed.args.destinationAddress,
      payload: parsed.args.payload,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      sourceChainId,
    };
  } catch (e) {
    console.error(`Failed to parse burn event: ${e}`);
    return null;
  }
}

// ============ Multi-Chain Relayer Class ============

class MultiChainRelayer {
  private chains: Map<number, ChainState> = new Map();
  private isRunning: boolean = false;

  /**
   * Initialize all chains from config
   */
  async initialize(): Promise<boolean> {
    console.log("Initializing Multi-Chain Relayer...\n");

    let allInitialized = true;

    for (const chainConfig of allChains) {
      const state = await this.initChain(chainConfig);
      if (state) {
        this.chains.set(chainConfig.chainId, state);
        console.log(
          `  ✓ ${chainConfig.name} (${chainConfig.chainId}): ${chainConfig.rpc}`
        );
        console.log(`    MockUSDC: ${state.mockUSDCAddress}`);
      } else {
        console.log(
          `  ✗ ${chainConfig.name} (${chainConfig.chainId}): Failed to initialize`
        );
        allInitialized = false;
      }
    }

    console.log(`\nInitialized ${this.chains.size}/${allChains.length} chains`);
    return allInitialized;
  }

  /**
   * Initialize a single chain
   */
  private async initChain(chainConfig: ChainConfig): Promise<ChainState | null> {
    try {
      // Load deployment file
      const deployment = loadDeployment(chainConfig.deploymentFile);
      if (!deployment) {
        console.error(
          `    Deployment file not found: ${chainConfig.deploymentFile}`
        );
        return null;
      }

      const mockUSDCAddress = deployment.contracts.mockUSDC;
      if (!mockUSDCAddress) {
        console.error(`    MockUSDC address not found in deployment`);
        return null;
      }

      // Setup provider and wallet
      const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
      const wallet = new ethers.Wallet(accounts.deployer.privateKey, provider);

      // Verify connection
      await provider.getBlockNumber();

      return {
        config: chainConfig,
        provider,
        wallet,
        mockUSDCAddress,
        lastProcessedBlock: 0,
        processedNonces: new Set(),
        pendingNonce: null,
      };
    } catch (e: any) {
      console.error(`    Connection error: ${e.message}`);
      return null;
    }
  }

  /**
   * Get chain state by ID
   */
  private getChain(chainId: number): ChainState | undefined {
    return this.chains.get(chainId);
  }

  /**
   * Relay a burn event to the destination chain
   */
  private async relayBurn(event: BurnEvent, sourceState: ChainState): Promise<boolean> {
    const nonceKey = `${event.sourceChainId}-${event.nonce}`;

    // Check if already processed
    if (sourceState.processedNonces.has(nonceKey)) {
      return false;
    }

    // Get destination chain
    const destState = this.getChain(event.destinationChainId);
    if (!destState) {
      console.log(
        `  Unknown destination chain ${event.destinationChainId}, skipping`
      );
      return false;
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `RELAYING: ${sourceState.config.name} → ${destState.config.name}`
    );
    console.log(`${"=".repeat(60)}`);
    console.log(`  Nonce:       ${event.nonce}`);
    console.log(`  Sender:      ${event.sender}`);
    console.log(`  Amount:      ${ethers.formatUnits(event.amount, 6)} USDC`);
    console.log(`  Destination: ${event.destinationAddress}`);
    console.log(`  Payload:     ${event.payload.length} bytes`);
    console.log(`  Source Tx:   ${event.txHash}`);

    try {
      // Get MockUSDC contract on destination chain
      const mockUSDC = new ethers.Contract(
        destState.mockUSDCAddress,
        MOCK_USDC_ABI,
        destState.wallet
      );

      // Get or initialize the nonce for the destination chain
      if (destState.pendingNonce === null) {
        destState.pendingNonce = await destState.provider.getTransactionCount(
          destState.wallet.address,
          "pending"
        );
        console.log(`  Initialized nonce for ${destState.config.name}: ${destState.pendingNonce}`);
      }

      const nonce = destState.pendingNonce;

      // Call receiveMessage with explicit nonce
      console.log(`\n  Sending receiveMessage to ${destState.config.name} (nonce: ${nonce})...`);
      const tx = await mockUSDC.receiveMessage(
        event.sourceChainId,
        event.nonce,
        event.destinationAddress,
        event.amount,
        event.payload,
        { nonce }
      );

      // Increment nonce immediately after sending (before waiting for confirmation)
      destState.pendingNonce = nonce + 1;

      console.log(`  Tx hash: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt?.blockNumber}`);

      // Mark as processed
      sourceState.processedNonces.add(nonceKey);

      console.log(`  ✓ Relay successful`);
      return true;
    } catch (e: any) {
      if (e.message?.includes("Nonce already processed")) {
        console.log(`  Already processed on-chain, marking as done`);
        sourceState.processedNonces.add(nonceKey);
        return false;
      }
      // If nonce error, reset to fetch fresh nonce next time
      if (e.message?.includes("nonce") || e.message?.includes("NONCE")) {
        console.log(`  Nonce error detected, will refresh nonce on next attempt`);
        destState.pendingNonce = null;
      }
      console.error(`  ✗ Relay failed: ${e.message || e}`);
      return false;
    }
  }

  /**
   * Poll a chain for new burn events
   */
  private async pollChain(state: ChainState): Promise<void> {
    try {
      const currentBlock = await state.provider.getBlockNumber();

      // On first run, start from current block
      if (state.lastProcessedBlock === 0) {
        state.lastProcessedBlock = currentBlock;
        console.log(
          `  ${state.config.name}: Starting from block ${currentBlock}`
        );
        return;
      }

      // Skip if no new blocks
      if (currentBlock <= state.lastProcessedBlock) {
        return;
      }

      const fromBlock = state.lastProcessedBlock + 1;
      const toBlock = currentBlock;

      // Get burn event topic
      const iface = new ethers.Interface(BURN_EVENT_ABI);
      const eventTopic = iface.getEvent("BurnForDeposit")?.topicHash;

      if (!eventTopic) {
        console.error("Failed to get BurnForDeposit event topic");
        return;
      }

      // Fetch logs
      const logs = await state.provider.getLogs({
        address: state.mockUSDCAddress,
        topics: [eventTopic],
        fromBlock,
        toBlock,
      });

      if (logs.length > 0) {
        console.log(
          `\n${state.config.name}: Found ${logs.length} burn event(s) in blocks ${fromBlock}-${toBlock}`
        );
      }

      // Process each event
      for (const log of logs) {
        const event = parseBurnEvent(log, state.config.chainId);
        if (event) {
          await this.relayBurn(event, state);
        }
      }

      state.lastProcessedBlock = currentBlock;
    } catch (e) {
      console.error(`Error polling ${state.config.name}: ${e}`);
    }
  }

  /**
   * Main polling loop
   */
  async start(): Promise<void> {
    // Build chains summary
    const chainsSummary = Array.from(this.chains.values())
      .map((s) => `  ${s.config.name}: ${s.config.rpc} (ID: ${s.config.chainId})`)
      .join("\n");

    const contractsSummary = Array.from(this.chains.values())
      .map((s) => `  ${s.config.name} MockUSDC: ${s.mockUSDCAddress}`)
      .join("\n");

    console.log(`
${"=".repeat(60)}
  MULTI-CHAIN CCTP RELAYER STARTED
${"=".repeat(60)}

Chains (${this.chains.size}):
${chainsSummary}

Contracts:
${contractsSummary}

Poll Interval: ${relayerSettings.pollIntervalMs}ms
Relayer Wallet: ${accounts.deployer.address}

Watching for BurnForDeposit events on all chains...
`);

    this.isRunning = true;

    while (this.isRunning) {
      // Poll all chains
      for (const state of this.chains.values()) {
        await this.pollChain(state);
      }

      // Wait before next poll
      await new Promise((resolve) =>
        setTimeout(resolve, relayerSettings.pollIntervalMs)
      );
    }
  }

  /**
   * Stop the relayer
   */
  stop(): void {
    console.log("\nStopping relayer...");
    this.isRunning = false;
  }
}

// ============ Main ============

async function main() {
  // Load .env if present
  try {
    const dotenv = await import("dotenv");
    dotenv.config();
  } catch {
    // dotenv not required if using deployment files
  }

  const relayer = new MultiChainRelayer();

  // Initialize all chains
  const success = await relayer.initialize();
  if (!success) {
    console.error("\nFailed to initialize all chains. Some chains may be missing deployments.");
    console.error("Run 'npm run setup' to deploy all contracts.\n");
    // Continue anyway - allow partial operation for testing
  }

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    relayer.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    relayer.stop();
    process.exit(0);
  });

  await relayer.start();
}

main().catch((e) => {
  console.error("Relayer error:", e);
  process.exit(1);
});
