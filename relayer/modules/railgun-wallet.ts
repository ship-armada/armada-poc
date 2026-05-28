/**
 * Relayer Railgun Wallet
 *
 * Initialises the Railgun engine + derives the relayer's `0zk` wallet from a BIP39 mnemonic
 * configured at deploy time. The derived wallet's viewing key is what powers broadcaster-fee
 * verification in `broadcaster-fee-verifier.ts`: when a user POSTs a tx to `/relay`, we use the
 * viewing key to attempt decryption of each `commitmentCiphertext[]` entry; the one that
 * decrypts tells us the value of the broadcaster output destined for this wallet, which we
 * then compare against the advertised fee.
 *
 * Boot sequence (called from `armada-relayer.ts::main`):
 *   1. assert RELAYER_RAILGUN_MNEMONIC env is set (refuse to boot otherwise — without it,
 *      the relayer cannot verify fees and would be exposed to free-relay attacks)
 *   2. init engine with a relayer-specific LevelDB path (separate from test runs to avoid
 *      the single-process LevelDB lock fight on local dev)
 *   3. derive wallet via `engine.createWalletFromMnemonic` — deterministic from
 *      (mnemonic, derivationIndex), so restarts re-derive instead of growing new wallet IDs
 *   4. assert the derived 0zk address matches any operator-set `BROADCASTER_RAILGUN_ADDRESS`
 *      (mismatch = misconfiguration → fail boot, don't ship a wrong address on `/fees`)
 */

import * as fs from "fs";
import * as path from "path";
import { RailgunEngine, RailgunWallet } from "@railgun-community/engine";
import { initializeEngine, shutdownEngine } from "../../lib/sdk/init";
import { DEFAULT_ENCRYPTION_KEY } from "../../lib/sdk/wallet";
import { armadaRelayerSettings } from "../config";

/**
 * Relayer-local LevelDB path. Kept under `relayer/state/` alongside the other relayer
 * persistence (cursors, pending messages) so operational tools that flush state can treat
 * one directory as authoritative. NOT shared with `<repo>/data/railgun-db/` (the default
 * lib/sdk path) because LevelDB is single-process: a long-running relayer would prevent
 * test runs from opening their own engine, and vice versa.
 */
const RELAYER_RAILGUN_DB_DIR = path.join(
  __dirname,
  "..",
  "state",
  "railgun-db",
);

/**
 * Engine `walletSource` tag — max 16 chars, lowercase. Identifies the relayer as the
 * originator of any merkletree scan + wallet creation calls in engine logs.
 */
const ENGINE_WALLET_SOURCE = "armadarelay";

export interface RelayerWalletHandle {
  /** Engine-internal wallet ID (sha256 of viewing key + derivation index — stable per mnemonic). */
  walletId: string;
  /** `0zk...` address. The value the relayer publishes on `/fees` as `broadcasterRailgunAddress`. */
  railgunAddress: string;
}

export class RelayerRailgunWallet {
  private wallet: RailgunWallet | null = null;
  private engine: RailgunEngine | null = null;

  /**
   * Initialise the engine and derive the relayer's Railgun wallet. Throws on misconfiguration
   * — missing mnemonic, mnemonic-derived address mismatching `BROADCASTER_RAILGUN_ADDRESS`,
   * or engine init failure. The relayer caller is expected to `process.exit(1)` on throw so
   * the operator sees a clear startup failure rather than a silently broken service.
   */
  async initialize(): Promise<RelayerWalletHandle> {
    const mnemonic = armadaRelayerSettings.railgunWalletMnemonic.trim();
    if (!mnemonic) {
      throw new Error(
        "[railgun-wallet] RELAYER_RAILGUN_MNEMONIC is required. Set it in config/local.env " +
          "(Anvil default mnemonic) for local dev, or config/secrets.env (gitignored) for " +
          "sepolia/prod. The relayer cannot verify broadcaster fees without it.",
      );
    }
    const wordCount = mnemonic.split(/\s+/).length;
    if (wordCount !== 12 && wordCount !== 24) {
      throw new Error(
        `[railgun-wallet] RELAYER_RAILGUN_MNEMONIC has ${wordCount} words; expected 12 or 24 ` +
          `(standard BIP39). Generate one with any BIP39 tool or via npm run derive:relayer-railgun.`,
      );
    }

    // Ensure the relayer-local LevelDB directory exists before the engine tries to open it.
    if (!fs.existsSync(RELAYER_RAILGUN_DB_DIR)) {
      fs.mkdirSync(RELAYER_RAILGUN_DB_DIR, { recursive: true });
    }

    this.engine = await initializeEngine(
      ENGINE_WALLET_SOURCE,
      RELAYER_RAILGUN_DB_DIR,
    );

    // Deterministic: same (mnemonic, derivationIndex) always produces the same wallet ID and
    // re-uses the engine-side state. Restarts pick up where the previous boot left off — no
    // growing wallet-id sprawl, no rescan-from-zero penalty.
    this.wallet = (await this.engine.createWalletFromMnemonic(
      DEFAULT_ENCRYPTION_KEY,
      mnemonic,
      0, // derivationIndex — fixed; A2 doesn't support multi-key rotation. See notes in PLAN.
      undefined, // creationBlockNumbers — relayer doesn't scan history (no UTXOs to find)
    )) as RailgunWallet;

    const railgunAddress = this.wallet.getAddress();

    // Cross-check the operator-published address (if any) against the derived one. A mismatch
    // means either (a) the mnemonic was rotated without updating the env, or (b) the env was
    // hand-edited with a wrong value. Either way: fail boot before /fees serves a wrong address
    // to clients. Future SNARK proofs built against the published address would silently land
    // in some OTHER wallet's outbox, gas paid + no recovery.
    const advertised = armadaRelayerSettings.broadcasterRailgunAddress.trim();
    if (advertised && advertised !== railgunAddress) {
      throw new Error(
        `[railgun-wallet] BROADCASTER_RAILGUN_ADDRESS (${advertised}) does not match the ` +
          `address derived from RELAYER_RAILGUN_MNEMONIC (${railgunAddress}). Either unset the ` +
          `env (the relayer will use the derived address) or fix the mnemonic / env entry.`,
      );
    }

    return { walletId: this.wallet.id, railgunAddress };
  }

  /**
   * Get the underlying RailgunWallet instance. `BroadcasterFeeVerifier` calls
   * `wallet.extractFirstNoteERC20AmountMap(...)` on this for per-request decryption.
   * Throws if init hasn't run — guards against a wiring bug where the verifier is constructed
   * before the wallet is loaded.
   */
  getWallet(): RailgunWallet {
    if (!this.wallet) {
      throw new Error(
        "[railgun-wallet] getWallet() before initialize() — boot order bug",
      );
    }
    return this.wallet;
  }

  /**
   * Graceful shutdown — releases the LevelDB single-process lock so a subsequent boot (or a
   * concurrent test run) doesn't see "LOCK already held" errors. Called from armada-relayer's
   * SIGINT/SIGTERM handler.
   */
  async shutdown(): Promise<void> {
    if (this.engine) {
      await shutdownEngine();
      this.engine = null;
      this.wallet = null;
    }
  }
}
