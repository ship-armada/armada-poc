/**
 * CCTP Relay Module
 *
 * Watches for MessageSent events on all chains and relays them to
 * destination chains by calling receiveMessage(). Simulates Circle's
 * attestation service for local testing.
 *
 * Local/mock CCTP relay for the unified armada-relayer.
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
import { CursorStore } from "../lib/cursor-store";
import { getLogsChunked } from "../lib/get-logs-chunked";
import { RpcTimeoutError, withTimeout } from "../lib/rpc-utils";
import { classifyChainHealth, rollupStatus } from "../lib/health-classifier";
import { NonceCoordinator } from "../lib/nonce-coordinator";
import {
  RetryQueueStore,
  type PersistedRetryEntry,
  type PersistedMessageEvent,
} from "../lib/retry-queue-store";
import {
  DeadLetterStore,
  type DeadLetterRecord,
  type DeadLetterReason,
} from "../lib/dead-letter-store";
import type { ChainHealth, RelayerHealth } from "../types";

/** Where per-chain cursor files live — shared with iris-relay. Module-relative. */
const RELAYER_STATE_DIR = path.join(__dirname, "..", "state");

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
  /**
   * Highest block fully scanned (inclusive). Loaded from disk on cold start; advanced via the
   * cursor store after every successful chunk. Restart-safe.
   */
  lastProcessedBlock: number;
  processedMessages: Set<string>; // "sourceDomain-nonce" format
  /** Last scan error, or null when most recent tick succeeded. Replaces the silent catch. */
  lastError: { message: string; at: number } | null;
  /** Unix ms of the last successful scan tick. Used by the /health endpoint. */
  lastScanAt: number;
  /**
   * Chain head observed during the most recent successful tick. Captured here (rather than
   * fetched fresh on each /health request) so the endpoint is cheap and rate-limit-safe.
   * `chainHead - lastProcessedBlock` is the cursor lag operators care about. 0 = never scanned.
   */
  lastChainHead: number;
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

/** Serialise an in-memory MessageEvent for persistence (bigint nonce → decimal string). */
function serializeMessageEvent(event: MessageEvent): PersistedMessageEvent {
  return {
    nonce: event.nonce.toString(),
    sourceDomain: event.sourceDomain,
    destinationDomain: event.destinationDomain,
    sender: event.sender,
    recipient: event.recipient,
    destinationCaller: event.destinationCaller,
    minFinalityThreshold: event.minFinalityThreshold,
    messageBody: event.messageBody,
    rawMessage: event.rawMessage,
    txHash: event.txHash,
    blockNumber: event.blockNumber,
  };
}

