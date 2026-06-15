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
import { CursorStore } from "../lib/cursor-store";
import { getLogsChunked } from "../lib/get-logs-chunked";
import { PendingStateStore, type PersistedPendingMessage } from "../lib/pending-state-store";
import { RpcTimeoutError, withTimeout } from "../lib/rpc-utils";
import { classifyChainHealth, rollupStatus } from "../lib/health-classifier";
import { NonceCoordinator } from "../lib/nonce-coordinator";
import type { ChainHealth, RelayerHealth } from "../types";

/** Where per-chain cursor files live. Module-relative so the relayer is location-independent. */
const RELAYER_STATE_DIR = path.join(__dirname, "..", "state");

// ============ Types ============

interface PendingMessage {
  /** Raw message bytes from MessageSent event */
  messageBytes: string;
  /**
   * keccak256(messageBytes) — used as the Iris attestation lookup key. NOT used for dedup:
   * CCTP V2's source-side messageBytes have no per-tx-unique field (nonce slot is bytes32(0)),
   * so two identical-amount/recipient burns produce the SAME messageHash. Use `dedupKey` for
   * Map keying + processed-set membership.
   */
  messageHash: string;
  /**
   * Globally-unique-per-log dedup key, format `${sourceTxHash}:${logIndex}`. The canonical EVM
   * identifier for a log emission — guaranteed unique within a chain, immune to message-bytes
   * collisions between two byte-identical burns. Used as the Map key in `pendingMessages` and
   * the entry in `ChainState.processedMessages`.
   */
  dedupKey: string;
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
  /**
   * Number of relayWithHook attempts that FAILED (not counting "already processed" — that's
   * success-equivalent). Capped at MAX_RELAY_RETRIES; on cap we expire the message with a
   * loud log so the operator can manually investigate.
   */
  retryAttempts: number;
  /**
   * Unix ms — when the next relay attempt is allowed. Set to `now + backoffMs` on each failure;
   * `processPendingMessages` skips entries with `nextRetryAt > now`. 0 = no backoff active.
   */
  nextRetryAt: number;
  /**
   * Destination-chain tx hash once `hookRouter.relayWithHook` has broadcast successfully.
   * Presence drives the state machine: set → awaiting confirmation (handled by
   * processInflightRelays); absent → still awaiting Iris attestation (handled by
   * processPendingMessages). The two phases are mutually exclusive per message per tick.
   */
  submittedTxHash?: string;
  /**
   * Unix ms of the broadcast. processInflightRelays uses (now - submittedAt) to detect
   * stuck/dropped txs — past STUCK_TX_THRESHOLD_MS we force a re-submit with a fresh nonce.
   */
  submittedAt?: number;
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
  /** Known contract addresses that can receive CCTP messages on this chain (lowercase, zero-padded bytes32) */
  knownRecipients: Set<string>;
  domain: number;
  /**
   * Highest block we have FULLY scanned (inclusive). Loaded from disk on cold start; advanced
   * after every successful chunk via the cursor store. Restart-safe: a kill -9 mid-poll loses
   * at most one chunk of replay, never the entire scan window.
   */
  lastProcessedBlock: number;
  /**
   * Set of canonical message hashes we've enqueued + completed (relayed OR "already processed"
   * on the destination). Restart-safe via PendingStateStore — survives so we don't burn gas
   * re-relaying messages already delivered before the restart.
   */
  processedMessages: Set<string>;
  /**
   * Last scan error for this chain, or null when the most recent tick succeeded. Surfaces in
   * future health endpoint + immediately makes "scanner stuck" visible to operators. Replaces
   * the silent catch that hid the original Sepolia incident.
   */
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
const MSG_DEST_CALLER_OFFSET = 108;
const MSG_DEST_CALLER_LENGTH = 32;

/**
 * BurnMessageV2 mintRecipient offset within the full MessageV2.
 *
 * In real CCTP V2, the MessageV2 `recipient` field (offset 76) is always the destination
 * TokenMessenger — NOT the final recipient contract. The actual recipient (our PrivacyPool
 * or PrivacyPoolClient) is in the BurnMessageV2 body's `mintRecipient` field:
 *   - BurnMessageV2 starts at MessageV2 offset 148 (messageBody)
 *   - mintRecipient is at BurnMessageV2 offset 36 (after version(4) + burnToken(32))
 *   - Absolute offset in full message: 148 + 36 = 184
 */
const MSG_BODY_OFFSET = 148;
const BURN_MSG_MINT_RECIPIENT_OFFSET = 36;
const MINT_RECIPIENT_ABSOLUTE_OFFSET = MSG_BODY_OFFSET + BURN_MSG_MINT_RECIPIENT_OFFSET;
const MINT_RECIPIENT_LENGTH = 32;

/**
 * Max time to keep polling for an attestation before giving up (ms). Default 60 min, configurable
 * via `RELAYER_ATTESTATION_AGE_MS` env var. The previous 30-min default was thin for mainnet —
 * Ethereum standard-finality CCTP attestations land at 15-19 min and occasionally take longer.
 */
const MAX_ATTESTATION_AGE_MS = (() => {
  const raw = process.env.RELAYER_ATTESTATION_AGE_MS;
  if (raw === undefined || raw === "") return 60 * 60 * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 60_000) {
    throw new Error(
      `Invalid RELAYER_ATTESTATION_AGE_MS=${raw} — expected a number ≥ 60000 (1 minute floor).`,
    );
  }
  return parsed;
})();

/**
 * Per-message retry policy for failed relayWithHook submissions. Mirrors cctp-relay's
 * RetryEntry constants. 5 attempts with exponential backoff (2s/4s/8s/16s/32s) — total ~62s
 * before giving up, which is enough to ride out a brief destination-chain RPC blip without
 * pinning the loop on a permanently-failing tx.
 */
const MAX_RELAY_RETRIES = 5;
const RELAY_RETRY_BASE_DELAY_MS = 2_000;

/**
 * How long an in-flight broadcast can sit without a receipt before we treat it as stuck/dropped
 * and re-submit with a fresh nonce. Default 10 min — Ethereum L1 finality is ~12s under normal
 * conditions, so 50× headroom for genuinely-dropped txs (mempool eviction, replacement-fee
 * loss, etc.). Configurable via `RELAYER_STUCK_TX_THRESHOLD_MS` env var.
 *
 * Re-submit goes through the normal retry/backoff machinery — the message gets
 * `submittedTxHash` cleared so it re-enters processPendingMessages → submitRelay with
 * `retryAttempts` bumped.
 */
