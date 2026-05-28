/**
 * Check the relayer's Railgun (0zk) wallet's shielded USDC balance — the running tally of
 * broadcaster fees the relayer has collected via relayer-mediated submits (Phase A3+).
 *
 * Run:
 *   source config/local.env && npx ts-node scripts/check_relayer_railgun_balance.ts
 *   source config/sepolia.env && source config/secrets.env && npx ts-node scripts/check_relayer_railgun_balance.ts
 *
 * Why this is a separate script (not a relayer endpoint): the running relayer doesn't load a
 * provider for its Railgun wallet — it only uses the wallet's viewing key for on-the-fly
 * ciphertext decryption at /relay verify time. To READ the balance we need to load a provider,
 * scan the merkletree, and await completion — which is heavy and unnecessary for the relayer's
 * core duty. A scheduled job can wrap this script if you want continuous reporting.
 *
 * Uses a separate LevelDB at `data/relayer-balance-check-db/` so it doesn't fight the running
 * relayer for the single-process lock on `relayer/state/railgun-db/`.
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
// @ts-ignore — leveldown ships with implicit any types
import leveldown from "leveldown";
import { installBisectingGetLogs } from "../relayer/lib/rpc-bisecting";
import {
  ArtifactStore,
  startRailgunEngine,
  stopRailgunEngine,
  createRailgunWallet,
  fullWalletForID,
  loadProvider,
  awaitWalletScan,
  balanceForERC20Token,
  setOnUTXOMerkletreeScanCallback,
} from "@railgun-community/wallet";

// Bisecting eth_getLogs patch — load BEFORE any ethers provider is constructed (the patch hits
// JsonRpcProvider.prototype, so order isn't strictly required, but mounting at module top makes
// the intent obvious to anyone reading the file). On Sepolia public RPCs this is load-bearing —
// the SDK's internal scan calls would otherwise fail outright when a getLogs window exceeds the
// provider's cap (Alchemy free tier = 10 blocks; Infura = 10k).
installBisectingGetLogs();
import {
  NETWORK_CONFIG,
  NetworkName,
  TXIDVersion,
} from "@railgun-community/shared-models";
import {
  ChainType,
} from "@railgun-community/engine";
import { getNetworkConfig } from "../config/networks";

// Same constant the rest of the relayer-side flow uses for engine-encrypted wallet ops. Not a
// secret — it's the wrapping key for the engine's own at-rest wallet record, not the user's
// material. (See `lib/sdk/wallet.ts::DEFAULT_ENCRYPTION_KEY` for the long-form rationale.)
const DEFAULT_ENCRYPTION_KEY =
  "0101010101010101010101010101010101010101010101010101010101010101";

// Wallet source — same tag the relayer itself uses, so logs identify this consistently.
const ENGINE_WALLET_SOURCE = "armadarlcheck";

interface Manifest {
  contracts: { privacyPool: string };
  cctp: { usdc: string };
  deployBlock?: number;
}

function loadManifest(filename: string): Manifest {
  const manifestPath = path.resolve(__dirname, "..", "deployments", filename);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Deployment manifest not found: ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
}

/**
 * Mirror of the frontend's network-patching logic (apps/armada-interface/src/lib/railgun/
 * network.ts). The SDK ships `NetworkName.Hardhat` as a placeholder; we point it at our
 * actual deployment + real chain ID. On sepolia we also neutralise the canonical
 * `Ethereum_Sepolia` entry so the SDK doesn't shadow ours with a QuickSync against
 * real Railgun history.
 */
function patchNetworkConfig(
  privacyPoolAddress: string,
  deployBlock: number,
  hubChainId: number,
  isSepolia: boolean,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const networkConfig = NETWORK_CONFIG as any;
  const target = networkConfig[NetworkName.Hardhat];
  if (!target) {
    throw new Error("SDK NETWORK_CONFIG missing Hardhat entry");
  }
  target.proxyContract = privacyPoolAddress;
  target.relayAdaptContract = ethers.ZeroAddress;
  target.relayAdaptHistory = [""];
  target.deploymentBlock = deployBlock;
  target.poseidonMerkleAccumulatorV3Contract = ethers.ZeroAddress;
  target.poseidonMerkleVerifierV3Contract = ethers.ZeroAddress;
  target.tokenVaultV3Contract = ethers.ZeroAddress;
  target.deploymentBlockPoseidonMerkleAccumulatorV3 = 0;
  target.supportsV3 = false;
  target.poi = undefined;
  if (isSepolia) {
    target.chain = { type: ChainType.EVM, id: hubChainId };
    const sepoliaEntry = networkConfig["Ethereum_Sepolia"];
    if (sepoliaEntry) sepoliaEntry.chain = { type: ChainType.EVM, id: -1 };
  }
}