/** Inverse of serializeMessageEvent — rebuild the in-memory event (string nonce → bigint). */
function deserializeMessageEvent(persisted: PersistedMessageEvent): MessageEvent {
  return {
    nonce: BigInt(persisted.nonce),
    sourceDomain: persisted.sourceDomain,
    destinationDomain: persisted.destinationDomain,
    sender: persisted.sender,
    recipient: persisted.recipient,
    destinationCaller: persisted.destinationCaller,
    minFinalityThreshold: persisted.minFinalityThreshold,
    messageBody: persisted.messageBody,
    rawMessage: persisted.rawMessage,
    txHash: persisted.txHash,
    blockNumber: persisted.blockNumber,
  };
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
  private cursorStore: CursorStore;
  /**
   * Durable backing for `retryQueue`. Without it, a restart while a failed message is queued for
   * retry loses the entry — and because the scan cursor has already advanced past the message
   * (relayMessage swallows failures and returns false), the scanner never re-discovers it, so the
   * source-chain burn is stranded forever.
   */
  private retryQueueStore: RetryQueueStore;
  private deadLetterStore: DeadLetterStore;
  /** Per-source-chain dead-letter records (keyed by chain name), in memory for synchronous health. */
  private deadLetters: Map<string, DeadLetterRecord[]> = new Map();
  /**
   * Process-wide nonce authority, shared with the privacy relay's WalletManager. Even in mock
   * mode the relayer submits both CCTP receives and (potentially) privacy-relay txs from the same
   * EOA on the hub chain, so one coordinator keeps their nonce streams from colliding.
   */
  private nonceCoordinator: NonceCoordinator;

  /**
   * @param nonceCoordinator Shared per-chain nonce authority (see field doc).
   * @param getMinFee Optional async function that returns the minimum acceptable
   *   maxFee (in USDC raw units) for cross-chain shield relay. If provided,
   *   messages with insufficient maxFee will be skipped. If null, all messages
   *   are relayed (backward-compatible behavior).
   */
  constructor(nonceCoordinator: NonceCoordinator, getMinFee?: () => Promise<bigint>) {
    this.pollIntervalMs = armadaRelayerSettings.cctpPollIntervalMs;
    this.getMinFee = getMinFee || null;
    this.cursorStore = new CursorStore(RELAYER_STATE_DIR);
    this.nonceCoordinator = nonceCoordinator;
    this.retryQueueStore = new RetryQueueStore(RELAYER_STATE_DIR);
    this.deadLetterStore = new DeadLetterStore(RELAYER_STATE_DIR);
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

    // Restore any retry-queue entries persisted before a previous shutdown/crash. Done AFTER the
    // chains map is populated so each entry's source chain can be re-resolved by domain.
    await this.loadRetryQueue();
    // Restore dead-letter records so getHealth reports an accurate count across restarts.
    await this.loadDeadLetters();

    return allInitialized;
  }

  /** Rehydrate per-chain dead-letter records from disk. Best-effort — a read error starts empty. */
  private async loadDeadLetters(): Promise<void> {
    let total = 0;
    for (const state of this.chains.values()) {
      try {
        const data = await this.deadLetterStore.read(state.config.name);
        if (data && data.records.length > 0) {
          this.deadLetters.set(state.config.name, data.records);
          total += data.records.length;
        }
      } catch (err: any) {
        console.error(
          `[cctp-relay] ${state.config.name}: failed to read dead-letter records (${err.message}). Starting empty for this chain.`,
        );
      }
    }
    if (total > 0) {
      console.warn(
        `[cctp-relay] Restored ${total} dead-letter record(s) — these messages were never relayed (see relayer/state/deadletter-*.json).`,
      );
    }
  }

  /**
   * Permanently give up on a message: record it durably and mark it processed so a rescan won't
   * re-relay it. `messageKey` is the `${sourceDomain}-${nonce}` id used in processedMessages.
   */
  private async deadLetter(
    event: MessageEvent,
    sourceState: ChainState,
    reason: DeadLetterReason,
  ): Promise<void> {
    const messageKey = `${event.sourceDomain}-${event.nonce}`;
    const record: DeadLetterRecord = {
      id: messageKey,
      sourceTxHash: event.txHash,
      rawMessage: event.rawMessage,
      reason,
      sourceDomain: event.sourceDomain,
      destinationDomain: event.destinationDomain,
      at: Date.now(),
    };
    const list = this.deadLetters.get(sourceState.config.name) ?? [];
    list.push(record);
    this.deadLetters.set(sourceState.config.name, list);
    sourceState.processedMessages.add(messageKey);
    console.error(
      `[cctp-relay] DEAD-LETTER (${reason}): ${messageKey} (source tx ${event.txHash}). Recorded for manual relay.`,
    );
    try {
      await this.deadLetterStore.write(sourceState.config.name, list);
    } catch (err: any) {
      console.error(
        `[cctp-relay] ${sourceState.config.name}: failed to persist dead-letter record (${err.message}).`,
      );
    }
  }

  /**
   * Rehydrate `retryQueue` from disk. Each persisted entry's `sourceState` is re-resolved by
   * domain (runtime objects aren't serialised). Entries whose source chain is no longer configured
   * are dropped with a warning rather than silently retained against a missing chain.
   */
  private async loadRetryQueue(): Promise<void> {
    let data;
    try {
      data = await this.retryQueueStore.read();
    } catch (err: any) {
      console.error(
        `[cctp-relay] Failed to read persisted retry queue (${err.message}). Starting with an empty queue; check relayer/state/cctp-retry-queue.json.`,
      );
      return;
    }
    if (!data || data.entries.length === 0) return;

    let restored = 0;
    let dropped = 0;
    for (const persisted of data.entries) {
      const sourceState = this.getChainByDomain(persisted.event.sourceDomain);
      if (!sourceState) {
        console.warn(
          `[cctp-relay] Dropping persisted retry entry for source domain ${persisted.event.sourceDomain} (tx ${persisted.event.txHash}) — chain not configured.`,
        );
        dropped++;
        continue;
      }
      this.retryQueue.push({
        event: deserializeMessageEvent(persisted.event),
        sourceState,
        attempts: persisted.attempts,
        nextRetryAt: persisted.nextRetryAt,
      });
      restored++;
    }
    console.log(
      `[cctp-relay] Restored ${restored} retry-queue entr${restored === 1 ? "y" : "ies"} from disk${dropped > 0 ? ` (dropped ${dropped} for unconfigured chains)` : ""}.`,
    );
    // Re-persist so the file reflects the post-load state (drops removed).
    if (dropped > 0) await this.persistRetryQueue();
  }

  /** Snapshot the current retry queue to disk. Awaited by callers after every queue mutation. */
  private async persistRetryQueue(): Promise<void> {
    try {
      const entries: PersistedRetryEntry[] = this.retryQueue.map((r) => ({
        event: serializeMessageEvent(r.event),
        attempts: r.attempts,
        nextRetryAt: r.nextRetryAt,
      }));
      await this.retryQueueStore.write(entries);
    } catch (err: any) {
      console.error(
        `[cctp-relay] Failed to persist retry queue (${err.message}). In-memory queue is correct; next mutation will retry the write.`,
      );
    }
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

      // Verify connection up-front with the same timeout we'll use during polling.
      const currentBlock = Number(
        await withTimeout(
          provider.getBlockNumber(),
          chainConfig.scanner.rpcTimeoutMs,
          `initChain getBlockNumber ${chainConfig.name}`,
        ),
      );

      const domain = CHAIN_TO_DOMAIN[chainConfig.chainId] || deployment.domain;

      // Load persisted cursor or bootstrap from lookback — same logic as iris-relay.
      const lastProcessedBlock = await this.resolveBootCursor(chainConfig, currentBlock);

      return {
        config: chainConfig,
        provider,
        wallet,
        messageTransmitter,
        tokenMessenger,
        hookRouter,
        domain,
        lastProcessedBlock,
        processedMessages: new Set(),
        lastError: null,
        lastScanAt: 0,
        lastChainHead: 0,
      };
    } catch (e: any) {
      console.error(`    Connection error: ${e.message}`);
      return null;
    }
  }

  /**
   * Decide the starting `lastProcessedBlock` for a chain on cold boot. Mirrors the iris-relay
   * implementation — see `iris-relay.ts::resolveBootCursor` for the full rationale. We keep the
   * two copies in lockstep rather than extracting to a shared helper because cctp-relay is
   * local-mock-only and shouldn't grow a runtime dependency on iris-relay.
   */
  private async resolveBootCursor(
    chainConfig: ChainConfig,
    currentBlock: number,
  ): Promise<number> {
    const { bootLookbackBlocks, maxBootLookbackBlocks } = chainConfig.scanner;
    const lookbackFloor = Math.max(0, currentBlock - bootLookbackBlocks);

    let cursor;
    try {
      cursor = await this.cursorStore.read(chainConfig.name);
    } catch (err: any) {
      console.error(
        `  [cctp-relay] ${chainConfig.name}: Cursor file unreadable (${err.message}). Bootstrapping from lookback floor.`,
      );
      cursor = null;
    }

    if (cursor === null) {
      console.log(
        `  [cctp-relay] ${chainConfig.name}: No persisted cursor — starting from block ${lookbackFloor} (currentBlock=${currentBlock}, lookback=${bootLookbackBlocks})`,
      );
      return lookbackFloor;
    }

    const gap = currentBlock - cursor.lastProcessedBlock;
    if (gap <= 0) {
      console.warn(
        `  [cctp-relay] ${chainConfig.name}: Cursor ${cursor.lastProcessedBlock} ≥ currentBlock ${currentBlock}. Resetting to currentBlock.`,
      );
      return currentBlock;
    }

    if (gap > maxBootLookbackBlocks) {
      console.warn(
        `  [cctp-relay] ${chainConfig.name}: Cursor gap (${gap} blocks) exceeds maxBootLookbackBlocks (${maxBootLookbackBlocks}). Capping resume at block ${lookbackFloor}.`,
      );
      return lookbackFloor;
    }

    console.log(
      `  [cctp-relay] ${chainConfig.name}: Resuming from persisted cursor at block ${cursor.lastProcessedBlock} (gap=${gap} blocks)`,
    );
    return cursor.lastProcessedBlock;
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
        // Dead-letter rather than silently marking processed: the burn is final, so a message we
        // refuse to relay for fee reasons leaves the user's USDC stranded and needs visibility +
        // a durable record for manual relay or a fee-policy change. deadLetter also marks it
        // processed so the scanner won't re-attempt it.
        await this.deadLetter(event, sourceState, "fee-too-low");
        return false;
      }
      console.log(`  Fee check passed: maxFee ${burnFee.maxFee} >= minFee ${minFee}`);
    }

    try {
      const encodedMessage = event.rawMessage;
      console.log(
        `\n  Encoded MessageV2 length: ${(encodedMessage.length - 2) / 2} bytes`
      );

      // Allocate the nonce + broadcast through the shared coordinator (keyed by chainId). Only the
      // broadcast runs inside the critical section; tx.wait() happens after so the per-chain nonce
      // mutex isn't held across the full confirmation latency.
      const tx = await this.nonceCoordinator.withNonce(
        destState.config.chainId,
        destState.provider,
        destState.wallet.address,
        (txNonce) => {
          // Use hookRouter.relayWithHook() to atomically call receiveMessage + hook dispatch
          if (destState.hookRouter) {
            const hookRouter = new ethers.Contract(
              destState.hookRouter,
              HOOK_ROUTER_ABI,
              destState.wallet
            );
            console.log(
              `  Sending relayWithHook to ${destState.config.name} via CCTPHookRouter (tx nonce: ${txNonce})...`
            );
            return hookRouter.relayWithHook(
              encodedMessage,
              "0x", // Empty attestation — mock skips verification
              { nonce: txNonce }
            ) as Promise<ethers.ContractTransactionResponse>;
          }
          const messageTransmitter = new ethers.Contract(
            destState.messageTransmitter,
            MESSAGE_TRANSMITTER_ABI,
            destState.wallet
          );
          console.log(
            `  Sending receiveMessage to ${destState.config.name} (tx nonce: ${txNonce})...`
          );
          return messageTransmitter.receiveMessage(
            encodedMessage,
            "0x", // Empty attestation — mock skips verification
            { nonce: txNonce }
          ) as Promise<ethers.ContractTransactionResponse>;
        }
      );

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
        this.nonceCoordinator.reset(destState.config.chainId);
      }
      console.error(`  [cctp-relay] Relay failed: ${e.message || e}`);

      // Add to retry queue if not already being retried (persisted so a restart resumes it).
      await this.enqueueRetry(event, sourceState, 0);
      return false;
    }
  }

  /**
   * Add a failed message to the retry queue with exponential backoff. Persists the queue on every
   * enqueue so a restart doesn't strand the message (its scan cursor has already advanced past it).
   */
  private async enqueueRetry(
    event: MessageEvent,
    sourceState: ChainState,
    currentAttempts: number
  ): Promise<void> {
    if (currentAttempts >= MAX_RETRIES) {
      console.error(
        `[cctp-relay] Max retries (${MAX_RETRIES}) reached for message ` +
          `${event.sourceDomain}-${event.nonce}. Giving up.`
      );
      // Record durably instead of dropping into a log line — the burn is final, so this message's
      // USDC is stranded until manually relayed.
      await this.deadLetter(event, sourceState, "retries-exhausted");
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
    await this.persistRetryQueue();
  }

  /**
   * Process entries in the retry queue that are ready for retry
   */
  private async processRetryQueue(): Promise<void> {
    const now = Date.now();
    const ready = this.retryQueue.filter((r) => r.nextRetryAt <= now);
    if (ready.length === 0) return;

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
        // Re-queue with incremented attempt count (persists internally).
        await this.enqueueRetry(entry.event, entry.sourceState, entry.attempts);
      }
    }
    // Persist the net queue state: entries removed above on success / give-up aren't re-added by
    // enqueueRetry, so without this their removal wouldn't be durable until the next enqueue.
    await this.persistRetryQueue();
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
      const encodedMessage = event.rawMessage;

      // Same coordinator-mediated broadcast as relayMessage — only the broadcast is inside the
      // per-chain critical section; tx.wait() runs after.
      const tx = await this.nonceCoordinator.withNonce(
        destState.config.chainId,
        destState.provider,
        destState.wallet.address,
        (txNonce) => {
          // Use hookRouter.relayWithHook() if available
          if (destState.hookRouter) {
            const hookRouter = new ethers.Contract(
              destState.hookRouter,
              HOOK_ROUTER_ABI,
              destState.wallet
            );
            return hookRouter.relayWithHook(
              encodedMessage,
              "0x",
              { nonce: txNonce }
            ) as Promise<ethers.ContractTransactionResponse>;
          }
          const messageTransmitter = new ethers.Contract(
            destState.messageTransmitter,
            MESSAGE_TRANSMITTER_ABI,
            destState.wallet
          );
          return messageTransmitter.receiveMessage(
            encodedMessage,
            "0x",
            { nonce: txNonce }
          ) as Promise<ethers.ContractTransactionResponse>;
        }
      );

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
        this.nonceCoordinator.reset(destState.config.chainId);
      }
      console.error(`  [cctp-relay] Retry failed for ${messageKey}: ${e.message || e}`);
      return false;
    }
  }

  /**
   * Poll a chain for new MessageSent events
   */
  private async pollChain(state: ChainState): Promise<void> {
    const { config } = state;
    const { confirmationDepth, maxLogRange, rpcTimeoutMs } = config.scanner;

    try {
      const currentBlock = Number(
        await withTimeout(
          state.provider.getBlockNumber(),
          rpcTimeoutMs,
          `getBlockNumber ${config.name}`,
        ),
      );

      // Capture the freshly-observed head for /health (raw tip, NOT confirmation-adjusted).
      state.lastChainHead = currentBlock;

      // Apply confirmation depth — on Anvil this is 0 so behaviour matches the old code; on
      // any real chain we won't scan reorg-vulnerable tip blocks.
      const effectiveHead = currentBlock - confirmationDepth;
      if (effectiveHead <= state.lastProcessedBlock) {
        state.lastError = null;
        state.lastScanAt = Date.now();
        return;
      }

      const fromBlock = state.lastProcessedBlock + 1;
      const toBlock = effectiveHead;

      const iface = new ethers.Interface(MESSAGE_SENT_ABI);
      const eventTopic = iface.getEvent("MessageSent")?.topicHash;
      if (!eventTopic) {
        console.error("[cctp-relay] Failed to get MessageSent event topic");
        return;
      }

      await getLogsChunked(state.provider, {
        fromBlock,
        toBlock,
        maxRange: maxLogRange,
        filter: {
          address: state.messageTransmitter,
          topics: [eventTopic],
        },
        // Ingest + cursor-advance happen INSIDE the per-chunk callback so the on-disk cursor is
        // always ≤ what's been processed. NOTE: relayMessage swallows relay failures (returns
        // false) and enqueues them on the DURABLE retry queue rather than throwing — so the cursor
        // DOES advance past a failed message, and recovery is owned by the persisted retry queue
        // (rehydrated on the next boot), not by re-scanning. A thrown error here (e.g. the cursor
        // write or a parse fault) still halts the scan with the cursor at chunk N-1's end.
        onChunk: async ({ fromBlock: chunkFrom, toBlockInclusive, logs }) => {
          if (logs.length > 0) {
            console.log(
              `\n[cctp-relay] ${config.name}: Found ${logs.length} message(s) in blocks ${chunkFrom}-${toBlockInclusive}`,
            );
          }
          for (const log of logs) {
            const event = parseMessageEvent(log);
            if (event) {
              await this.relayMessage(event, state);
            }
          }
          state.lastProcessedBlock = toBlockInclusive;
          await this.cursorStore.write(config.name, {
            lastProcessedBlock: toBlockInclusive,
            updatedAt: Date.now(),
          });
        },
      });

      state.lastError = null;
      state.lastScanAt = Date.now();
    } catch (err: any) {
      // No longer silent. Cursor stays put → next tick retries from the same fromBlock.
      const message = err instanceof RpcTimeoutError
        ? `RPC timeout: ${err.label}`
        : err?.message ?? "unknown error";
      state.lastError = { message, at: Date.now() };
      console.error(
        `[cctp-relay] ${config.name}: Scan tick failed: ${message}. Cursor stays at ${state.lastProcessedBlock}; will retry next tick.`,
      );
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

  /** Resolved by `runPollLoop` when it observes isRunning=false and exits. `stop()` awaits it. */
  private loopExited: Promise<void> | null = null;
  private resolveLoopExited: (() => void) | null = null;

  /**
   * Internal polling loop. Yields to `isRunning` between every step so a `stop()` request
   * is honoured promptly without forcing the loop to wait out a full pollInterval first.
   */
  private async runPollLoop(): Promise<void> {
    this.loopExited = new Promise((resolve) => {
      this.resolveLoopExited = resolve;
    });
    try {
      while (this.isRunning) {
        // Poll all chains for new messages — in PARALLEL. pollChain has its own try/catch that
        // writes to state.lastError, so a failure on one chain doesn't reject the Promise
        // (allSettled is belt + braces). One slow chain no longer delays others.
        const chainStates = Array.from(this.chains.values());
        const pollResults = await Promise.allSettled(
          chainStates.map((state) => this.pollChain(state)),
        );
        // Defensive: see iris-relay's runPollLoop for the rationale — log any rejection that
        // somehow slipped past pollChain's inner try/catch.
        for (let i = 0; i < pollResults.length; i++) {
          const r = pollResults[i];
          if (r?.status === "rejected") {
            const chainName = chainStates[i]?.config.name ?? "unknown";
            console.error(
              `[cctp-relay] ${chainName}: pollChain rejected unexpectedly (bypassed inner try/catch): ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
            );
          }
        }

        if (!this.isRunning) break;

        // Process retry queue
        if (this.retryQueue.length > 0) {
          await this.processRetryQueue();
        }

        if (!this.isRunning) break;

        await this.sleepCancellable(this.pollIntervalMs);
      }
    } finally {
      this.resolveLoopExited?.();
    }
  }

  /** See iris-relay::sleepCancellable — same shape, kept lockstep. */
  private async sleepCancellable(totalMs: number): Promise<void> {
    const start = Date.now();
    const step = 100;
    while (this.isRunning && Date.now() - start < totalMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(step, totalMs - (Date.now() - start))),
      );
    }
  }

  /**
   * Async, awaitable shutdown. Same contract as iris-relay::stop — wait for the current poll
   * tick to complete so its cursor write lands before we let the caller `process.exit`.
   * Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    console.log("[cctp-relay] Stopping — waiting for in-flight scan tick to complete...");
    this.isRunning = false;
    if (this.loopExited) await this.loopExited;
    console.log("[cctp-relay] Stopped cleanly.");
  }

  /**
   * Get the number of initialized chains
   */
  get chainCount(): number {
    return this.chains.size;
  }

  /**
   * Snapshot per-chain scanner state for the /health endpoint. Same shape as IrisRelayModule
   * so the http-api consumer is mode-agnostic. `pendingCount` here reflects the retry queue
   * (failed relays awaiting backoff) — the cctp-relay's only "in-flight" state, since
   * successful relays complete inline within the poll tick.
   */
  getHealth(): RelayerHealth {
    const now = Date.now();

    const pendingBySource = new Map<number, number>();
    for (const entry of this.retryQueue) {
      const domain = entry.sourceState.domain;
      pendingBySource.set(domain, (pendingBySource.get(domain) ?? 0) + 1);
    }

    const chains: ChainHealth[] = [];
    for (const state of this.chains.values()) {
      const lagBlocks =
        state.lastChainHead > 0 ? state.lastChainHead - state.lastProcessedBlock : 0;
      const status = classifyChainHealth({
        lastError: state.lastError,
        lastScanAt: state.lastScanAt,
        pollIntervalMs: this.pollIntervalMs,
        lagBlocks,
        now,
      });
      chains.push({
        chainName: state.config.name,
        domain: state.domain,
        status,
        lastProcessedBlock: state.lastProcessedBlock,
        chainHead: state.lastChainHead,
        lagBlocks,
        lastScanAt: state.lastScanAt,
        lastError: state.lastError,
        pendingCount: pendingBySource.get(state.domain) ?? 0,
        deadLetterCount: this.deadLetters.get(state.config.name)?.length ?? 0,
      });
    }

    return {
      status: rollupStatus(chains.map((c) => c.status)),
      chains,
      generatedAt: now,
    };
  }
}
