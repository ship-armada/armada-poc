/**
 * DEPRECATED: Use armada-relayer.ts. This file is kept for reference only.
 * npm run relayer now runs armada-relayer (CCTP + Privacy Relay + HTTP API).
 */

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
 * CCTP V2 Relayer
 *
 * Simulates Circle's attestation service for local testing.
 * Watches for MessageSent events from MockMessageTransmitterV2 and relays
 * them to the destination chain by calling receiveMessage() with the full
 * MessageV2 format (same as real CCTP V2).
 *
 * This mimics the real CCTP V2 flow:
 *   1. TokenMessengerV2.depositForBurnWithHook() emits MessageSent
 *   2. Circle attesters sign the message (simulated by this relayer)
 *   3. Anyone calls MessageTransmitterV2.receiveMessage() with attestation
 *   4. MessageTransmitter calls TokenMessenger.handleReceiveMessage()
 *   5. TokenMessenger mints and calls recipient.handleReceiveFinalizedMessage()
 *
 * MessageV2 Format (124+ bytes):
 *   | Field                     | Bytes | Offset |
 *   |---------------------------|-------|--------|
 *   | version                   | 4     | 0      |
 *   | sourceDomain              | 4     | 4      |
 *   | destinationDomain         | 4     | 8      |
 *   | nonce                     | 8     | 12     |
 *   | sender                    | 32    | 20     |
 *   | recipient                 | 32    | 52     |
 *   | destinationCaller         | 32    | 84     |
 *   | minFinalityThreshold      | 4     | 116    |
 *   | finalityThresholdExecuted | 4     | 120    |
 *   | messageBody               | var   | 124    |
 *
 * Domain ID mapping:
 *   - Local Hub: 100
 *   - Local Client A: 101
 *   - Local Client B: 102
 */

// ============ Constants ============

// MessageV2 version number
const MESSAGE_VERSION = 1;

// Finality threshold for standard finality
const FINALITY_STANDARD = 2000;

// ============ Types ============

interface MessageEvent {
  nonce: bigint;
  sourceDomain: number;
  destinationDomain: number;
  sender: string;
  recipient: string;
  destinationCaller: string;
  minFinalityThreshold: number;
  messageBody: string;
  txHash: string;
  blockNumber: number;
}

interface ChainState {
  config: ChainConfig;
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  messageTransmitter: string;
  tokenMessenger: string;
  domain: number;
  lastProcessedBlock: number;
  processedMessages: Set<string>; // "sourceDomain-nonce" format
  pendingNonce: number | null;
}

// ============ ABIs ============

// Updated MessageSent event to include minFinalityThreshold
const MESSAGE_SENT_ABI = [
  "event MessageSent(uint64 indexed nonce, uint32 indexed sourceDomain, uint32 indexed destinationDomain, bytes32 sender, bytes32 recipient, bytes32 destinationCaller, uint32 minFinalityThreshold, bytes messageBody)",
];

// Updated to use receiveMessage (real CCTP V2 interface)
const MESSAGE_TRANSMITTER_ABI = [
  "function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool)",
  "function relayer() view returns (address)",
  "function localDomain() view returns (uint32)",
];

// ============ Domain Mapping ============

// Maps EVM chain IDs to CCTP domain IDs
const CHAIN_TO_DOMAIN: Record<number, number> = {
  31337: 100, // Hub
  31338: 101, // Client A
  31339: 102, // Client B
};

const DOMAIN_TO_CHAIN: Record<number, number> = {
  100: 31337,
  101: 31338,
  102: 31339,
};

// ============ Deployment Loading ============

interface DeploymentV3 {
  chainId: number;
  domain: number;
  contracts: {
    usdc: string;
    messageTransmitter: string;
    tokenMessenger: string;
    // Optional - only on hub
    hubCCTPReceiver?: string;
    hubUnshieldProxy?: string;
    railgunProxy?: string;
    // Optional - only on clients
    clientShieldProxy?: string;
  };
}

