/**
 * Iris Attestation Relay Module
 *
 * Handles CCTP message relay using Circle's real attestation service (Iris).
 * Replaces the mock relay for testnet/mainnet deployments.
 *
 * Flow:
 *   1. Watch for MessageSent(bytes message) events from real MessageTransmitterV2
 *   2. Queue new messages as "pending" with their source tx hash
 *   3. Each poll cycle, check Iris for attestations on all pending messages
 *   4. When attestation is ready, call receiveMessage(message, attestation) on destination
 *
 * Non-blocking design: attestation polling never stalls the event scanner.
 * Messages stay queued until attested or expired (configurable, default 30 min).
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
  /** Full bytes32 nonce from message header */
  nonce: string;
  /** Source transaction hash */
  sourceTxHash: string;
  /** Block number of source event */
  sourceBlock: number;
  /** When we first detected this message */
  detectedAt: number;
  /** Number of Iris poll attempts */
  pollAttempts: number;
  /** Last Iris status seen */
  lastStatus: string;
}

interface IrisMessageResponse {
  messages: Array<{
    attestation: string;
    message: string;
    eventNonce: string;
    status: "pending" | "pending_confirmations" | "complete";
  }>;
}

interface ChainState {
  config: ChainConfig;
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  messageTransmitter: string;
  hookRouter: string | null;
  domain: number;
  lastProcessedBlock: number;
  processedMessages: Set<string>;
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

const HOOK_ROUTER_ABI = [
  "function relayWithHook(bytes calldata message, bytes calldata attestation) external returns (bool)",
];

/**
 * Real CCTP V2 MessageV2 byte layout offsets.
 *
 * | Field                     | Bytes | Offset |
 * |---------------------------|-------|--------|
 * | version                   | 4     | 0      |
 * | sourceDomain              | 4     | 4      |
 * | destinationDomain         | 4     | 8      |
 * | nonce                     | 32    | 12     |  <-- bytes32, NOT uint64
 * | sender                    | 32    | 44     |
 * | recipient                 | 32    | 76     |
 * | destinationCaller         | 32    | 108    |
 * | minFinalityThreshold      | 4     | 140    |
 * | finalityThresholdExecuted | 4     | 144    |
 * | messageBody               | var   | 148    |
 */
const MSG_SOURCE_DOMAIN_OFFSET = 4;
const MSG_DEST_DOMAIN_OFFSET = 8;
const MSG_NONCE_OFFSET = 12;
const MSG_NONCE_LENGTH = 32; // bytes32 in real CCTP V2 (NOT 8-byte uint64)

/** Max time to keep polling for an attestation before giving up (ms) */
const MAX_ATTESTATION_AGE_MS = 30 * 60 * 1000; // 30 minutes

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
  nonce: string; // full bytes32 hex
} {
  // Remove 0x prefix
  const hex = messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex;

  const sourceDomain = parseInt(hex.slice(MSG_SOURCE_DOMAIN_OFFSET * 2, (MSG_SOURCE_DOMAIN_OFFSET + 4) * 2), 16);
  const destinationDomain = parseInt(hex.slice(MSG_DEST_DOMAIN_OFFSET * 2, (MSG_DEST_DOMAIN_OFFSET + 4) * 2), 16);
  // Nonce is bytes32 (32 bytes) in real CCTP V2, not uint64 (8 bytes)
  const nonce = "0x" + hex.slice(MSG_NONCE_OFFSET * 2, (MSG_NONCE_OFFSET + MSG_NONCE_LENGTH) * 2);

  return { sourceDomain, destinationDomain, nonce };
}