async function main(): Promise<void> {
  const mnemonic = process.env.RELAYER_RAILGUN_MNEMONIC?.trim();
  if (!mnemonic) {
    throw new Error(
      "RELAYER_RAILGUN_MNEMONIC is not set. Source the relayer's env (config/local.env or " +
        "config/sepolia.env + config/secrets.env) before running.",
    );
  }

  const netConfig = getNetworkConfig();
  const isSepolia = netConfig.env === "sepolia";
  const suffix = isSepolia ? "-sepolia" : "";
  const hubManifest = loadManifest(`privacy-pool-hub${suffix}.json`);
  const cctpManifest = loadManifest(`hub${suffix}-v3.json`);

  const privacyPool = hubManifest.contracts.privacyPool;
  const usdcAddress = cctpManifest.cctp?.usdc ?? hubManifest.cctp.usdc;
  const deployBlock = hubManifest.deployBlock ?? 0;
  const hubChainId = netConfig.hub.chainId;
  const hubRpc = netConfig.hub.rpc;

  console.log("[check-balance] Initializing engine via wallet-package startRailgunEngine...");
  const dbPath = path.resolve(__dirname, "..", "data", "relayer-balance-check-db");
  if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });
  const db = leveldown(dbPath);

  // Stub artifact store — the wallet-package init requires one but balance reads + chain scans
  // never trigger artifact lookups (those are proof-generation only). Callbacks throw loudly so
  // any future code path that DOES need real artifacts surfaces the misuse immediately rather
  // than failing later with a more confusing error.
  const artifactStore = new ArtifactStore(
    async () => {
      throw new Error("balance-check: artifact get not supported (proof-gen disabled)");
    },
    async () => {
      throw new Error("balance-check: artifact store not supported (proof-gen disabled)");
    },
    async () => false,
  );

  // startRailgunEngine sets the wallet-package's engine singleton — load-bearing for the later
  // loadProvider call, which checks hasEngine() on the wallet package. Skipping this in favour
  // of the engine-package's RailgunEngine.initForWallet alone produces the misleading
  // "RAILGUN Engine not yet initialized" from loadProvider.
  await startRailgunEngine(
    ENGINE_WALLET_SOURCE,
    db,
    false, // shouldDebug
    artifactStore,
    false, // useNativeArtifacts
    false, // skipMerkletreeScans — we WANT to scan so balanceForERC20Token has data
  );

  console.log("[check-balance] Deriving relayer wallet from mnemonic...");
  const { id: walletId, railgunAddress } = await createRailgunWallet(
    DEFAULT_ENCRYPTION_KEY,
    mnemonic,
    undefined, // creationBlockNumbers — relayer doesn't need creation-block scoping
  );
  console.log(`  Wallet ID: ${walletId.slice(0, 16)}...`);
  console.log(`  Address:   ${railgunAddress}`);

  console.log("[check-balance] Patching SDK network config + loading hub provider...");
  console.log(`  Scan deployBlock: ${deployBlock}`);
  console.log(`  RPC:              ${hubRpc}`);
  patchNetworkConfig(privacyPool, deployBlock, hubChainId, isSepolia);

  // Wire a UTXO-scan progress callback so the user can watch the scan tick. The SDK emits
  // updates with a [0, 1] progress fraction; we log every ~10% step to avoid flooding the
  // console. Without this the long Sepolia first-run looks indistinguishable from a hang.
  let lastReportedPct = -10;
  setOnUTXOMerkletreeScanCallback((evt) => {
    const pct = Math.floor(evt.progress * 100);
    if (pct - lastReportedPct >= 10) {
      lastReportedPct = pct;
      console.log(
        `  scan ${pct}% (status=${evt.scanStatus}, chain=${evt.chain.type}:${evt.chain.id})`,
      );
    }
  });

  // Single-provider fallback config — pollingInterval longer on testnet to be kind to public RPCs.
  await loadProvider(
    {
      chainId: hubChainId,
      providers: [
        {
          provider: hubRpc,
          priority: 1,
          weight: 2,
          maxLogsPerBatch: 10,
          stallTimeout: isSepolia ? 10_000 : 2_500,
        },
      ],
    },
    NetworkName.Hardhat,
    isSepolia ? 15_000 : 2_000,
  );

  console.log("[check-balance] Awaiting merkletree scan (this may take minutes on Sepolia)...");
  const chain = { type: ChainType.EVM, id: hubChainId };
  await awaitWalletScan(walletId, chain);

  console.log("[check-balance] Reading USDC balance...");
  const wallet = fullWalletForID(walletId);
  const balanceRaw = await balanceForERC20Token(
    TXIDVersion.V2_PoseidonMerkle,
    wallet,
    NetworkName.Hardhat,
    usdcAddress,
    false, // onlySpendable: include non-spendable (POI-pending) too — closer to "accrued"
  );

  // 6-decimal USDC formatting without depending on ethers.formatUnits (clearer for an op script).
  const USDC_DECIMALS = 6n;
  const USDC_UNIT = 10n ** USDC_DECIMALS;
  const whole = balanceRaw / USDC_UNIT;
  const fraction = balanceRaw % USDC_UNIT;
  const fractionPadded = fraction.toString().padStart(Number(USDC_DECIMALS), "0");

  console.log("");
  console.log("=".repeat(60));
  console.log(`  RELAYER SHIELDED USDC BALANCE`);
  console.log(`  Address:    ${railgunAddress}`);
  console.log(`  USDC token: ${usdcAddress}`);
  console.log(`  Raw:        ${balanceRaw}`);
  console.log(`  Formatted:  ${whole}.${fractionPadded} USDC`);
  console.log("=".repeat(60));

  await stopRailgunEngine();
}

main().catch((err) => {
  console.error("[check-balance] FAILED:", err);
  process.exit(1);
});