function loadDeploymentV3(filename: string): DeploymentV3 | null {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const filePath = path.join(deploymentsDir, filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// ============ Message Encoding ============

/**
 * Encode a full MessageV2 from event data
 *
 * This constructs the exact byte layout that the mock MessageTransmitterV2
 * expects in receiveMessage(). The format matches real CCTP V2.
 */
function encodeMessageV2(event: MessageEvent): string {
  // Use ethers.solidityPacked to match Solidity's abi.encodePacked
  const encoded = ethers.solidityPacked(
    [
      "uint32",  // version
      "uint32",  // sourceDomain
      "uint32",  // destinationDomain
      "uint64",  // nonce
      "bytes32", // sender
      "bytes32", // recipient
      "bytes32", // destinationCaller
      "uint32",  // minFinalityThreshold
      "uint32",  // finalityThresholdExecuted
      "bytes",   // messageBody
    ],
    [
      MESSAGE_VERSION,
      event.sourceDomain,
      event.destinationDomain,
      event.nonce,
      event.sender,
      event.recipient,
      event.destinationCaller,
      event.minFinalityThreshold,
      FINALITY_STANDARD, // finalityThresholdExecuted - we always use standard finality
      event.messageBody,
    ]
  );

  return encoded;
}

// ============ Event Parsing ============

function parseMessageEvent(log: ethers.Log, sourceChainId: number): MessageEvent | null {
  try {
    const iface = new ethers.Interface(MESSAGE_SENT_ABI);
    const parsed = iface.parseLog({
      topics: log.topics as string[],
      data: log.data,
    });

    if (!parsed) return null;

    return {
      nonce: parsed.args.nonce,
      sourceDomain: Number(parsed.args.sourceDomain),
      destinationDomain: Number(parsed.args.destinationDomain),
      sender: parsed.args.sender,
      recipient: parsed.args.recipient,
      destinationCaller: parsed.args.destinationCaller,
      minFinalityThreshold: Number(parsed.args.minFinalityThreshold),
      messageBody: parsed.args.messageBody,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    };
  } catch (e) {
    console.error(`Failed to parse message event: ${e}`);
    return null;
  }
}

// ============ Multi-Chain Relayer Class ============

class CCTPV2Relayer {
  private chains: Map<number, ChainState> = new Map(); // Keyed by domain ID
  private isRunning: boolean = false;

  /**
   * Initialize all chains from config
   */
  async initialize(): Promise<boolean> {
    console.log("Initializing CCTP V2 Relayer...\n");

    let allInitialized = true;

    // Map deployment files to chain configs
    const deploymentFiles: Record<number, string> = {
      31337: "hub-v3.json",
      31338: "client-v3.json",
      31339: "clientB-v3.json",
    };

    for (const chainConfig of allChains) {
      const deploymentFile = deploymentFiles[chainConfig.chainId];
      if (!deploymentFile) {
        console.log(`  ✗ No deployment file mapping for chain ${chainConfig.chainId}`);
        continue;
      }

      const state = await this.initChain(chainConfig, deploymentFile);
      if (state) {
        this.chains.set(state.domain, state);
        console.log(
          `  ✓ ${chainConfig.name} (Chain ${chainConfig.chainId}, Domain ${state.domain})`
        );
        console.log(`    MessageTransmitter: ${state.messageTransmitter}`);
        console.log(`    TokenMessenger: ${state.tokenMessenger}`);
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
  private async initChain(
    chainConfig: ChainConfig,
    deploymentFile: string
  ): Promise<ChainState | null> {
    try {
      // Load V3 deployment file
      const deployment = loadDeploymentV3(deploymentFile);
      if (!deployment) {
        console.error(`    Deployment file not found: ${deploymentFile}`);
        return null;
      }

      const { messageTransmitter, tokenMessenger } = deployment.contracts;
      if (!messageTransmitter || !tokenMessenger) {
        console.error(`    Missing CCTP contracts in deployment`);
        return null;
      }

      // Setup provider and wallet
      const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
      const wallet = new ethers.Wallet(accounts.deployer.privateKey, provider);

      // Verify connection
      await provider.getBlockNumber();

      const domain = CHAIN_TO_DOMAIN[chainConfig.chainId] || deployment.domain;

      return {
        config: chainConfig,
        provider,
        wallet,
        messageTransmitter,
        tokenMessenger,
        domain,
        lastProcessedBlock: 0,
        processedMessages: new Set(),
        pendingNonce: null,
      };
    } catch (e: any) {
      console.error(`    Connection error: ${e.message}`);
      return null;
    }
  }

  /**
   * Get chain state by domain ID
   */
  private getChainByDomain(domain: number): ChainState | undefined {
    return this.chains.get(domain);
  }

  /**
   * Relay a message to the destination chain
   */
  private async relayMessage(
    event: MessageEvent,
    sourceState: ChainState
  ): Promise<boolean> {
    const messageKey = `${event.sourceDomain}-${event.nonce}`;

    // Check if already processed
    if (sourceState.processedMessages.has(messageKey)) {
      return false;
    }

    // Get destination chain by domain
    const destState = this.getChainByDomain(event.destinationDomain);
    if (!destState) {
      console.log(
        `  Unknown destination domain ${event.destinationDomain}, skipping`
      );
      return false;
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `RELAYING: ${sourceState.config.name} (Domain ${event.sourceDomain}) → ${destState.config.name} (Domain ${event.destinationDomain})`
    );
    console.log(`${"=".repeat(60)}`);
    console.log(`  Nonce:               ${event.nonce}`);
    console.log(`  Sender:              ${event.sender}`);
    console.log(`  Recipient:           ${event.recipient}`);
    console.log(`  DestinationCaller:   ${event.destinationCaller}`);
    console.log(`  MinFinality:         ${event.minFinalityThreshold}`);
    console.log(`  Body Length:         ${(event.messageBody.length - 2) / 2} bytes`);
    console.log(`  Source Tx:           ${event.txHash}`);

    try {
      // Get MessageTransmitter contract on destination chain
      const messageTransmitter = new ethers.Contract(
        destState.messageTransmitter,
        MESSAGE_TRANSMITTER_ABI,
        destState.wallet
      );

      // Get or initialize nonce for destination chain
      if (destState.pendingNonce === null) {
        destState.pendingNonce = await destState.provider.getTransactionCount(
          destState.wallet.address,
          "pending"
        );
        console.log(
          `  Initialized tx nonce for ${destState.config.name}: ${destState.pendingNonce}`
        );
      }

      const txNonce = destState.pendingNonce;

      // Encode the full MessageV2
      const encodedMessage = encodeMessageV2(event);
      console.log(`\n  Encoded MessageV2 length: ${(encodedMessage.length - 2) / 2} bytes`);

      // Call receiveMessage with empty attestation (mock skips verification)
      console.log(
        `  Sending receiveMessage to ${destState.config.name} (tx nonce: ${txNonce})...`
      );

      const tx = await messageTransmitter.receiveMessage(
        encodedMessage,
        "0x", // Empty attestation - mock skips verification
        { nonce: txNonce }
      );

      // Increment nonce immediately
      destState.pendingNonce = txNonce + 1;

      console.log(`  Tx hash: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt?.blockNumber}`);

      // Mark as processed
      sourceState.processedMessages.add(messageKey);

      console.log(`  ✓ Relay successful`);
      return true;
    } catch (e: any) {
      if (e.message?.includes("already processed") || e.message?.includes("Message already processed")) {
        console.log(`  Already processed on-chain, marking as done`);
        sourceState.processedMessages.add(messageKey);
        return false;
      }
      if (e.message?.includes("nonce") || e.message?.includes("NONCE")) {
        console.log(`  Nonce error detected, will refresh on next attempt`);
        destState.pendingNonce = null;
      }
      console.error(`  ✗ Relay failed: ${e.message || e}`);
      return false;
    }
  }

  /**
   * Poll a chain for new MessageSent events
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

      // Get MessageSent event topic
      const iface = new ethers.Interface(MESSAGE_SENT_ABI);
      const eventTopic = iface.getEvent("MessageSent")?.topicHash;

      if (!eventTopic) {
        console.error("Failed to get MessageSent event topic");
        return;
      }

      // Fetch logs from MessageTransmitter
      const logs = await state.provider.getLogs({
        address: state.messageTransmitter,
        topics: [eventTopic],
        fromBlock,
        toBlock,
      });

      if (logs.length > 0) {
        console.log(
          `\n${state.config.name}: Found ${logs.length} message(s) in blocks ${fromBlock}-${toBlock}`
        );
      }

      // Process each event
      for (const log of logs) {
        const event = parseMessageEvent(log, state.config.chainId);
        if (event) {
          await this.relayMessage(event, state);
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
    const chainsSummary = Array.from(this.chains.values())
      .map(
        (s) =>
          `  ${s.config.name}: Domain ${s.domain} (Chain ${s.config.chainId})`
      )
      .join("\n");

    const contractsSummary = Array.from(this.chains.values())
      .map(
        (s) =>
          `  ${s.config.name}:\n    MessageTransmitter: ${s.messageTransmitter}\n    TokenMessenger: ${s.tokenMessenger}`
      )
      .join("\n");

    console.log(`
${"=".repeat(60)}
  CCTP V2 RELAYER STARTED
${"=".repeat(60)}

Chains (${this.chains.size}):
${chainsSummary}

Contracts:
${contractsSummary}

Poll Interval: ${relayerSettings.pollIntervalMs}ms
Relayer Wallet: ${accounts.deployer.address}

Message Format: MessageV2 (real CCTP V2 format)
  - version: ${MESSAGE_VERSION}
  - finalityThresholdExecuted: ${FINALITY_STANDARD} (standard)
  - attestation: empty (mock skips verification)

Watching for MessageSent events on all chains...
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
    // dotenv not required
  }

  const relayer = new CCTPV2Relayer();

  // Initialize all chains
  const success = await relayer.initialize();
  if (!success) {
    console.error(
      "\nFailed to initialize all chains. Some chains may be missing V3 deployments."
    );
    console.error("Run 'npm run setup-v3' to deploy CCTP V2 contracts.\n");
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
