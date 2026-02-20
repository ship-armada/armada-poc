/**
 * Iris Attestation Relay Module
 *
 * Handles CCTP message relay using Circle's real attestation service (Iris).
 * Replaces the mock relay for testnet/mainnet deployments.
 *
 * Flow:
 *   1. Watch for MessageSent(bytes message) events from real MessageTransmitterV2
 *   2. Hash the message bytes: keccak256(message)
 *   3. Poll Iris API for attestation until status is "complete"
 *   4. Call receiveMessage(message, attestation) on destination MessageTransmitterV2
 *
 * Circle Iris API:
 *   Testnet: https://iris-api-sandbox.circle.com
 *   Mainnet: https://iris-api.circle.com
 */

import { ethers } from "ethers";
import {
  allChains,
  accounts,
  armadaRelayerSettings,
  type ChainConfig,
} from "../config";
import * as fs from "fs";
import * as path from "path";

// ============ Types ============

interface PendingMessage {
  /** Raw message bytes from MessageSent event */
  messageBytes: string;
  /** keccak256 hash of the message bytes */
  messageHash: string;
  /** Source chain CCTP domain */
  sourceDomain: number;
  /** Destination chain CCTP domain */
  destinationDomain: number;
  /** Source transaction hash */
  sourceTxHash: string;
  /** Block number of source event */
  sourceBlock: number;
  /** When we started polling Iris */
  pollStartedAt: number;
  /** Number of poll attempts */
  pollAttempts: number;
}

interface IrisMessageResponse {
  messages: Array<{
    attestation: string;
    message: string;
    eventNonce: string;
    status: "pending" | "complete";
  }>;
}

interface ChainState {
  config: ChainConfig;
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  messageTransmitter: string;
  domain: number;
  lastProcessedBlock: number;
  processedMessages: Set<string>;
  pendingNonce: number | null;
}

// ============ Constants ============

/**
 * Real CCTP V2 MessageTransmitterV2 emits:
 *   event MessageSent(bytes message)
 *
 * This is different from our mock which has indexed fields.
 */
const REAL_MESSAGE_SENT_ABI = [
  "event MessageSent(bytes message)",
];

const REAL_MESSAGE_TRANSMITTER_ABI = [
  "function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool)",
  "function localDomain() view returns (uint32)",
];

/**
 * MessageV2 byte layout offsets for parsing raw message bytes.
 * | version(4) | sourceDomain(4) | destinationDomain(4) | nonce(8) | sender(32) | ...
 */
const MSG_SOURCE_DOMAIN_OFFSET = 4;
const MSG_DEST_DOMAIN_OFFSET = 8;
const MSG_NONCE_OFFSET = 12;

// ============ Helpers ============