function elapsed(since: number): string {
  const seconds = Math.floor((Date.now() - since) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m${secs}s`;
}

// ============ Iris API Client ============

class IrisClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Single non-blocking check for attestation.
   * Returns attestation if ready, null if still pending or error.
   */
  async checkAttestation(
    sourceDomain: number,
    sourceTxHash: string
  ): Promise<{ attestation: string; message: string; status: string } | null> {
    const url = `${this.baseUrl}/v2/messages/${sourceDomain}?transactionHash=${sourceTxHash}`;

    try {
      const response = await fetch(url);

      if (response.status === 404) {
        return null; // Not yet indexed
      }

      if (!response.ok) {
        console.warn(`    [iris] API error ${response.status}: ${await response.text()}`);
        return null;
      }

      const data = (await response.json()) as IrisMessageResponse;

      if (!data.messages || data.messages.length === 0) {
        return null;
      }

      const msg = data.messages[0];
      if (msg.status === "complete" && msg.attestation) {
        return {
          attestation: msg.attestation,
          message: msg.message,
          status: msg.status,
        };
      }

      // Return status for logging (pending, pending_confirmations)
      return { attestation: "", message: "", status: msg.status };
    } catch (e: any) {
      console.warn(`    [iris] Poll error: ${e.message}`);
      return null;
    }
  }

  getUrl(sourceDomain: number, sourceTxHash: string): string {
    return `${this.baseUrl}/v2/messages/${sourceDomain}?transactionHash=${sourceTxHash}`;
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
    this.irisClient = new IrisClient(iris.apiUrl);
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
        console.log(`    HookRouter: ${state.hookRouter || "not configured"}`);
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

      // Load hookRouter from privacy pool deployment
      let hookRouter: string | null = null;
      const ppDeployment = loadDeployment(chainConfig.privacyPoolDeploymentFile);
      if (ppDeployment?.contracts?.hookRouter) {
        hookRouter = ppDeployment.contracts.hookRouter;
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
        hookRouter,
        domain: chainConfig.cctpDomain,
        lastProcessedBlock: 0,
        processedMessages: new Set(),
      };
    } catch (e: any) {
      console.error(`    Connection error: ${e.message}`);
      return null;
    }
  }

  private getChainByDomain(domain: number): ChainState | undefined {
    return this.chains.get(domain);
  }

  // ========== Event Scanning ==========

  /**
   * Poll a chain for new MessageSent events from real CCTP.
   * New messages are queued as pending — no blocking on Iris.
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
        this.enqueueMessage(log, state);
      }

      state.lastProcessedBlock = currentBlock;
    } catch (e) {
      // Silently ignore connection errors during polling
    }
  }

  /**
   * Parse a MessageSent event and add it to the pending queue.
   */
  private enqueueMessage(log: ethers.Log, sourceState: ChainState): void {
    const iface = new ethers.Interface(REAL_MESSAGE_SENT_ABI);
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) return;

    const messageBytes: string = parsed.args[0];
    const messageHash = ethers.keccak256(messageBytes);

    // Already processed or already queued
    if (sourceState.processedMessages.has(messageHash)) return;
    if (this.pendingMessages.has(messageHash)) return;

    const { sourceDomain, destinationDomain, nonce } = parseMessageFields(messageBytes);

    const destState = this.getChainByDomain(destinationDomain);
    if (!destState) {
      console.log(`  [iris-relay] Unknown destination domain ${destinationDomain}, skipping`);
      return;
    }

    const pending: PendingMessage = {
      messageBytes,
      messageHash,
      sourceDomain,
      destinationDomain,
      nonce,
      sourceTxHash: log.transactionHash,
      sourceBlock: log.blockNumber,
      detectedAt: Date.now(),
      pollAttempts: 0,
      lastStatus: "new",
    };

    this.pendingMessages.set(messageHash, pending);

    const irisUrl = this.irisClient.getUrl(sourceDomain, log.transactionHash);

    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `[iris-relay] QUEUED: ${sourceState.config.name} (Domain ${sourceDomain}) -> ${destState.config.name} (Domain ${destinationDomain})`
    );
    console.log(`${"=".repeat(60)}`);
    console.log(`  Nonce:       ${nonce}`);
    console.log(`  Msg Hash:    ${messageHash}`);
    console.log(`  Source Tx:   ${log.transactionHash}`);
    console.log(`  Msg length:  ${(messageBytes.length - 2) / 2} bytes`);
    console.log(`  Iris URL:    ${irisUrl}`);
    console.log(`  Queued for attestation polling (non-blocking)`);
  }

  // ========== Attestation Polling & Relay ==========

  /**
   * Check all pending messages for attestations and relay any that are ready.
   * Called once per poll cycle — never blocks.
   */
  private async processPendingMessages(): Promise<void> {
    if (this.pendingMessages.size === 0) return;

    const entries = Array.from(this.pendingMessages.entries());
    for (const [hash, msg] of entries) {
      // Check if expired
      const age = Date.now() - msg.detectedAt;
      if (age > MAX_ATTESTATION_AGE_MS) {
        console.log(
          `\n[iris-relay] EXPIRED: message ${hash.slice(0, 18)}... after ${elapsed(msg.detectedAt)} ` +
          `(${msg.pollAttempts} polls, last status: ${msg.lastStatus})`
        );
        console.log(`  Source Tx: ${msg.sourceTxHash}`);
        console.log(`  Iris URL:  ${this.irisClient.getUrl(msg.sourceDomain, msg.sourceTxHash)}`);
        this.pendingMessages.delete(hash);
        continue;
      }

      // Check Iris
      msg.pollAttempts++;
      const result = await this.irisClient.checkAttestation(
        msg.sourceDomain,
        msg.sourceTxHash
      );

      if (!result) {
        // Not indexed yet or error — log periodically
        if (msg.pollAttempts % 6 === 0) {
          console.log(
            `  [iris-relay] ${hash.slice(0, 18)}... not yet indexed (${elapsed(msg.detectedAt)}, ${msg.pollAttempts} polls)`
          );
        }
        continue;
      }

      if (!result.attestation) {
        // Have a status but no attestation yet
        msg.lastStatus = result.status;
        if (msg.pollAttempts % 6 === 0) {
          console.log(
            `  [iris-relay] ${hash.slice(0, 18)}... status: ${result.status} (${elapsed(msg.detectedAt)}, ${msg.pollAttempts} polls)`
          );
        }
        continue;
      }

      // Attestation ready — relay it
      console.log(
        `\n[iris-relay] ATTESTATION READY for ${hash.slice(0, 18)}... after ${elapsed(msg.detectedAt)} (${msg.pollAttempts} polls)`
      );

      const relayed = await this.relayMessage(msg, result.attestation, result.message);
      if (relayed) {
        // Mark as processed on the source chain state
        const sourceState = this.getChainByDomain(msg.sourceDomain);
        if (sourceState) sourceState.processedMessages.add(hash);
      }
      this.pendingMessages.delete(hash);
    }
  }

  /**
   * Submit receiveMessage on the destination chain.
   */
  private async relayMessage(
    msg: PendingMessage,
    attestation: string,
    irisMessage: string
  ): Promise<boolean> {
    const destState = this.getChainByDomain(msg.destinationDomain);
    if (!destState) {
      console.error(`  [iris-relay] No chain for destination domain ${msg.destinationDomain}`);
      return false;
    }

    try {
      // Prefer the message from Iris (may include finalityThresholdExecuted filled in)
      const msgToRelay = irisMessage || msg.messageBytes;

      console.log(`  Source Tx: ${msg.sourceTxHash}`);

      // Use hookRouter.relayWithHook() to atomically call receiveMessage + hook dispatch
      let tx: ethers.ContractTransactionResponse;
      if (destState.hookRouter) {
        const hookRouter = new ethers.Contract(
          destState.hookRouter,
          HOOK_ROUTER_ABI,
          destState.wallet
        );
        console.log(`  Sending relayWithHook to ${destState.config.name} via CCTPHookRouter...`);
        tx = await hookRouter.relayWithHook(msgToRelay, attestation);
      } else {
        const messageTransmitter = new ethers.Contract(
          destState.messageTransmitter,
          REAL_MESSAGE_TRANSMITTER_ABI,
          destState.wallet
        );
        console.log(`  Sending receiveMessage to ${destState.config.name}...`);
        tx = await messageTransmitter.receiveMessage(msgToRelay, attestation);
      }
      console.log(`  Tx hash: ${tx.hash}`);

      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt?.blockNumber}`);
      console.log(`  Relay successful`);
      return true;
    } catch (e: any) {
      if (
        e.message?.includes("already processed") ||
        e.message?.includes("Nonce already used")
      ) {
        console.log(`  Already processed on-chain, marking as done`);
        return true;
      }
      console.error(`  [iris-relay] Relay failed: ${e.message || e}`);
      return false;
    }
  }

  // ========== Lifecycle ==========

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
    console.log(`[iris-relay] Max attestation wait: ${MAX_ATTESTATION_AGE_MS / 60000} minutes`);

    this.isRunning = true;
    this.runPollLoop();
  }

  private async runPollLoop(): Promise<void> {
    while (this.isRunning) {
      // 1. Scan all chains for new MessageSent events
      const chainStates = Array.from(this.chains.values());
      for (const state of chainStates) {
        await this.pollChain(state);
      }

      // 2. Check pending messages for attestations and relay
      await this.processPendingMessages();

      // 3. Sleep before next cycle
      await new Promise((resolve) =>
        setTimeout(resolve, this.pollIntervalMs)
      );
    }
  }

  stop(): void {
    if (this.isRunning) {
      console.log("[iris-relay] Stopping...");
      if (this.pendingMessages.size > 0) {
        console.log(`[iris-relay] ${this.pendingMessages.size} pending message(s) will be abandoned`);
      }
      this.isRunning = false;
    }
  }

  get chainCount(): number {
    return this.chains.size;
  }
}
