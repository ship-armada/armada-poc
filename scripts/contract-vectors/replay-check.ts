/**
 * Replay-check skeleton — Phase 1 deliverable that becomes the differential
 * harness in Phase 2c.
 *
 * What it does TODAY (single-deployment assertion):
 *   Re-reads a captured vector, re-sends its calldata against a running
 *   deployment (assumed to be at the vector's recorded pre-state — i.e. all
 *   depended-on vectors already replayed), and asserts the recorded post-state
 *   reads and ordered events match what the deployment actually produced.
 *
 * What Phase 2c adds (NOT implemented here):
 *   - Booting old + new contract deployments side by side
 *   - Address-book substitution: calldata embeds capture-time addresses; the
 *     differential harness must re-encode `tx.decodedCall.args` against each
 *     deployment's own addressBook instead of replaying raw calldata (except
 *     for vectors like transact-double-spend-revert where byte-identical
 *     calldata IS the point)
 *   - Impersonation handling for vectors with `requiresImpersonation`
 *   - Gas comparison with tolerance policy
 *
 * Usage (hardhat does not forward `--` args, so selection is via env vars):
 *   REPLAY_ALL=1 REPLAY_GENESIS=1 npx hardhat run scripts/contract-vectors/replay-check.ts --network hub
 *   REPLAY_IDS=transact-2x2,shield-direct-erc20 npx hardhat run scripts/contract-vectors/replay-check.ts --network hub
 *
 *   REPLAY_ALL=1       replay every vector in manifest order (default when REPLAY_IDS unset)
 *   REPLAY_GENESIS=1   perform capture-time genesis setup first (mock deployment
 *                      + funding + approvals) — required on a fresh fixturenet
 *   REPLAY_IDS=a,b,c   replay only the listed vector ids
 *
 * Exit code 0 = all replayed vectors match; 1 = any mismatch.
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { deployMock } from "./lib/mock-contracts";

// Fixture dir overridable for the post-drift v2 corpus (see README §Post-drift v2 corpus):
//   REPLAY_FIXTURES_DIR=test-foundry/fixtures/contract-vectors-v2
const FIXTURES_DIR = path.resolve(
  __dirname,
  "..", "..",
  process.env.REPLAY_FIXTURES_DIR || path.join("test-foundry", "fixtures", "contract-vectors")
);

const ONE_USDC = 1_000_000n;

// Keys whose VALUES legitimately differ between deployments/blocks and are
// therefore excluded from exact post-state comparison. Phase 2c should
// replace this with a semantic comparator (e.g. block numbers must be
// monotonic, not equal).
const VOLATILE_STATE_KEYS = new Set(["pool.lastEventBlock"]);

interface Comparison {
  ok: boolean;
  mismatches: string[];
}

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compare recorded events vs freshly mined receipt logs (order-sensitive). */
function compareEvents(recorded: any[], actual: any[]): Comparison {
  const mismatches: string[] = [];
  const slim = (e: any) => ({
    address: e.address.toLowerCase(),
    topics: e.topics,
    data: e.data,
  });
  if (recorded.length !== actual.length) {
    mismatches.push(`event count: recorded ${recorded.length} vs actual ${actual.length}`);
  }
  const n = Math.min(recorded.length, actual.length);
  for (let i = 0; i < n; i++) {
    // NOTE: cross-deployment replay must compare events via the address BOOK,
    // not raw addresses. Within one deployment raw comparison is exact.
    if (!deepEqual(slim(recorded[i]), slim(actual[i]))) {
      mismatches.push(
        `event[${i}] mismatch:\n  recorded: ${JSON.stringify(slim(recorded[i]))}\n  actual:   ${JSON.stringify(slim(actual[i]))}`
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Re-execute the recorded pre/post state READS. The vector format stores reads
 * as key -> value; the read definitions themselves are reconstruction metadata
 * (see `stateReadRegistry` below). Reads not covered by the registry are
 * skipped with a warning — Phase 2c is expected to extend the registry.
 */
async function runStateReads(
  keys: string[],
  ctx: { pool: any; usdc: any; addressBook: Record<string, string> }
): Promise<Record<string, any>> {
  const { pool, usdc, addressBook } = ctx;
  const out: Record<string, any> = {};
  for (const key of keys) {
    // pool.<getter>
    let m = key.match(/^pool\.(\w+)$/);
    if (m && typeof pool[m[1]] === "function") {
      out[key] = await pool[m[1]]();
      continue;
    }
    // usdc.balanceOf[LABEL]
    m = key.match(/^usdc\.balanceOf\[(\w+)\]$/);
    if (m && addressBook[m[1]]) {
      out[key] = await usdc.balanceOf(addressBook[m[1]]);
      continue;
    }
    // pool.nullifiers[tree][nullifier] / pool.rootHistory[tree][root]
    m = key.match(/^pool\.(nullifiers|rootHistory)\[(\d+|postTree)\]\[(0x[0-9a-fA-F]+|postRoot)\]$/);
    if (m) {
      const tree = m[2] === "postTree" ? await pool.treeNumber() : BigInt(m[2]);
      const slot =
        m[3] === "postRoot" ? await pool.merkleRoot() : (m[3] as string);
      out[key] = await pool[m[1]](tree, slot);
      continue;
    }
    // pool.<mapping>[key] — single-arg mappings with decimal (remotePools[101],
    // remoteHookRouters[101]) or 0x address (tokenBlocklist[0x…]) keys.
    m = key.match(/^pool\.(remotePools|remoteHookRouters)\[(\d+)\]$/);
    if (m) {
      out[key] = await pool[m[1]](BigInt(m[2]));
      continue;
    }
    m = key.match(/^pool\.(tokenBlocklist)\[(0x[0-9a-fA-F]+)\]$/);
    if (m) {
      out[key] = await pool[m[1]](m[2]);
      continue;
    }
    console.warn(`  replay-check: no read binding for state key "${key}" — skipped`);
  }
  return out;
}

function hex(v: any): string {
  return typeof v === "bigint" ? "0x" + v.toString(16) : v;
}

async function replayVector(id: string, ctx: any): Promise<boolean> {
  const file = path.join(FIXTURES_DIR, `${id}.json`);
  if (!fs.existsSync(file)) {
    console.error(`[${id}] vector file not found`);
    return false;
  }
  const vector = JSON.parse(fs.readFileSync(file, "utf-8"));

  // ── Resolve sender ─────────────────────────────────────────────────────────
  // Single-deployment mode: map labels onto the local signers. Phase 2c:
  // resolve via the deployment's own account set + impersonation.
  const signers = await ethers.getSigners();
  const labelToSigner: Record<string, any> = {
    DEPLOYER: signers[0],
    ALICE: signers[1],
    BOB: signers[2],
    CAROL: signers[3],
  };
  let from = labelToSigner[vector.tx.from];
  if (vector.requiresImpersonation) {
    const addr = ctx.addressBook[vector.requiresImpersonation];
    await ctx.rawProvider.send("anvil_impersonateAccount", [addr]);
    await ctx.rawProvider.send("anvil_setBalance", [addr, "0x56BC75E2D63100000"]);
    from = await ctx.rawProvider.getSigner(addr);
  }
  if (!from) {
    console.error(`[${id}] cannot resolve sender label ${vector.tx.from}`);
    return false;
  }

  // ── Executable setup transactions (mock flag flips etc.) ───────────────────
  for (const s of vector.setupTxs ?? []) {
    const setupFrom = labelToSigner[s.from];
    if (!setupFrom) {
      console.error(`[${id}] cannot resolve setupTx sender ${s.from}`);
      return false;
    }
    const setupTo = ctx.addressBook[s.to] ?? s.toAddress;
    // Empty resolution = contract-creation setup tx (mirrors capture).
    await (await setupFrom.sendTransaction({ ...(setupTo ? { to: setupTo } : {}), data: s.calldata, value: 0 })).wait();
  }

  // ── Send the recorded calldata ─────────────────────────────────────────────
  // TODO(Phase 2c): for cross-deployment replay, re-encode decodedCall.args
  // against the target deployment's addressBook here instead of reusing raw
  // calldata (raw reuse is only correct within one deployment).
  const to = ctx.addressBook[vector.tx.to] ?? vector.tx.toAddress;
  let receipt: any;
  try {
    const tx = await from.sendTransaction({
      to,
      data: vector.tx.calldata,
      value: 0,
      ...(vector.result.status === 0 ? { gasLimit: 6_000_000n } : {}),
    });
    try {
      receipt = await tx.wait();
    } catch {
      receipt = await ethers.provider.getTransactionReceipt(tx.hash);
    }
  } catch (err: any) {
    console.error(`[${id}] send failed: ${err.message?.slice(0, 200)}`);
    return false;
  }

  const mismatches: string[] = [];

  // ── Status ─────────────────────────────────────────────────────────────────
  if (receipt.status !== vector.result.status) {
    mismatches.push(`status: recorded ${vector.result.status} vs actual ${receipt.status}`);
  }

  // ── Events (success vectors only; reverted txs emit nothing) ───────────────
  if (vector.result.status === 1) {
    const cmp = compareEvents(vector.result.events, receipt.logs);
    mismatches.push(...cmp.mismatches);
  }

  // ── Post-state reads ───────────────────────────────────────────────────────
  const postKeys = Object.keys(vector.postState).filter((k) => !VOLATILE_STATE_KEYS.has(k));
  const actualPost = await runStateReads(postKeys, ctx);
  for (const k of postKeys) {
    if (!(k in actualPost)) continue; // skipped (warned above)
    if (hex(actualPost[k]) !== vector.postState[k] && String(actualPost[k]) !== String(vector.postState[k])) {
      mismatches.push(`postState[${k}]: recorded ${vector.postState[k]} vs actual ${hex(actualPost[k])}`);
    }
  }

  // ── Gas: report only (tolerance policy is a Phase 2c decision) ─────────────
  const gasDelta = Number(receipt.gasUsed) - parseInt(vector.result.gasUsed, 16);

  if (mismatches.length === 0) {
    console.log(`[${id}] MATCH (gas delta ${gasDelta >= 0 ? "+" : ""}${gasDelta})`);
    return true;
  }
  console.error(`[${id}] MISMATCH:`);
  for (const mm of mismatches) console.error(`  - ${mm}`);
  return false;
}

async function main() {
  // Args after `--`: vector ids, or --all for the full manifest order.
  // --genesis additionally performs the capture-time genesis setup (mock
  // deployment + funding + approvals) — required when replaying --all against
  // a freshly booted fixturenet.
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  // Hardhat v2 rejects `--flag` args after the script path (HH305), so the
  // README's `-- --all --genesis` form never reaches us. Accept env-var
  // equivalents as well: REPLAY_ALL=1, REPLAY_GENESIS=1.
  if (process.env.REPLAY_ALL === "1") argv.push("--all");
  if (process.env.REPLAY_GENESIS === "1") argv.push("--genesis");
  const genesis = argv.includes("--genesis");
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf-8"));
  const ids = argv.includes("--all") || argv.length === 0 || (genesis && argv.length === 1)
    ? manifest.vectors.map((v: any) => v.id)
    : argv.filter((a: string) => a !== "--genesis");

  const addressBook: Record<string, string> = manifest.addressBook;
  const pool = await ethers.getContractAt("PrivacyPool", addressBook.POOL);
  const usdc = await ethers.getContractAt("MockUSDCV2", addressBook.USDC);
  const rawProvider = new ethers.JsonRpcProvider(process.env.HUB_RPC || "http://localhost:8545");
  const ctx = { pool, usdc, addressBook, rawProvider };

  // ── Capture-window clock guard ─────────────────────────────────────────────
  // The corpus is time-dependent: shield-gasless-wrapper carries an EIP-2612
  // permit with deadline = capture block.timestamp + 3600 (see capture.ts).
  // Replaying on a fixturenet whose clock has moved past that window reverts
  // with "ERC20Permit: expired deadline" and the missing leaf cascades state
  // divergence into every later vector. Anvil refuses to warp time backwards
  // (evm_setNextBlockTimestamp: "lower than previous block's timestamp"), so
  // the fixturenet must be BOOTED with its genesis clock pinned to the capture
  // era. manifest.generatedAt is the end of the 83s capture run, so any chain
  // clock within [generatedAt, generatedAt + 1800] still leaves >=30 min of
  // permit validity for the whole replay.
  const generatedAtUnix = Math.floor(Date.parse(manifest.generatedAt) / 1000);
  const latestBlock = await rawProvider.getBlock("latest");
  if (!latestBlock) throw new Error("replay-check: cannot read latest block");
  if (latestBlock.timestamp > generatedAtUnix + 1800) {
    console.error(`replay-check: chain clock (${latestBlock.timestamp}) is past the capture window`);
    console.error(`  (corpus generatedAt ${manifest.generatedAt}; the gasless-vector EIP-2612 permit`);
    console.error(`   expires 1h after capture). Reboot the fixturenet with a pinned genesis time:`);
    console.error(`  anvil --port 8545 --chain-id 31337 --block-time 1 --accounts 200 --timestamp ${generatedAtUnix}`);
    process.exit(1);
  }

  if (genesis) {
    // Replicate the capture script's pre-vector setup EXACTLY (same accounts,
    // same order) so mock contracts land at the recorded addresses and all
    // funding/approval preconditions hold. This works because a freshly
    // booted Anvil + the fixed deploy-script sequence yields identical
    // nonces and therefore identical addresses.
    const signers = await ethers.getSigners();
    const [deployer, alice, bob, carol] = signers;
    console.log("genesis: deploying capture mocks + funding accounts...");
    const mockPause = await deployMock(deployer, "MockShieldPauseController");
    const mockFee = await deployMock(deployer, "MockConfigurableFeeModule");
    // v2 corpus extras (post-drift delta corpus, capture-v2.ts) deploy in the
    // SAME position as at capture time: registry mock and reentrancy token
    // immediately after the fee mock, BEFORE funding (nonce order is
    // load-bearing for address determinism).
    let evil: any;
    if (addressBook.MOCK_ADAPTER_REGISTRY) {
      const mockRegistry = await deployMock(deployer, "MockAdapterRegistry");
      if (mockRegistry.address !== addressBook.MOCK_ADAPTER_REGISTRY) {
        console.error(`genesis: registry mock diverges: ${mockRegistry.address} vs ${addressBook.MOCK_ADAPTER_REGISTRY}`);
        process.exit(1);
      }
    }
    if (addressBook.MALICIOUS_TOKEN) {
      const evilFactory = await ethers.getContractFactory("MaliciousReentrantToken");
      evil = await evilFactory.deploy();
      await evil.waitForDeployment();
      if ((await evil.getAddress()) !== addressBook.MALICIOUS_TOKEN) {
        console.error(`genesis: malicious token diverges: ${await evil.getAddress()} vs ${addressBook.MALICIOUS_TOKEN}`);
        process.exit(1);
      }
    }
    if (
      mockPause.address !== addressBook.MOCK_PAUSE ||
      mockFee.address !== addressBook.MOCK_FEE_MODULE
    ) {
      console.error("genesis: mock addresses diverge from the manifest addressBook —");
      console.error(`  pause: ${mockPause.address} vs ${addressBook.MOCK_PAUSE}`);
      console.error(`  fee:   ${mockFee.address} vs ${addressBook.MOCK_FEE_MODULE}`);
      console.error("  replay must start from a freshly booted fixturenet (see README).");
      process.exit(1);
    }
    await (await usdc.mint(alice.address, 10_000n * ONE_USDC)).wait();
    await (await usdc.mint(bob.address, 1_000n * ONE_USDC)).wait();
    await (await usdc.mint(carol.address, 1_000n * ONE_USDC)).wait();
    await (await usdc.connect(alice).approve(addressBook.POOL, ethers.MaxUint256)).wait();
    await (await usdc.connect(bob).approve(addressBook.POOL, ethers.MaxUint256)).wait();
    await (await usdc.connect(carol).approve(addressBook.POOL, ethers.MaxUint256)).wait();
    if (evil) {
      await (await evil.mint(alice.address, 100n * ONE_USDC)).wait();
      await (await evil.connect(alice).approve(addressBook.POOL, ethers.MaxUint256)).wait();
    }
    console.log("genesis: done");
  }

  console.log(`replay-check: ${ids.length} vector(s) against POOL=${addressBook.POOL}`);
  console.log("NOTE: assumes the deployment is at the recorded pre-state of the");
  console.log("      first requested vector (use --genesis on a fresh fixturenet).");

  let failed = 0;
  for (const id of ids) {
    if (!(await replayVector(id, ctx))) failed++;
  }
  console.log(`\nreplay-check: ${ids.length - failed}/${ids.length} matched`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