function loadDeployment(filename: string): any | null {
  const deploymentsDir = path.join(__dirname, "../../deployments");
  const filePath = path.join(deploymentsDir, filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function parseMessageFields(messageHex: string): {
  sourceDomain: number;
  destinationDomain: number;
  nonce: bigint;
} {
  // Remove 0x prefix
  const hex = messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex;

  const sourceDomain = parseInt(hex.slice(MSG_SOURCE_DOMAIN_OFFSET * 2, (MSG_SOURCE_DOMAIN_OFFSET + 4) * 2), 16);
  const destinationDomain = parseInt(hex.slice(MSG_DEST_DOMAIN_OFFSET * 2, (MSG_DEST_DOMAIN_OFFSET + 4) * 2), 16);
  const nonce = BigInt("0x" + hex.slice(MSG_NONCE_OFFSET * 2, (MSG_NONCE_OFFSET + 8) * 2));

  return { sourceDomain, destinationDomain, nonce };
}

// ============ Iris API Client ============

class IrisClient {
  private baseUrl: string;
  private pollIntervalMs: number;
  private pollTimeoutMs: number;

  constructor(baseUrl: string, pollIntervalMs: number, pollTimeoutMs: number) {
    this.baseUrl = baseUrl;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
  }

  /**
   * Poll Iris for attestation of a message.
   * Returns the attestation bytes when ready, or null on timeout.
   */
  async waitForAttestation(
    sourceDomain: number,
    sourceTxHash: string
  ): Promise<{ attestation: string; message: string } | null> {
    const startTime = Date.now();
    let attempts = 0;

    const url = `${this.baseUrl}/v2/messages/${sourceDomain}?transactionHash=${sourceTxHash}`;

    while (Date.now() - startTime < this.pollTimeoutMs) {
      attempts++;
      try {
        const response = await fetch(url);

        if (response.status === 404) {
          // Message not yet indexed by Iris
          if (attempts % 6 === 0) { // Log every minute
            console.log(`  [iris] Still waiting for attestation (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)...`);
          }
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        if (!response.ok) {
          console.warn(`  [iris] API error ${response.status}: ${await response.text()}`);
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        const data = (await response.json()) as IrisMessageResponse;

        if (!data.messages || data.messages.length === 0) {
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        const msg = data.messages[0];
        if (msg.status === "complete" && msg.attestation) {
          console.log(`  [iris] Attestation received after ${attempts} polls (${Math.floor((Date.now() - startTime) / 1000)}s)`);
          return {
            attestation: msg.attestation,
            message: msg.message,
          };
        }

        // Status is "pending" — keep polling
        if (attempts % 6 === 0) {
          console.log(`  [iris] Status: ${msg.status} (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)...`);
        }
      } catch (e: any) {
        console.warn(`  [iris] Poll error: ${e.message}`);
      }

      await this.sleep(this.pollIntervalMs);
    }

    console.error(`  [iris] Timeout after ${Math.floor(this.pollTimeoutMs / 1000)}s waiting for attestation`);
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============ Iris Relay Module ============

export class IrisRelayModule {
  private chains: Map<number, ChainState> = new Map();
  private isRunning: boolean = false;
  private pollIntervalMs: number;
  private irisClient: IrisClient;
  private pendingMessages: Map<string, PendingMessage> = new Map();

  constructor() {
    const { iris } = armadaRelayerSettings;
    this.pollIntervalMs = armadaRelayerSettings.cctpPollIntervalMs;
    this.irisClient = new IrisClient(
      iris.apiUrl,
      iris.pollIntervalMs,
      iris.pollTimeoutMs
    );
  }

  async initialize(): Promise<boolean> {
    console.log("[iris-relay] Initializing real CCTP relay module...");
    console.log(`[iris-relay] Iris API: ${armadaRelayerSettings.iris.apiUrl}`);

    let allInitialized = true;

    for (const chainConfig of allChains) {
      const state = await this.initChain(chainConfig);
      if (state) {
        this.chains.set(state.domain, state);
        console.log(
          `  [iris-relay] ${chainConfig.name} (Chain ${chainConfig.chainId}, Domain ${state.domain})`
        );
        console.log(`    MessageTransmitter: ${state.messageTransmitter}`);
      } else {
        console.log(
          `  [iris-relay] ${chainConfig.name} (${chainConfig.chainId}): Failed to initialize`
        );
        allInitialized = false;
      }
    }

    console.log(
      `[iris-relay] Initialized ${this.chains.size}/${allChains.length} chains`
    );
    return allInitialized;
  }

  private async initChain(chainConfig: ChainConfig): Promise<ChainState | null> {
    try {
      const deployment = loadDeployment(chainConfig.deploymentFile);
      if (!deployment) {
        console.error(`    Deployment file not found: ${chainConfig.deploymentFile}`);
        return null;
      }

      const { messageTransmitter } = deployment.contracts;
      if (!messageTransmitter) {
        console.error(`    Missing messageTransmitter in deployment`);
        return null;
      }

      const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
      const wallet = new ethers.Wallet(accounts.deployer.privateKey, provider);

      // Verify connection
      await provider.getBlockNumber();

      return {
        config: chainConfig,
        provider,
        wallet,
        messageTransmitter,
        domain: chainConfig.cctpDomain,
        lastProcessedBlock: 0,
        processedMessages: new Set(),
        pendingNonce: null,
      };
    } catch (e: any) {
      console.error(`    Connection error: ${e.message}`);
      return null;
    }
  }

  private getChainByDomain(domain: number): ChainState | undefined {
    return this.chains.get(domain);
  }

  /**
   * Poll a chain for new MessageSent events from real CCTP
   */
  private async pollChain(state: ChainState): Promise<void> {
    try {
      const currentBlock = await state.provider.getBlockNumber();

      if (state.lastProcessedBlock === 0) {
        state.lastProcessedBlock = currentBlock;
        console.log(
          `  [iris-relay] ${state.config.name}: Starting from block ${currentBlock}`
        );
        return;
      }

      if (currentBlock <= state.lastProcessedBlock) return;

      const fromBlock = state.lastProcessedBlock + 1;
      const toBlock = currentBlock;

      // Real CCTP emits: event MessageSent(bytes message)
      const iface = new ethers.Interface(REAL_MESSAGE_SENT_ABI);
      const eventTopic = iface.getEvent("MessageSent")?.topicHash;
      if (!eventTopic) return;

      const logs = await state.provider.getLogs({
        address: state.messageTransmitter,
        topics: [eventTopic],
        fromBlock,
        toBlock,
      });

      if (logs.length > 0) {
        console.log(
          `\n[iris-relay] ${state.config.name}: Found ${logs.length} message(s) in blocks ${fromBlock}-${toBlock}`
        );
      }

      for (const log of logs) {
        await this.handleMessageSent(log, state);
      }

      state.lastProcessedBlock = currentBlock;
    } catch (e) {
      // Silently ignore connection errors during polling
    }
  }

  /**
   * Handle a MessageSent event by requesting attestation from Iris and relaying
   */
  private async handleMessageSent(log: ethers.Log, sourceState: ChainState): Promise<void> {
    const iface = new ethers.Interface(REAL_MESSAGE_SENT_ABI);
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) return;

    // The event contains the full message bytes
    const messageBytes: string = parsed.args[0]; // args.message
    const messageHash = ethers.keccak256(messageBytes);

    // Parse source/destination from message bytes
    const { sourceDomain, destinationDomain, nonce } = parseMessageFields(messageBytes);
    const messageKey = `${sourceDomain}-${nonce}`;

    if (sourceState.processedMessages.has(messageKey)) return;

    const destState = this.getChainByDomain(destinationDomain);
    if (!destState) {
      console.log(`  [iris-relay] Unknown destination domain ${destinationDomain}, skipping`);
      return;
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `[iris-relay] RELAYING: ${sourceState.config.name} (Domain ${sourceDomain}) -> ${destState.config.name} (Domain ${destinationDomain})`
    );
    console.log(`${"=".repeat(60)}`);
    console.log(`  Nonce:         ${nonce}`);
    console.log(`  Message Hash:  ${messageHash}`);
    console.log(`  Source Tx:     ${log.transactionHash}`);
    console.log(`  Requesting attestation from Iris...`);

    // Poll Iris for attestation
    const result = await this.irisClient.waitForAttestation(
      sourceDomain,
      log.transactionHash
    );

    if (!result) {
      console.error(`  [iris-relay] Failed to get attestation for ${messageKey}`);
      return;
    }

    // Relay the message with attestation
    try {
      const messageTransmitter = new ethers.Contract(
        destState.messageTransmitter,
        REAL_MESSAGE_TRANSMITTER_ABI,
        destState.wallet
      );

      // Use the message bytes from the event (or from Iris response)
      const msgToRelay = result.message || messageBytes;
      const attestation = result.attestation;

      console.log(`  Sending receiveMessage to ${destState.config.name}...`);

      const tx = await messageTransmitter.receiveMessage(msgToRelay, attestation);
      console.log(`  Tx hash: ${tx.hash}`);

      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt?.blockNumber}`);

      sourceState.processedMessages.add(messageKey);
      console.log(`  Relay successful`);
    } catch (e: any) {
      if (
        e.message?.includes("already processed") ||
        e.message?.includes("Nonce already used")
      ) {
        console.log(`  Already processed on-chain, marking as done`);
        sourceState.processedMessages.add(messageKey);
        return;
      }
      console.error(`  [iris-relay] Relay failed: ${e.message || e}`);
    }
  }

  start(): void {
    if (this.chains.size === 0) {
      console.warn("[iris-relay] No chains initialized, skipping start");
      return;
    }

    const chainsSummary = Array.from(this.chains.values())
      .map(
        (s) =>
          `  ${s.config.name}: Domain ${s.domain} (Chain ${s.config.chainId})`
      )
      .join("\n");

    console.log(`[iris-relay] Started polling ${this.chains.size} chain(s):`);
    console.log(chainsSummary);
    console.log(`[iris-relay] Poll interval: ${this.pollIntervalMs}ms`);

    this.isRunning = true;
    this.runPollLoop();
  }

  private async runPollLoop(): Promise<void> {
    while (this.isRunning) {
      for (const state of this.chains.values()) {
        await this.pollChain(state);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.pollIntervalMs)
      );
    }
  }

  stop(): void {
    if (this.isRunning) {
      console.log("[iris-relay] Stopping...");
      this.isRunning = false;
    }
  }

  get chainCount(): number {
    return this.chains.size;
  }
}
