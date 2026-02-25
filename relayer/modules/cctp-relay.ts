/**
 * CCTP Relay Module
 *
 * Watches for MessageSent events on all chains and relays them to
 * destination chains by calling receiveMessage(). Simulates Circle's
 * attestation service for local testing.
 *
 * Extracted from relay-v2.ts for integration into the unified armada-relayer.
 */

import { ethers } from "ethers";
import {
  ChainConfig,
  allChains,
  accounts,
  armadaRelayerSettings,
} from "../config";
import * as fs from "fs";
import * as path from "path";

// ============ Constants ============

/** MessageV2 version number */
const MESSAGE_VERSION = 1;

/** Finality threshold for standard finality */
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
  rawMessage: string; // Full encoded MessageV2 bytes (from event)
  txHash: string;
  blockNumber: number;
}

interface ChainState {
  config: ChainConfig;
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  messageTransmitter: string;
  tokenMessenger: string;
  hookRouter: string | null;
  domain: number;
  lastProcessedBlock: number;
  processedMessages: Set<string>; // "sourceDomain-nonce" format
  pendingNonce: number | null;
}

/** Retry queue entry for failed CCTP relay attempts */
interface RetryEntry {
  event: MessageEvent;
  sourceState: ChainState;
  attempts: number;
  nextRetryAt: number; // Unix timestamp ms
}

/** Max retry attempts before giving up */
const MAX_RETRIES = 5;

/** Base delay for exponential backoff (2 seconds) */
const RETRY_BASE_DELAY_MS = 2000;

/**
 * BurnMessageV2 byte offsets for parsing maxFee from messageBody.
 * Layout: version(4), burnToken(32), mintRecipient(32), amount(32),
 *         messageSender(32), maxFee(32), feeExecuted(32), expirationBlock(32), hookData(var)
 */
const BURN_MSG_AMOUNT_OFFSET = 4 + 32 + 32; // 68
const BURN_MSG_MAX_FEE_OFFSET = 4 + 32 + 32 + 32 + 32; // 132
const BURN_MSG_MIN_LENGTH = 228; // 4 + 7*32

interface DeploymentV3 {
  chainId: number;
  domain: number;
  contracts: {
    usdc: string;
    messageTransmitter: string;
    tokenMessenger: string;
    hubCCTPReceiver?: string;
    hubUnshieldProxy?: string;
    railgunProxy?: string;
    clientShieldProxy?: string;
  };
}

/** Privacy pool deployment (hub or client) — used to load hookRouter address */
interface PrivacyPoolDeployment {
  contracts: {
    hookRouter?: string;
    [key: string]: string | undefined;
  };
}

// ============ ABIs ============

// Real CCTP v2 event signature: MessageSent(bytes message)
const MESSAGE_SENT_ABI = [
  "event MessageSent(bytes message)",
];

const MESSAGE_TRANSMITTER_ABI = [
  "function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool)",
  "function relayer() view returns (address)",
  "function localDomain() view returns (uint32)",
];

const HOOK_ROUTER_ABI = [
  "function relayWithHook(bytes calldata message, bytes calldata attestation) external returns (bool)",
];

// ============ Domain Mapping ============

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

// ============ Helpers ============