const STUCK_TX_THRESHOLD_MS = (() => {
  const raw = process.env.RELAYER_STUCK_TX_THRESHOLD_MS;
  if (raw === undefined || raw === "") return 10 * 60 * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 60_000) {
    throw new Error(
      `Invalid RELAYER_STUCK_TX_THRESHOLD_MS=${raw} — expected a number ≥ 60000 (1 minute floor).`,
    );
  }
  return parsed;
})();

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
  nonce: string; // full bytes32 hex (may be zero in event — Iris fills in real nonce)
  mintRecipient: string; // bytes32 hex (lowercase) — from BurnMessageV2 body
  destinationCaller: string; // bytes32 hex (lowercase)
} {
  // Remove 0x prefix
  const hex = messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex;

  const sourceDomain = parseInt(hex.slice(MSG_SOURCE_DOMAIN_OFFSET * 2, (MSG_SOURCE_DOMAIN_OFFSET + 4) * 2), 16);
  const destinationDomain = parseInt(hex.slice(MSG_DEST_DOMAIN_OFFSET * 2, (MSG_DEST_DOMAIN_OFFSET + 4) * 2), 16);
  // In real CCTP V2, the nonce in the MessageSent event is a placeholder (zero).
  // Iris assigns the real nonce and returns it in the corrected message.
  const nonce = "0x" + hex.slice(MSG_NONCE_OFFSET * 2, (MSG_NONCE_OFFSET + MSG_NONCE_LENGTH) * 2);
  const destinationCaller = "0x" + hex.slice(MSG_DEST_CALLER_OFFSET * 2, (MSG_DEST_CALLER_OFFSET + MSG_DEST_CALLER_LENGTH) * 2).toLowerCase();

  // Parse mintRecipient from BurnMessageV2 body (the actual destination contract).
  // MessageV2.recipient (offset 76) is always the dest TokenMessenger in real CCTP V2.
  let mintRecipient = "";
  const mintRecipientEnd = (MINT_RECIPIENT_ABSOLUTE_OFFSET + MINT_RECIPIENT_LENGTH) * 2;
  if (hex.length >= mintRecipientEnd) {
    mintRecipient = "0x" + hex.slice(MINT_RECIPIENT_ABSOLUTE_OFFSET * 2, mintRecipientEnd).toLowerCase();
  }

  return { sourceDomain, destinationDomain, nonce, mintRecipient, destinationCaller };
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
  /**
   * In-flight messages keyed by dedupKey (`${sourceTxHash}:${logIndex}`). Globally scoped
   * across all source chains because messageHash → dedupKey routing carries the sourceDomain
   * on each entry.
   *
   * CONCURRENCY: this Map is touched only from inside the single Node.js event loop. The
   * relayer is a single-process service; `pollChain` runs sequentially per chain (no two
   * concurrent enqueues for the same chain) and the cross-chain `Promise.allSettled` in
   * `runPollLoop` parallelises across chains but never interleaves microtasks mid-tick within
   * one chain's scan. JS single-threaded execution guarantees the `has(dedupKey) → set(...)`
   * pair in `enqueueMessage` cannot be torn by another writer. No lock is required.
   */
  private pendingMessages: Map<string, PendingMessage> = new Map();
  /**
   * Destination tx hashes we've already logged as "stuck in mempool" (likely underpriced), so the
   * per-tick poll doesn't re-log the same incident every cycle. Ephemeral — not persisted; a
   * restart re-logs once, which is fine. Entries are removed when the message leaves the in-flight
   * state (mined / reverted / dropped-and-resubmitted).
   */
  private mempoolStuckWarned: Set<string> = new Set();
  private cursorStore: CursorStore;
  private pendingStateStore: PendingStateStore;
  /**
   * Process-wide nonce authority, shared with the privacy relay's WalletManager. All three submit
   * paths sign from the same EOA on the same chains, so a single coordinator is what keeps their
   * nonce views from colliding (one path replacing another's tx in the mempool).
   */
  private nonceCoordinator: NonceCoordinator;

  constructor(nonceCoordinator: NonceCoordinator) {
    const { iris } = armadaRelayerSettings;
    this.pollIntervalMs = armadaRelayerSettings.cctpPollIntervalMs;
    this.irisClient = new IrisClient(iris.apiUrl);
    this.cursorStore = new CursorStore(RELAYER_STATE_DIR);
    this.pendingStateStore = new PendingStateStore(RELAYER_STATE_DIR);
    this.nonceCoordinator = nonceCoordinator;
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
        if (state.knownRecipients.size > 0) {
          console.log(`    Known recipients: ${Array.from(state.knownRecipients).map(r => r.slice(0, 20) + "...").join(", ")}`);
        }
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

      // Load hookRouter and known recipient addresses from privacy pool deployment
      let hookRouter: string | null = null;
      const knownRecipients = new Set<string>();
      const ppDeployment = loadDeployment(chainConfig.privacyPoolDeploymentFile);
      if (ppDeployment?.contracts?.hookRouter) {
        hookRouter = ppDeployment.contracts.hookRouter;
      }
      // Collect known CCTP recipient addresses for this chain (used to filter foreign messages)
      const poolAddr = ppDeployment?.contracts?.privacyPool || ppDeployment?.contracts?.privacyPoolClient;
      if (poolAddr) {
        knownRecipients.add(ethers.zeroPadValue(poolAddr, 32).toLowerCase());
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

      // Load persisted cursor or bootstrap from lookback. This is the fix for the cold-start
      // hole: the prior code set lastProcessedBlock = currentBlock and silently skipped any
      // MessageSent emitted before the relayer started OR during a restart window.
      const lastProcessedBlock = await this.resolveBootCursor(chainConfig, currentBlock);

      // Load persisted pendingMessages + processedMessages — restart-safe. Without this, any
      // message that was mid-attestation when the relayer stopped would have to be
      // re-discovered by the scanner (works because cursor is persisted), but messages already
      // successfully relayed before restart would be re-relayed and burn gas on the contract's
      // "already processed" check.
      const processedMessages = new Set<string>();
      try {
        const persisted = await this.pendingStateStore.read(chainConfig.name);
        if (persisted) {
          // Re-hydrate pendingMessages from disk. Keyed by dedupKey in the module-level Map;
          // entries from THIS source chain get added back so processPendingMessages can continue
          // waiting on Iris where we left off (preserving pollAttempts / retry state).
          let restored = 0;
          for (const p of persisted.pending) {
            this.pendingMessages.set(p.dedupKey, p);
            restored++;
          }
          for (const hash of persisted.processed) {
            processedMessages.add(hash);
          }
          if (restored > 0 || persisted.processed.length > 0) {
            console.log(
              `  [iris-relay] ${chainConfig.name}: Restored ${restored} pending + ${persisted.processed.length} processed message(s) from disk`,
            );
          }
        }
      } catch (err: any) {
        console.error(
          `  [iris-relay] ${chainConfig.name}: Pending-state file unreadable (${err.message}). Starting with empty pending state — Iris will re-attest any in-flight message and the next scan will re-discover them via the cursor.`,
        );
      }

      return {
        config: chainConfig,
        provider,
        wallet,
        messageTransmitter,
        hookRouter,
        knownRecipients,
        domain: chainConfig.cctpDomain,
        lastProcessedBlock,
        processedMessages,
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
   * Decide the starting `lastProcessedBlock` for a chain on cold boot. Three cases:
   *
   *   1. A valid cursor file exists AND the gap to chain head is reasonable → resume from it.
   *      We replay anything between the persisted cursor and the current head. The contract's
   *      "already processed" check absorbs any duplicate relays at a small gas cost.
   *
   *   2. A cursor file exists BUT the gap exceeds `maxBootLookbackBlocks` → the relayer was
   *      offline for so long that a full backfill would burn through RPC quota for messages
   *      Iris has long since expired anyway. Cap at `currentBlock - bootLookbackBlocks` and
   *      emit a loud warning so the operator knows historical messages were skipped.
   *
   *   3. No cursor file (true cold start / fresh deployment) → bootstrap from
   *      `currentBlock - bootLookbackBlocks` so we recover any MessageSent in the recent past.
   *      Previously this branch set lastProcessed = currentBlock, dropping in-flight messages.
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
      // A malformed cursor file is operator-actionable but we must not crash the relayer on
      // startup. Log loudly and fall through to lookback bootstrap.
      console.error(
        `  [iris-relay] ${chainConfig.name}: Cursor file unreadable (${err.message}). Bootstrapping from lookback floor — DELETE the cursor file at relayer/state/cursor-${chainConfig.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}.json after investigating.`,
      );
      cursor = null;
    }

    if (cursor === null) {
      console.log(
        `  [iris-relay] ${chainConfig.name}: No persisted cursor — starting from block ${lookbackFloor} (currentBlock=${currentBlock}, lookback=${bootLookbackBlocks})`,
      );
      return lookbackFloor;
    }

    const gap = currentBlock - cursor.lastProcessedBlock;
    if (gap <= 0) {
      // Cursor is at or ahead of chain head (chain reorg? cursor written then chain reset?).
      // Reset to current head to avoid scanning the future.
      console.warn(
        `  [iris-relay] ${chainConfig.name}: Cursor ${cursor.lastProcessedBlock} ≥ currentBlock ${currentBlock}. Resetting to currentBlock.`,
      );
      return currentBlock;
    }

    if (gap > maxBootLookbackBlocks) {
      console.warn(
        `  [iris-relay] ${chainConfig.name}: Cursor gap (${gap} blocks) exceeds maxBootLookbackBlocks (${maxBootLookbackBlocks}). Capping resume at block ${lookbackFloor}. Messages between ${cursor.lastProcessedBlock} and ${lookbackFloor} will NOT be relayed — Iris will have expired their attestations anyway. Manual recovery via Iris API + relayWithHook if needed.`,
      );
      return lookbackFloor;
    }

    console.log(
      `  [iris-relay] ${chainConfig.name}: Resuming from persisted cursor at block ${cursor.lastProcessedBlock} (gap=${gap} blocks)`,
    );
    return cursor.lastProcessedBlock;
  }

  private getChainByDomain(domain: number): ChainState | undefined {
    return this.chains.get(domain);
  }

  /**
   * Snapshot this chain's pending + processed state to disk. Called from every mutation site
   * (enqueueMessage, processPendingMessages success/failure/expiry). One write per chain per
   * mutation batch — bounded by chain count, not by message count.
   *
   * Errors are logged but NOT propagated. The next mutation will retry the write; in the
   * meantime the in-memory state is correct and the relay loop continues. Persistence is
   * best-effort within a tick but eventually-consistent (we'd lose at most one tick's worth
   * of state if the disk goes away entirely).
   */
  private async persistChain(state: ChainState): Promise<void> {
    try {
      const pendingForChain: PersistedPendingMessage[] = [];
      for (const msg of this.pendingMessages.values()) {
        if (msg.sourceDomain === state.domain) {
          pendingForChain.push(msg);
        }
      }
      await this.pendingStateStore.write(
        state.config.name,
        pendingForChain,
        state.processedMessages,
      );
    } catch (err: any) {
      console.error(
        `  [iris-relay] ${state.config.name}: Failed to persist pending state (${err.message}). In-memory state is correct; next mutation will retry.`,
      );
    }
  }

  // ========== Event Scanning ==========

  /**
   * Poll a chain for new MessageSent events from real CCTP. Resilient against the failure modes
   * that produced the original silent-stall incident:
   *
   *  - **Cursor-checkpointed scanning**: the scan window is split into chunks of `maxLogRange`
   *    blocks (1000 by default — the checkpoint cadence, NOT a per-call RPC cap). After each
   *    chunk completes, the cursor is persisted to disk via `onChunk`. A failure mid-window
   *    loses at most one chunk's worth of replay on the next tick.
   *
   *  - **Per-call RPC cap adaptation**: the eth_getLogs prototype patch (`lib/rpc-bisecting.ts`,
   *    installed once at startup) intercepts every getLogs call and recursively halves on
   *    "range too large" errors. Means we don't need to know the provider's cap (Alchemy free
   *    = 10 blocks, drpc varies, Infura = 10k) — bisection adapts at call time.
   *
   *  - **Confirmation depth**: scans only up to `currentBlock - confirmationDepth` so a reorg
   *    between detection and `relayWithHook` can't have us submitting attestations for vanished
   *    messages.
   *
   *  - **RPC timeouts**: every provider call is wrapped in `withTimeout`, so a dead socket
   *    can't pin the poll loop indefinitely.
   *
   *  - **Loud errors**: replaces the swallow-everything `catch {}` with structured logging and
   *    a `lastError` field on chain state. The cursor does NOT advance on error — next tick
   *    retries from the same fromBlock, with the chunker shrinking the window if needed.
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

      // Capture the freshly-observed head BEFORE applying confirmationDepth so /health reports
      // raw chain head (operators want "where's the tip" not "what's the last finalised block").
      state.lastChainHead = currentBlock;

      // Apply confirmation depth — don't scan tip-of-chain blocks that might be reorg'd out.
      const effectiveHead = currentBlock - confirmationDepth;
      if (effectiveHead <= state.lastProcessedBlock) {
        // No new "safe" blocks since last scan; common steady-state path.
        state.lastError = null;
        state.lastScanAt = Date.now();
        return;
      }

      const fromBlock = state.lastProcessedBlock + 1;
      const toBlock = effectiveHead;

      // Real CCTP emits: event MessageSent(bytes message)
      const iface = new ethers.Interface(REAL_MESSAGE_SENT_ABI);
      const eventTopic = iface.getEvent("MessageSent")?.topicHash;
      if (!eventTopic) return;

      await getLogsChunked(state.provider, {
        fromBlock,
        toBlock,
        maxRange: maxLogRange,
        filter: {
          address: state.messageTransmitter,
          topics: [eventTopic],
        },
        // Ingest + cursor-advance happen INSIDE the per-chunk callback so the on-disk cursor
        // is always ≤ what's been enqueued. A crash between chunks loses zero un-ingested
        // logs: the cursor reflects the last fully-ingested chunk.
        onChunk: async ({ fromBlock: chunkFrom, toBlockInclusive, logs }) => {
          if (logs.length > 0) {
            console.log(
              `\n[iris-relay] ${config.name}: Found ${logs.length} message(s) in blocks ${chunkFrom}-${toBlockInclusive}`,
            );
          }
          let enqueuedAny = false;
          for (const log of logs) {
            if (this.enqueueMessage(log, state)) enqueuedAny = true;
          }
          // ORDER MATTERS: persist any newly-enqueued pending entries to disk BEFORE advancing
          // the cursor. The invariant is "pending-state durable ⇒ cursor durable", never the
          // reverse — a crash with the cursor ahead of un-persisted pending state would orphan
          // those messages (restart skips their blocks, scanner never re-discovers them).
          if (enqueuedAny) {
            await this.persistChain(state);
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
      // NO LONGER SILENT. Structured error log + state.lastError so the future health endpoint
      // can surface a stuck scanner. Cursor stays put so the next tick retries the same window.
      const message = err instanceof RpcTimeoutError
        ? `RPC timeout: ${err.label}`
        : err?.message ?? "unknown error";
      state.lastError = { message, at: Date.now() };
      console.error(
        `[iris-relay] ${state.config.name}: Scan tick failed: ${message}. Cursor stays at ${state.lastProcessedBlock}; will retry next tick.`,
      );
    }
  }

  /**
   * Parse a MessageSent event and add it to the pending queue.
   *
   * Returns `true` when a NEW pending entry was added (so the caller knows it must persist the
   * source chain before advancing the cursor), `false` for every skip/filter/dedup path.
   * Crucially, this method no longer persists on its own — the caller (`onChunk`) owns the
   * persist→cursor ordering so the on-disk cursor never leads un-persisted pending state.
   */
  private enqueueMessage(log: ethers.Log, sourceState: ChainState): boolean {
    const iface = new ethers.Interface(REAL_MESSAGE_SENT_ABI);
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) {
      // Topic matched MessageSent but the ABI decoder couldn't parse the payload — almost
      // certainly an ABI mismatch (event signature drift on chain, or non-CCTP contract reusing
      // the same topic on the same address). Loud-log so operators can investigate; without
      // this the scanner would silently swallow valid-looking messages.
      console.warn(
        `[iris-relay] ${sourceState.config.name}: MessageSent ABI parse failed for tx ${log.transactionHash} log index ${log.index}. Skipping.`,
      );
      return false;
    }

    const messageBytes: string = parsed.args[0];
    const messageHash = ethers.keccak256(messageBytes);

    // Dedup key — `${sourceTxHash}:${logIndex}`. We deliberately do NOT dedup on messageHash:
    // CCTP V2 leaves the source nonce slot at bytes32(0) and our burn body has no per-tx-unique
    // field, so two unshields with the same {amount, maxFee, finalRecipient} produce
    // byte-identical messageBytes (and thus identical hashes). (sourceTxHash, logIndex) is the
    // canonical EVM identifier for a log emission and cannot collide between distinct burns.
    const dedupKey = `${log.transactionHash}:${log.index}`;

    // Already processed (delivered + persisted) — short-circuit to avoid re-relay. Logged so
    // a re-discovery (cursor rewind, restart with stale state) is visible to operators rather
    // than disappearing silently. Steady-state scanning shouldn't re-discover the same log
    // because the cursor advances past it.
    if (sourceState.processedMessages.has(dedupKey)) {
      console.log(
        `  [iris-relay] ${sourceState.config.name}: skip ${dedupKey} — already in processedMessages (previously delivered).`,
      );
      return false;
    }
    // Already queued in this process — re-discovery of an in-flight message (also non-steady
    // state). Same diagnostic value as the processed-set check.
    if (this.pendingMessages.has(dedupKey)) {
      console.log(
        `  [iris-relay] ${sourceState.config.name}: skip ${dedupKey} — already in pendingMessages (in-flight).`,
      );
      return false;
    }

    const { sourceDomain, destinationDomain, nonce, mintRecipient, destinationCaller } = parseMessageFields(messageBytes);

    const destState = this.getChainByDomain(destinationDomain);
    if (!destState) {
      console.log(`  [iris-relay] Unknown destination domain ${destinationDomain}, skipping`);
      return false;
    }

    // Filter: only relay messages where BurnMessageV2.mintRecipient matches our contracts.
    // On real CCTP V2, the MessageV2.recipient is always the dest TokenMessenger (shared),
    // so we check mintRecipient (the actual contract that receives minted tokens).
    if (destState.knownRecipients.size > 0 && mintRecipient && !destState.knownRecipients.has(mintRecipient)) {
      // Not our message — someone else's CCTP transfer on the shared MessageTransmitter. Log
      // it so a misconfigured knownRecipients set (stale deployment file, address typo) doesn't
      // present as "the relayer silently dropped my message." Includes both the rejected
      // mintRecipient and the expected set so operators can diff them.
      console.log(
        `  [iris-relay] ${sourceState.config.name}: skip ${dedupKey} — mintRecipient ${mintRecipient} not in ${destState.config.name}'s knownRecipients ` +
          `[${Array.from(destState.knownRecipients).join(", ")}]. Either a foreign CCTP transfer on the shared MessageTransmitter OR a deployment-address drift.`,
      );
      return false;
    }

    // Filter: if destinationCaller is set and doesn't match our hookRouter, skip
    const zeroCaller = "0x" + "0".repeat(64);
    if (destinationCaller !== zeroCaller && destState.hookRouter) {
      const ourHookRouterBytes32 = ethers.zeroPadValue(destState.hookRouter, 32).toLowerCase();
      if (destinationCaller !== ourHookRouterBytes32) {
        console.log(`  [iris-relay] Message destinationCaller ${destinationCaller.slice(0, 20)}... doesn't match our HookRouter, skipping`);
        return false;
      }
    }

    const pending: PendingMessage = {
      messageBytes,
      messageHash,
      dedupKey,
      sourceDomain,
      destinationDomain,
      nonce,
      sourceTxHash: log.transactionHash,
      sourceBlock: log.blockNumber,
      detectedAt: Date.now(),
      pollAttempts: 0,
      lastStatus: "new",
      retryAttempts: 0,
      nextRetryAt: 0,
    };

    this.pendingMessages.set(dedupKey, pending);
    // NOTE: the persist happens in `onChunk` (awaited, BEFORE the cursor write) — not here. That
    // ordering is the crash-safety contract: a durable cursor must never lead un-persisted pending
    // entries, or a crash would orphan this message (the cursor skips its block on restart and the
    // scanner never re-discovers it).

    const irisUrl = this.irisClient.getUrl(sourceDomain, log.transactionHash);

    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `[iris-relay] QUEUED: ${sourceState.config.name} (Domain ${sourceDomain}) -> ${destState.config.name} (Domain ${destinationDomain})`
    );
    console.log(`${"=".repeat(60)}`);
    console.log(`  Msg Hash:    ${messageHash}`);
    console.log(`  Source Tx:   ${log.transactionHash}`);
    console.log(`  MintRecipient: ${mintRecipient || "unknown"}`);
    console.log(`  Msg length:  ${(messageBytes.length - 2) / 2} bytes`);
    console.log(`  Iris URL:    ${irisUrl}`);
    console.log(`  Queued for attestation polling (non-blocking)`);
    return true;
  }

  // ========== Attestation Polling & Relay ==========

  /**
   * Check all pending messages for attestations and relay any that are ready.
   * Called once per poll cycle — never blocks.
   */
  private async processPendingMessages(): Promise<void> {
    if (this.pendingMessages.size === 0) return;

    const entries = Array.from(this.pendingMessages.entries());
    // Track which source chains had any state mutation this tick so we persist them ONCE at
    // the end rather than per-message — keeps disk write count linear in chains, not messages.
    const dirtyChains = new Set<ChainState>();

    for (const [hash, msg] of entries) {
      const sourceState = this.getChainByDomain(msg.sourceDomain);

      // Check if expired
      const age = Date.now() - msg.detectedAt;
      if (age > MAX_ATTESTATION_AGE_MS) {
        // Loud expiry log — distinct from steady-state console.log so operators monitoring for
        // EXPIRED have an actionable signal before the message is dropped from memory + disk.
        console.error(
          `\n[iris-relay] EXPIRED: message ${hash.slice(0, 18)}... after ${elapsed(msg.detectedAt)} ` +
          `(${msg.pollAttempts} polls, ${msg.retryAttempts} relay retries, last status: ${msg.lastStatus})`
        );
        console.error(`  Source Tx: ${msg.sourceTxHash}`);
        console.error(`  Iris URL:  ${this.irisClient.getUrl(msg.sourceDomain, msg.sourceTxHash)}`);
        console.error(`  Manual recovery: fetch attestation from Iris + call hookRouter.relayWithHook on destination chain.`);
        this.pendingMessages.delete(hash);
        if (sourceState) dirtyChains.add(sourceState);
        continue;
      }

      // Skip if this message has already been broadcast and is waiting for receipt
      // confirmation — that's processInflightRelays's domain, not ours. The state-machine
      // marker is `submittedTxHash`.
      if (msg.submittedTxHash) {
        continue;
      }

      // Skip if we're inside a backoff window from a prior relay failure. The scanner keeps
      // the message in pendingMessages so it's surfaced again on the next tick after the
      // backoff expires.
      if (msg.nextRetryAt > Date.now()) {
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

      // Attestation ready — submit to destination chain (non-blocking — receipt polled later).
      console.log(
        `\n[iris-relay] ATTESTATION READY for ${hash.slice(0, 18)}... after ${elapsed(msg.detectedAt)} (${msg.pollAttempts} polls)`
      );

      const outcome = await this.submitRelay(msg, result.attestation, result.message);
      if (outcome === "submitted") {
        // submitRelay set msg.submittedTxHash + msg.submittedAt. Keep the message in pending —
        // processInflightRelays will pick it up next tick to confirm. Mark the source chain
        // dirty so the persist below captures the new submittedTxHash.
        if (sourceState) dirtyChains.add(sourceState);
      } else if (outcome === "already-processed") {
        // The destination contract reports we (or someone) already delivered this. Treat as
        // success — mark processed and remove from pending. Common after a crash mid-submit.
        if (sourceState) sourceState.processedMessages.add(hash);
        this.pendingMessages.delete(hash);
        if (sourceState) dirtyChains.add(sourceState);
      } else {
        // outcome === "failed" — broadcast rejected (revert, RPC error, nonce drift). Bump
        // retry counter and schedule backoff, or give up at cap.
        msg.retryAttempts++;
        if (msg.retryAttempts >= MAX_RELAY_RETRIES) {
          console.error(
            `[iris-relay] GAVE UP on submitRelay for ${hash.slice(0, 18)}... after ${msg.retryAttempts} attempts. Source Tx: ${msg.sourceTxHash}. Manual recovery may be required.`,
          );
          this.pendingMessages.delete(hash);
          if (sourceState) dirtyChains.add(sourceState);
        } else {
          // Exponential backoff: 2s, 4s, 8s, 16s, 32s for attempts 1-5.
          const backoffMs = RELAY_RETRY_BASE_DELAY_MS * Math.pow(2, msg.retryAttempts - 1);
          msg.nextRetryAt = Date.now() + backoffMs;
          console.log(
            `  [iris-relay] submitRelay retry ${msg.retryAttempts}/${MAX_RELAY_RETRIES} for ${hash.slice(0, 18)}... in ${backoffMs}ms`,
          );
          if (sourceState) dirtyChains.add(sourceState);
        }
      }
    }

    // One disk write per dirty chain at end-of-tick — bounded by chain count, not message count.
    for (const state of dirtyChains) {
      await this.persistChain(state);
    }
  }

  /**
   * Phase 2B: receipt polling for in-flight relays. Runs once per poll tick per chain — checks
   * each pending message whose `submittedTxHash` is set (broadcast happened, awaiting receipt).
   *
   * Three outcomes per message:
   *  1. Receipt arrived, status=success → mark processed, remove from pending. Done.
   *  2. Receipt arrived, status=reverted → bump retryAttempts, clear submittedTxHash so the
   *     message re-enters submitRelay next cycle. Existing backoff applies.
   *  3. No receipt yet AND time since submit > STUCK_TX_THRESHOLD_MS → assume mempool eviction
   *     or dropped tx, force re-submit (same path as revert above).
   *
   * Otherwise (no receipt, within threshold) just continue waiting.
   *
   * Receipts are fetched in parallel via Promise.allSettled — a single chain's RPC can
   * typically handle a handful of getTransactionReceipt calls in flight.
   */
  private async processInflightRelays(state: ChainState): Promise<void> {
    // Collect in-flight messages for THIS chain. We use the message's destinationDomain since
    // submittedTxHash is on the destination chain — that's where we poll for receipts.
    const inflight: Array<{ hash: string; msg: PendingMessage }> = [];
    for (const [hash, msg] of this.pendingMessages.entries()) {
      if (msg.submittedTxHash && msg.destinationDomain === state.domain) {
        inflight.push({ hash, msg });
      }
    }
    if (inflight.length === 0) return;

    const { rpcTimeoutMs } = state.config.scanner;
    const now = Date.now();

    // Fetch receipts in parallel. Each lookup wraps in withTimeout — a stuck RPC on one tx
    // can't pin the whole loop.
    const receipts = await Promise.allSettled(
      inflight.map(({ msg }) =>
        withTimeout(
          state.provider.getTransactionReceipt(msg.submittedTxHash!),
          rpcTimeoutMs,
          `getTransactionReceipt ${state.config.name} ${msg.submittedTxHash!.slice(0, 12)}`,
        ),
      ),
    );

    let mutated = false;
    for (let i = 0; i < inflight.length; i++) {
      const { hash, msg } = inflight[i]!;
      const result = receipts[i]!;

      if (result.status === "rejected") {
        // RPC error / timeout while checking. Don't mutate state — next tick retries the same
        // receipt lookup. Log once per N attempts to avoid spamming for persistent issues.
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(
          `  [iris-relay] ${state.config.name}: getTransactionReceipt ${msg.submittedTxHash!.slice(0, 18)}... failed (${reason}). Will retry next tick.`,
        );
        continue;
      }

      const receipt = result.value;
      if (receipt === null) {
        // Still pending. Check stuck threshold.
        const sinceSubmit = now - (msg.submittedAt ?? now);
        if (sinceSubmit > STUCK_TX_THRESHOLD_MS) {
          // Distinguish the two stuck causes — they need OPPOSITE handling:
          //   - dropped from the mempool: the nonce was never consumed, so we reset the
          //     coordinator (re-seed from getTransactionCount('pending') returns the dropped
          //     nonce) and re-submit, FILLING the gap. This is the H2 fix.
          //   - still in the mempool (underpriced): re-submitting at a fresh nonce would gap
          //     behind this tx and never mine; the only real recovery is a same-nonce fee-bump
          //     replacement, which is out of scope here. Resetting would be useless (the pending
          //     count still includes this tx). So we leave it in flight and surface it loudly.
          const stuckTxHash = msg.submittedTxHash!;
          let stillInMempool = false;
          try {
            const txn = await withTimeout(
              state.provider.getTransaction(stuckTxHash),
              rpcTimeoutMs,
              `getTransaction ${state.config.name} ${stuckTxHash.slice(0, 12)}`,
            );
            // Present in the node but not yet mined → still queued in the mempool.
            stillInMempool = txn !== null && txn.blockNumber === null;
          } catch (e: any) {
            // Lookup failed — treat as unknown and fall through to the dropped/reset path, which
            // is safe: re-seeding from 'pending' yields the correct next nonce in either case once
            // the node is reachable again.
            console.warn(
              `  [iris-relay] ${state.config.name}: getTransaction ${stuckTxHash.slice(0, 18)}... failed (${e?.message ?? e}); assuming dropped.`,
            );
          }

          if (stillInMempool) {
            // Log once per incident to avoid per-tick spam; no state mutation — keep polling.
            if (!this.mempoolStuckWarned.has(stuckTxHash)) {
              this.mempoolStuckWarned.add(stuckTxHash);
              console.error(
                `[iris-relay] STUCK TX (in mempool, likely underpriced): ${stuckTxHash.slice(0, 18)}... no receipt after ${Math.round(sinceSubmit / 1000)}s. A same-nonce fee-bump replacement is required (operator action) — NOT auto-resubmitting to avoid a nonce gap.`,
              );
            }
            continue;
          }

          console.error(
            `[iris-relay] STUCK TX (dropped from mempool): ${stuckTxHash.slice(0, 18)}... no receipt after ${Math.round(sinceSubmit / 1000)}s (>${Math.round(STUCK_TX_THRESHOLD_MS / 1000)}s threshold). Resetting nonce coordinator + re-submitting on next cycle.`,
          );
          // The dropped tx never consumed its nonce — re-seed so the resubmit fills the gap.
          this.nonceCoordinator.reset(state.config.chainId);
          this.mempoolStuckWarned.delete(stuckTxHash);
          this.scheduleResubmit(msg, state.config.name);
          mutated = true;
        }
        continue;
      }

      if (receipt.status === 1) {
        // Success — mark processed and remove from pending.
        this.mempoolStuckWarned.delete(msg.submittedTxHash!);
        const sourceState = this.getChainByDomain(msg.sourceDomain);
        if (sourceState) sourceState.processedMessages.add(hash);
        this.pendingMessages.delete(hash);
        console.log(
          `[iris-relay] ${state.config.name}: confirmed ${msg.submittedTxHash!.slice(0, 18)}... in block ${receipt.blockNumber} (${msg.retryAttempts} retries, ${Math.round((now - (msg.submittedAt ?? now)) / 1000)}s submit→confirm)`,
        );
        // Persist BOTH chains: the source chain (for processedMessages add + pending delete)
        // AND the destination chain (no state mutation but conceptually relevant). We only
        // mark the source dirty here; the destination's pending state for this message
        // already ran through the source's persistChain since pendingMessages is keyed by
        // dedupKey globally.
        if (sourceState) await this.persistChain(sourceState);
        mutated = true;
      } else {
        // Reverted on chain — re-submit through the retry/backoff path. The nonce was consumed
        // by the reverted tx (it mined), so we do NOT reset the coordinator — the next submit
        // correctly gets the following nonce.
        console.error(
          `[iris-relay] REVERTED on chain: ${msg.submittedTxHash!.slice(0, 18)}... (tx mined but receipt.status=0). Will re-submit through retry/backoff.`,
        );
        this.mempoolStuckWarned.delete(msg.submittedTxHash!);
        this.scheduleResubmit(msg, state.config.name);
        mutated = true;
      }
    }

    // Persist any source chain whose state changed (stuck/revert clears submittedTxHash, success
    // already persisted inline above to minimise the crash-recovery window).
    if (mutated) {
      const dirtySourceChains = new Set<ChainState>();
      for (const { msg } of inflight) {
        const sourceState = this.getChainByDomain(msg.sourceDomain);
        if (sourceState) dirtySourceChains.add(sourceState);
      }
      for (const dirtyState of dirtySourceChains) {
        await this.persistChain(dirtyState);
      }
    }
  }

  /**
   * Move a message from "awaiting confirmation" back into "needs submit" — clears
   * submittedTxHash + submittedAt, bumps retryAttempts + schedules backoff. The next
   * processPendingMessages tick re-submits via the nonce coordinator, which hands out the next
   * unconsumed nonce for the destination chain.
   *
   * Shared between revert + stuck-tx paths since both want the same outcome.
   */
  private scheduleResubmit(msg: PendingMessage, chainLabel: string): void {
    msg.submittedTxHash = undefined;
    msg.submittedAt = undefined;
    msg.retryAttempts++;
    if (msg.retryAttempts >= MAX_RELAY_RETRIES) {
      console.error(
        `[iris-relay] ${chainLabel}: GAVE UP on ${msg.dedupKey} (hash ${msg.messageHash.slice(0, 18)}...) after ${msg.retryAttempts} attempts. Source Tx: ${msg.sourceTxHash}. Manual recovery may be required.`,
      );
      this.pendingMessages.delete(msg.dedupKey);
    } else {
      const backoffMs = RELAY_RETRY_BASE_DELAY_MS * Math.pow(2, msg.retryAttempts - 1);
      msg.nextRetryAt = Date.now() + backoffMs;
      console.log(
        `  [iris-relay] ${chainLabel}: re-submit retry ${msg.retryAttempts}/${MAX_RELAY_RETRIES} for ${msg.messageHash.slice(0, 18)}... in ${backoffMs}ms`,
      );
    }
  }

  /**
   * Submit `receiveMessage` / `relayWithHook` on the destination chain — broadcast only.
   *
   * NON-BLOCKING by design (Phase 2B). The function returns as soon as the broadcast resolves
   * (typically <1s), NOT after on-chain confirmation. The destination receipt is checked
   * later by `processInflightRelays` on subsequent poll ticks. This frees the relay loop
   * from per-message ~12s confirmation latency that previously serialised everything.
   *
   * On `'submitted'`: the caller MUST persist `msg.submittedTxHash` + `msg.submittedAt`
   * before yielding to the event loop, otherwise a crash between broadcast and persist
   * loses the txHash and the message would be re-submitted on restart (recovered via the
   * destination contract's "already processed" check, but at gas cost).
   *
   * Returns:
   *  - `'submitted'`  — tx broadcast, hash captured in `msg.submittedTxHash`. Caller keeps the
   *                     message in pending state for receipt polling.
   *  - `'already-processed'` — destination contract reports this message was already delivered
   *                     (likely by a prior submit-then-crash that we lost track of). Caller
   *                     marks as processed and removes from pending.
   *  - `'failed'`     — broadcast rejected (revert, RPC error, nonce drift). Caller bumps
   *                     retryAttempts and schedules backoff via the existing Phase 2 machinery.
   */
  private async submitRelay(
    msg: PendingMessage,
    attestation: string,
    irisMessage: string,
  ): Promise<"submitted" | "already-processed" | "failed"> {
    const destState = this.getChainByDomain(msg.destinationDomain);
    if (!destState) {
      console.error(`  [iris-relay] No chain for destination domain ${msg.destinationDomain}`);
      return "failed";
    }

    try {
      // Prefer the message from Iris (may include finalityThresholdExecuted filled in)
      const msgToRelay = irisMessage || msg.messageBytes;

      console.log(`  Source Tx: ${msg.sourceTxHash}`);

      // Allocate the nonce + broadcast through the shared coordinator (keyed by chainId, the
      // actual nonce stream). It seeds from `getTransactionCount('pending')` on first use and
      // serialises against the privacy relay, which signs from this same EOA. The coordinator
      // advances the counter only when the broadcast resolves — a throw leaves the nonce for the
      // next caller to reuse.
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
              `  Sending relayWithHook to ${destState.config.name} via CCTPHookRouter (tx nonce: ${txNonce})...`,
            );
            return hookRouter.relayWithHook(msgToRelay, attestation, {
              nonce: txNonce,
            }) as Promise<ethers.ContractTransactionResponse>;
          }
          const messageTransmitter = new ethers.Contract(
            destState.messageTransmitter,
            REAL_MESSAGE_TRANSMITTER_ABI,
            destState.wallet
          );
          console.log(
            `  Sending receiveMessage to ${destState.config.name} (tx nonce: ${txNonce})...`,
          );
          return messageTransmitter.receiveMessage(msgToRelay, attestation, {
            nonce: txNonce,
          }) as Promise<ethers.ContractTransactionResponse>;
        },
      );

      // Mutate the message so the caller can persist + transition to "awaiting receipt" state.
      msg.submittedTxHash = tx.hash;
      msg.submittedAt = Date.now();

      console.log(`  Tx submitted: ${tx.hash} (awaiting confirmation, non-blocking)`);
      return "submitted";
    } catch (e: any) {
      if (
        e.message?.includes("already processed") ||
        e.message?.includes("Nonce already used")
      ) {
        console.log(`  Already processed on-chain, marking as done`);
        return "already-processed";
      }
      // Nonce-class errors (Sepolia load-balancer drift, replacement underpriced, etc.) — reset
      // the coordinator's cache so the next attempt re-reads from the provider. Don't surface as a
      // hard failure since the underlying state may already be correct on chain.
      if (
        e.message?.includes("nonce") ||
        e.message?.includes("NONCE") ||
        e.code === "NONCE_EXPIRED" ||
        e.code === "REPLACEMENT_UNDERPRICED"
      ) {
        console.log(`  Nonce error detected, refreshing on next attempt`);
        this.nonceCoordinator.reset(destState.config.chainId);
      }
      console.error(`  [iris-relay] Submit failed: ${e.message || e}`);
      return "failed";
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

  /** Resolved by `runPollLoop` when it observes isRunning=false and exits. `stop()` awaits it. */
  private loopExited: Promise<void> | null = null;
  private resolveLoopExited: (() => void) | null = null;

  private async runPollLoop(): Promise<void> {
    this.loopExited = new Promise((resolve) => {
      this.resolveLoopExited = resolve;
    });
    try {
      while (this.isRunning) {
        // 1. Scan all chains for new MessageSent events — in PARALLEL. pollChain has its own
        //    try/catch that writes to state.lastError, so a failure on one chain doesn't reject
        //    the Promise (allSettled is belt + braces for the unexpected). One slow chain (e.g.
        //    a stuck Iris attestation lookup) no longer delays every other chain's tick.
        const chainStates = Array.from(this.chains.values());
        const pollResults = await Promise.allSettled(
          chainStates.map((state) => this.pollChain(state)),
        );
        // Defensive: pollChain's own catch should swallow + log everything into state.lastError,
        // so a rejection here means an unexpected throw BEFORE pollChain entered its try (impossible
        // under normal code paths, but the test harness or a future refactor could regress this).
        // Log loudly so the operator sees it instead of a silent allSettled swallow.
        for (let i = 0; i < pollResults.length; i++) {
          const r = pollResults[i];
          if (r?.status === "rejected") {
            const chainName = chainStates[i]?.config.name ?? "unknown";
            console.error(
              `[iris-relay] ${chainName}: pollChain rejected unexpectedly (bypassed inner try/catch): ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
            );
          }
        }

        if (!this.isRunning) break;

        // 2. Check pending messages for attestations and submit relays (non-blocking — the
        //    submit returns after broadcast, NOT after destination-chain confirmation).
        await this.processPendingMessages();

        if (!this.isRunning) break;

        // 3. Phase 2B: poll destination chains for receipts of in-flight submitted relays.
        //    Per-chain parallel — one slow chain doesn't delay others. Same defensive-logging
        //    pattern as pollChain (Promise.allSettled + per-rejection error log).
        const inflightResults = await Promise.allSettled(
          chainStates.map((state) => this.processInflightRelays(state)),
        );
        for (let i = 0; i < inflightResults.length; i++) {
          const r = inflightResults[i];
          if (r?.status === "rejected") {
            const chainName = chainStates[i]?.config.name ?? "unknown";
            console.error(
              `[iris-relay] ${chainName}: processInflightRelays rejected unexpectedly: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
            );
          }
        }

        if (!this.isRunning) break;

        // 4. Sleep before next cycle — abort early if stop() fires.
        await this.sleepCancellable(this.pollIntervalMs);
      }
    } finally {
      this.resolveLoopExited?.();
    }
  }

  /**
   * Like `setTimeout` but resolves immediately when `isRunning` flips to false, so a shutdown
   * doesn't have to wait out the full poll interval before flushing. Checks every 100ms — small
   * enough to be unnoticeable on shutdown latency, large enough not to busy-loop.
   */
  private async sleepCancellable(totalMs: number): Promise<void> {
    const start = Date.now();
    const step = 100;
    while (this.isRunning && Date.now() - start < totalMs) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(step, totalMs - (Date.now() - start))));
    }
  }

  /**
   * Async, awaitable shutdown. Flips the run flag, waits for the current poll tick to complete
   * (so an in-flight `getLogs` finishes and its cursor write lands), then resolves. The caller
   * in `armada-relayer.ts` MUST await this before `process.exit` — otherwise a kill-9 mid-poll
   * could happen between the on-disk cursor write and the in-memory advance, defeating the
   * crash-safety guarantee.
   *
   * Idempotent — calling twice is a no-op on the second call.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    console.log("[iris-relay] Stopping — waiting for in-flight scan tick to complete...");
    if (this.pendingMessages.size > 0) {
      console.log(`[iris-relay] ${this.pendingMessages.size} pending message(s) will be abandoned`);
    }
    this.isRunning = false;
    if (this.loopExited) await this.loopExited;
    console.log("[iris-relay] Stopped cleanly.");
  }

  get chainCount(): number {
    return this.chains.size;
  }

  /**
   * Snapshot per-chain scanner state for the /health endpoint. Pure data extraction — no RPC
   * calls, no mutation. Counts pending messages by SOURCE chain since that's how
   * PendingStateStore keys state and how operators reason about "messages stuck originating
   * from chain X."
   */
  getHealth(): RelayerHealth {
    const now = Date.now();

    // Pre-bucket pending counts by source domain to avoid an O(chains × pending) loop below.
    const pendingBySource = new Map<number, number>();
    for (const msg of this.pendingMessages.values()) {
      pendingBySource.set(msg.sourceDomain, (pendingBySource.get(msg.sourceDomain) ?? 0) + 1);
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
      });
    }

    return {
      status: rollupStatus(chains.map((c) => c.status)),
      chains,
      generatedAt: now,
    };
  }
}
