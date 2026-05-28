// ABOUTME: Integration-smoke test for RelayerRailgunWallet — proves the engine init + wallet derivation
// ABOUTME: pipeline is wired against the real SDK (no mocks), and that the derivation is deterministic.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expect } from "chai";
import { initializeEngine, shutdownEngine } from "../../../lib/sdk/init";
import { DEFAULT_ENCRYPTION_KEY } from "../../../lib/sdk/wallet";
import { RailgunWallet } from "@railgun-community/engine";

// Anvil's publicly-known test mnemonic. Producing the same 0zk address from it twice in a row
// is what proves the wallet-derivation pipeline is deterministic — the load-bearing property
// for `restarts re-derive instead of growing new wallet IDs` (railgun-wallet.ts header).
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * Init + create + tear down a wallet against a freshly-created LevelDB. Returns the derived
 * 0zk address. The temp dir is removed via the test's after hook.
 *
 * WHY a helper: the integration test runs the same sequence twice (proving determinism). We
 * want the second run to use a SEPARATE DB so it can't satisfy the assertion by reading
 * already-derived state from the first run's DB — the property we're proving is the SDK's
 * deterministic key derivation from the mnemonic, not its persistence layer.
 */
async function deriveAddressInTempDb(): Promise<string> {
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "armada-relayer-engine-"));
  try {
    const engine = await initializeEngine("armadarlytst", dbPath);
    const wallet = (await engine.createWalletFromMnemonic(
      DEFAULT_ENCRYPTION_KEY,
      ANVIL_MNEMONIC,
      0,
      undefined,
    )) as RailgunWallet;
    return wallet.getAddress();
  } finally {
    await shutdownEngine();
    // Tear down the temp dir — leaving it would leak ~few-MB LevelDB files per test run on dev
    // machines. `force: true` swallows the rare race where engine.unload's lockfile cleanup
    // hadn't fully completed.
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
}

describe("RelayerRailgunWallet — engine + derivation integration", function () {
  // The engine boots a substantial amount of SDK machinery (leveldown, artifact getter, debugger
  // wiring); the first init in a process is the slowest. 30s gives generous headroom for cold
  // CI sandboxes.
  this.timeout(30_000);

  it("derives the same 0zk address for the same mnemonic across separate engine boots", async () => {
    // WHY: pins the production invariant that a relayer restart re-derives the SAME wallet
    // identity. Without this, restarts would grow a fresh wallet ID + fresh on-chain
    // address — operators would see /fees serve a new broadcaster address, and any prior fee
    // outputs would be stranded in a wallet the relayer no longer owns.
    const addr1 = await deriveAddressInTempDb();
    const addr2 = await deriveAddressInTempDb();
    expect(addr1).to.equal(addr2);
  });

  it("produces an address with the 0zk-prefixed bech32 shape the protocol expects", async () => {
    // WHY: catches drift in the SDK's address-encoding scheme. A future SDK update that
    // switched to e.g. `0xRailgun:` prefix would silently break the frontend's
    // recipientAddress validation in shielded transfer modals; this test fails first.
    const addr = await deriveAddressInTempDb();
    expect(addr).to.match(/^0zk[0-9a-z]+$/);
  });
});