function loadDeploymentV3(filename: string): DeploymentV3 | null {
  const deploymentsDir = path.join(__dirname, "../../deployments");
  const filePath = path.join(deploymentsDir, filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * MessageV2 byte offsets (matches ICCTPV2.sol MessageV2 library and real CCTP V2).
 * version(4) | sourceDomain(4) | destinationDomain(4) | nonce(32) |
 * sender(32) | recipient(32) | destinationCaller(32) |
 * minFinalityThreshold(4) | finalityThresholdExecuted(4) | messageBody(var)
 */
const MSG_SOURCE_DOMAIN_OFFSET = 4;
const MSG_DEST_DOMAIN_OFFSET = 8;
const MSG_NONCE_OFFSET = 12;
const MSG_NONCE_LENGTH = 32; // bytes32 in real CCTP V2
const MSG_SENDER_OFFSET = 44;
const MSG_RECIPIENT_OFFSET = 76;
const MSG_DEST_CALLER_OFFSET = 108;
const MSG_MIN_FINALITY_OFFSET = 140;
const MSG_BODY_OFFSET = 148;

/**
 * Parse raw MessageV2 bytes into structured fields.
 * The message is already the full encoded envelope from the MessageSent event.
 */
function parseMessageV2Bytes(hex: string): Omit<MessageEvent, "txHash" | "blockNumber" | "rawMessage"> {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const slice = (offset: number, len: number) => "0x" + h.slice(offset * 2, (offset + len) * 2);

  return {
    sourceDomain: Number(BigInt(slice(MSG_SOURCE_DOMAIN_OFFSET, 4))),
    destinationDomain: Number(BigInt(slice(MSG_DEST_DOMAIN_OFFSET, 4))),
    nonce: BigInt(slice(MSG_NONCE_OFFSET, MSG_NONCE_LENGTH)),
    sender: slice(MSG_SENDER_OFFSET, 32),
    recipient: slice(MSG_RECIPIENT_OFFSET, 32),
    destinationCaller: slice(MSG_DEST_CALLER_OFFSET, 32),
    minFinalityThreshold: Number(BigInt(slice(MSG_MIN_FINALITY_OFFSET, 4))),
    messageBody: "0x" + h.slice(MSG_BODY_OFFSET * 2),
  };
}

/**
 * Parse maxFee and amount from a BurnMessageV2 messageBody hex string.
 * Returns { amount, maxFee } as bigints, or null if body is too short.
 */
function parseBurnMessageFee(messageBody: string): { amount: bigint; maxFee: bigint } | null {
  // Remove 0x prefix, each byte = 2 hex chars
  const hex = messageBody.startsWith("0x") ? messageBody.slice(2) : messageBody;
  if (hex.length / 2 < BURN_MSG_MIN_LENGTH) return null;

  const amount = BigInt("0x" + hex.slice(BURN_MSG_AMOUNT_OFFSET * 2, (BURN_MSG_AMOUNT_OFFSET + 32) * 2));
  const maxFee = BigInt("0x" + hex.slice(BURN_MSG_MAX_FEE_OFFSET * 2, (BURN_MSG_MAX_FEE_OFFSET + 32) * 2));
  return { amount, maxFee };
}

function parseMessageEvent(log: ethers.Log): MessageEvent | null {
  try {
    const iface = new ethers.Interface(MESSAGE_SENT_ABI);
    const parsed = iface.parseLog({
      topics: log.topics as string[],
      data: log.data,
    });

    if (!parsed) return null;

    // MessageSent(bytes message) — single param is the full encoded MessageV2
    const rawMessage: string = parsed.args.message;
    const fields = parseMessageV2Bytes(rawMessage);

    return {
      ...fields,
      rawMessage,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    };
  } catch (e) {
    console.error(`[cctp-relay] Failed to parse message event: ${e}`);
    return null;
  }
}

// ============ CCTP Relay Module ============

export class CCTPRelayModule {
  private chains: Map<number, ChainState> = new Map(); // Keyed by domain ID
  private isRunning: boolean = false;
  private pollIntervalMs: number;
  private retryQueue: RetryEntry[] = [];
  private getMinFee: (() => Promise<bigint>) | null;

  /**
   * @param getMinFee Optional async function that returns the minimum acceptable
   *   maxFee (in USDC raw units) for cross-chain shield relay. If provided,
   *   messages with insufficient maxFee will be skipped. If null, all messages
   *   are relayed (backward-compatible behavior).
   */
  constructor(getMinFee?: () => Promise<bigint>) {
    this.pollIntervalMs = armadaRelayerSettings.cctpPollIntervalMs;
    this.getMinFee = getMinFee || null;
  }

  /**
   * Initialize all chains from config and deployment files
   */
  async initialize(): Promise<boolean> {
    console.log("[cctp-relay] Initializing CCTP relay module...");

    const deploymentFiles: Record<number, string> = {
      31337: "hub-v3.json",
      31338: "client-v3.json",
      31339: "clientB-v3.json",
    };

    /** Privacy pool deployment files — used to load hookRouter address */
    const privacyPoolFiles: Record<number, string> = {
      31337: "privacy-pool-hub.json",
      31338: "privacy-pool-client.json",
      31339: "privacy-pool-clientB.json",
    };

    let allInitialized = true;

    for (const chainConfig of allChains) {
      const deploymentFile = deploymentFiles[chainConfig.chainId];
      if (!deploymentFile) {
        console.log(`  [cctp-relay] No deployment mapping for chain ${chainConfig.chainId}`);
        continue;
      }

      const ppFile = privacyPoolFiles[chainConfig.chainId];
      const state = await this.initChain(chainConfig, deploymentFile, ppFile);
      if (state) {
        this.chains.set(state.domain, state);
        console.log(
          `  [cctp-relay] ${chainConfig.name} (Chain ${chainConfig.chainId}, Domain ${state.domain})`
        );
        console.log(`    MessageTransmitter: ${state.messageTransmitter}`);
        console.log(`    TokenMessenger: ${state.tokenMessenger}`);
        console.log(`    HookRouter: ${state.hookRouter || "not configured"}`);
      } else {
        console.log(
          `  [cctp-relay] ${chainConfig.name} (${chainConfig.chainId}): Failed to initialize`
        );
        allInitialized = false;
      }
    }

    console.log(
      `[cctp-relay] Initialized ${this.chains.size}/${allChains.length} chains`
    );
    return allInitialized;
  }

  /**
   * Initialize a single chain
   */
  private async initChain(
    chainConfig: ChainConfig,
    deploymentFile: string,
    privacyPoolFile?: string
  ): Promise<ChainState | null> {
    try {
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

      // Load hookRouter from privacy pool deployment
      let hookRouter: string | null = null;
      if (privacyPoolFile) {
        const ppDeployment = loadDeploymentV3(privacyPoolFile) as unknown as PrivacyPoolDeployment | null;
        if (ppDeployment?.contracts?.hookRouter) {
          hookRouter = ppDeployment.contracts.hookRouter;
        }
      }

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
        hookRouter,
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

    if (sourceState.processedMessages.has(messageKey)) {
      return false;
    }

    const destState = this.getChainByDomain(event.destinationDomain);
    if (!destState) {
      console.log(
        `  [cctp-relay] Unknown destination domain ${event.destinationDomain}, skipping`
      );
      return false;
    }

    // Parse maxFee from BurnMessageV2 body
    const burnFee = parseBurnMessageFee(event.messageBody);
    const maxFeeDisplay = burnFee ? `${burnFee.maxFee} raw USDC` : "unknown";

    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `[cctp-relay] RELAYING: ${sourceState.config.name} (Domain ${event.sourceDomain}) → ${destState.config.name} (Domain ${event.destinationDomain})`
    );
    console.log(`${"=".repeat(60)}`);
    console.log(`  Nonce:               ${event.nonce}`);
    console.log(`  Sender:              ${event.sender}`);
    console.log(`  Recipient:           ${event.recipient}`);
    console.log(`  DestinationCaller:   ${event.destinationCaller}`);
    console.log(`  MinFinality:         ${event.minFinalityThreshold}`);
    console.log(`  Body Length:         ${(event.messageBody.length - 2) / 2} bytes`);
    console.log(`  maxFee:              ${maxFeeDisplay}`);
    console.log(`  Source Tx:           ${event.txHash}`);

    // Validate maxFee covers our minimum required fee
    if (this.getMinFee && burnFee) {
      const minFee = await this.getMinFee();
      if (burnFee.maxFee < minFee) {
        console.log(
          `  [cctp-relay] SKIPPING: maxFee ${burnFee.maxFee} < minFee ${minFee} — insufficient fee`
        );
        sourceState.processedMessages.add(messageKey);
        return false;
      }
      console.log(`  Fee check passed: maxFee ${burnFee.maxFee} >= minFee ${minFee}`);
    }

    try {
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

      const encodedMessage = event.rawMessage;
      console.log(
        `\n  Encoded MessageV2 length: ${(encodedMessage.length - 2) / 2} bytes`
      );

      // Use hookRouter.relayWithHook() to atomically call receiveMessage + hook dispatch
      let tx: ethers.ContractTransactionResponse;
      if (destState.hookRouter) {
        const hookRouter = new ethers.Contract(
          destState.hookRouter,
          HOOK_ROUTER_ABI,
          destState.wallet
        );
        console.log(
          `  Sending relayWithHook to ${destState.config.name} via CCTPHookRouter (tx nonce: ${txNonce})...`
        );
        tx = await hookRouter.relayWithHook(
          encodedMessage,
          "0x", // Empty attestation — mock skips verification
          { nonce: txNonce }
        );
      } else {
        console.log(
          `  Sending receiveMessage to ${destState.config.name} (tx nonce: ${txNonce})...`
        );
        tx = await messageTransmitter.receiveMessage(
          encodedMessage,
          "0x", // Empty attestation — mock skips verification
          { nonce: txNonce }
        );
      }

      destState.pendingNonce = txNonce + 1;

      console.log(`  Tx hash: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt?.blockNumber}`);

      sourceState.processedMessages.add(messageKey);

      console.log(`  Relay successful`);
      return true;
    } catch (e: any) {
      if (
        e.message?.includes("already processed") ||
        e.message?.includes("Message already processed")
      ) {
        console.log(`  Already processed on-chain, marking as done`);
        sourceState.processedMessages.add(messageKey);
        return false;
      }
      if (e.message?.includes("nonce") || e.message?.includes("NONCE")) {
        console.log(`  Nonce error detected, will refresh on next attempt`);
        destState.pendingNonce = null;
      }
      console.error(`  [cctp-relay] Relay failed: ${e.message || e}`);

      // Add to retry queue if not already being retried
      this.enqueueRetry(event, sourceState, 0);
      return false;
    }
  }

  /**
   * Add a failed message to the retry queue with exponential backoff
   */
  private enqueueRetry(
    event: MessageEvent,
    sourceState: ChainState,
    currentAttempts: number
  ): void {
    if (currentAttempts >= MAX_RETRIES) {
      console.error(
        `[cctp-relay] Max retries (${MAX_RETRIES}) reached for message ` +
          `${event.sourceDomain}-${event.nonce}. Giving up.`
      );
      return;
    }

    // Check if already in retry queue
    const messageKey = `${event.sourceDomain}-${event.nonce}`;
    const existing = this.retryQueue.find(
      (r) => `${r.event.sourceDomain}-${r.event.nonce}` === messageKey
    );
    if (existing) {
      return; // Already queued
    }

    const nextAttempt = currentAttempts + 1;
    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, currentAttempts); // 2s, 4s, 8s, 16s, 32s

    console.log(
      `[cctp-relay] Queuing retry #${nextAttempt} for ${messageKey} in ${delay}ms`
    );

    this.retryQueue.push({
      event,
      sourceState,
      attempts: nextAttempt,
      nextRetryAt: Date.now() + delay,
    });
  }

  /**
   * Process entries in the retry queue that are ready for retry
   */
  private async processRetryQueue(): Promise<void> {
    const now = Date.now();
    const ready = this.retryQueue.filter((r) => r.nextRetryAt <= now);

    for (const entry of ready) {
      const messageKey = `${entry.event.sourceDomain}-${entry.event.nonce}`;

      // Remove from queue before attempting
      this.retryQueue = this.retryQueue.filter(
        (r) => `${r.event.sourceDomain}-${r.event.nonce}` !== messageKey
      );

      // Check if already processed (might have been processed by another path)
      if (entry.sourceState.processedMessages.has(messageKey)) {
        continue;
      }

      console.log(
        `[cctp-relay] Retrying message ${messageKey} (attempt ${entry.attempts}/${MAX_RETRIES})`
      );

      const success = await this.relayMessageRetry(entry);
      if (!success && entry.attempts < MAX_RETRIES) {
        // Re-queue with incremented attempt count
        this.enqueueRetry(entry.event, entry.sourceState, entry.attempts);
      }
    }
  }

  /**
   * Attempt to relay a message from the retry queue
   */
  private async relayMessageRetry(entry: RetryEntry): Promise<boolean> {
    const { event, sourceState } = entry;
    const messageKey = `${event.sourceDomain}-${event.nonce}`;
    const destState = this.getChainByDomain(event.destinationDomain);

    if (!destState) {
      return false;
    }

    try {
      if (destState.pendingNonce === null) {
        destState.pendingNonce = await destState.provider.getTransactionCount(
          destState.wallet.address,
          "pending"
        );
      }

      const txNonce = destState.pendingNonce;
      const encodedMessage = event.rawMessage;

      // Use hookRouter.relayWithHook() if available
      let tx: ethers.ContractTransactionResponse;
      if (destState.hookRouter) {
        const hookRouter = new ethers.Contract(
          destState.hookRouter,
          HOOK_ROUTER_ABI,
          destState.wallet
        );
        tx = await hookRouter.relayWithHook(
          encodedMessage,
          "0x",
          { nonce: txNonce }
        );
      } else {
        const messageTransmitter = new ethers.Contract(
          destState.messageTransmitter,
          MESSAGE_TRANSMITTER_ABI,
          destState.wallet
        );
        tx = await messageTransmitter.receiveMessage(
          encodedMessage,
          "0x",
          { nonce: txNonce }
        );
      }

      destState.pendingNonce = txNonce + 1;

      const receipt = await tx.wait();
      console.log(
        `[cctp-relay] Retry successful for ${messageKey} in block ${receipt?.blockNumber}`
      );

      sourceState.processedMessages.add(messageKey);
      return true;
    } catch (e: any) {
      if (
        e.message?.includes("already processed") ||
        e.message?.includes("Message already processed")
      ) {
        console.log(`  [cctp-relay] ${messageKey} already processed on-chain`);
        sourceState.processedMessages.add(messageKey);
        return true; // Considered success
      }
      if (e.message?.includes("nonce") || e.message?.includes("NONCE")) {
        destState.pendingNonce = null;
      }
      console.error(`  [cctp-relay] Retry failed for ${messageKey}: ${e.message || e}`);
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
          `  [cctp-relay] ${state.config.name}: Starting from block ${currentBlock}`
        );
        return;
      }

      if (currentBlock <= state.lastProcessedBlock) {
        return;
      }

      const fromBlock = state.lastProcessedBlock + 1;
      const toBlock = currentBlock;

      const iface = new ethers.Interface(MESSAGE_SENT_ABI);
      const eventTopic = iface.getEvent("MessageSent")?.topicHash;

      if (!eventTopic) {
        console.error("[cctp-relay] Failed to get MessageSent event topic");
        return;
      }

      const logs = await state.provider.getLogs({
        address: state.messageTransmitter,
        topics: [eventTopic],
        fromBlock,
        toBlock,
      });

      if (logs.length > 0) {
        console.log(
          `\n[cctp-relay] ${state.config.name}: Found ${logs.length} message(s) in blocks ${fromBlock}-${toBlock}`
        );
      }

      for (const log of logs) {
        const event = parseMessageEvent(log);
        if (event) {
          await this.relayMessage(event, state);
        }
      }

      state.lastProcessedBlock = currentBlock;
    } catch (e) {
      // Silently ignore connection errors during polling (chain may be down)
    }
  }

  /**
   * Start the background polling loop
   *
   * Returns immediately; polling runs in the background.
   */
  start(): void {
    if (this.chains.size === 0) {
      console.warn("[cctp-relay] No chains initialized, skipping start");
      return;
    }

    const chainsSummary = Array.from(this.chains.values())
      .map(
        (s) =>
          `  ${s.config.name}: Domain ${s.domain} (Chain ${s.config.chainId})`
      )
      .join("\n");

    console.log(`[cctp-relay] Started polling ${this.chains.size} chain(s):`);
    console.log(chainsSummary);
    console.log(`[cctp-relay] Poll interval: ${this.pollIntervalMs}ms`);

    this.isRunning = true;
    this.runPollLoop();
  }

  /**
   * Internal polling loop (runs in background via setTimeout)
   */
  private async runPollLoop(): Promise<void> {
    while (this.isRunning) {
      // Poll all chains for new messages
      for (const state of this.chains.values()) {
        await this.pollChain(state);
      }

      // Process retry queue
      if (this.retryQueue.length > 0) {
        await this.processRetryQueue();
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.pollIntervalMs)
      );
    }
  }

  /**
   * Stop the polling loop
   */
  stop(): void {
    if (this.isRunning) {
      console.log("[cctp-relay] Stopping...");
      this.isRunning = false;
    }
  }

  /**
   * Get the number of initialized chains
   */
  get chainCount(): number {
    return this.chains.size;
  }
}
