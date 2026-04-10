/**
 * Sepolia Smoke Test
 *
 * Validates deployed contracts on Sepolia testnet by running through
 * the core flows with real USDC:
 *
 *   1. Contract connectivity — reads state from all deployed contracts
 *   2. Hub shield — approve USDC → shield → verify Merkle root changes
 *   3. Cross-chain shield (Client A → Hub) — burn USDC on Base Sepolia via CCTP
 *      (requires relayer to complete the hub-side)
 *
 * Prerequisites:
 *   - source config/sepolia.env
 *   - Deployer funded with testnet USDC (https://faucet.circle.com/)
 *   - Deployer funded with ETH on Ethereum Sepolia (for hub tests)
 *   - Deployer funded with ETH on Base Sepolia (for cross-chain tests)
 *
 * Usage:
 *   npm run test:sepolia                    # Run all checks
 *   npm run test:sepolia -- --check         # Read-only checks only (no USDC needed)
 *   npm run test:sepolia -- --shield        # Hub shield test
 *   npm run test:sepolia -- --cross-chain   # Cross-chain shield test
 */

import { ethers } from "ethers";
import { getNetworkConfig } from "../config/networks";
import { loadDeployment } from "./deploy-utils";

// ============================================================================
// Minimal ABIs (only what we need — avoids hardhat dependency)
// ============================================================================

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const PRIVACY_POOL_ABI = [
  "function owner() view returns (address)",
  "function treeNumber() view returns (uint256)",
  "function merkleRoot() view returns (bytes32)",
  "function shieldFee() view returns (uint256)",
  "function treasury() view returns (address)",
  "function testingMode() view returns (bool)",
  "function localDomain() view returns (uint32)",
  "function remotePools(uint32) view returns (bytes32)",
  "function getVerificationKey(uint256 nullifiers, uint256 commitments) view returns (tuple(string artifactsIPFSHash, tuple(uint256 x, uint256 y) alpha1, tuple(uint256[2] x, uint256[2] y) beta2, tuple(uint256[2] x, uint256[2] y) gamma2, tuple(uint256[2] x, uint256[2] y) delta2, tuple(uint256 x, uint256 y)[] ic))",
  "function shield(tuple(tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests) external",
];

const PRIVACY_POOL_CLIENT_ABI = [
  "function owner() view returns (address)",
  "function localDomain() view returns (uint32)",
  "function hubDomain() view returns (uint32)",
  "function hubPool() view returns (bytes32)",
  "function crossChainShield(uint256 amount, uint256 maxFee, bytes32 npk, bytes32[3] encryptedBundle, bytes32 shieldKey, bytes32 destinationCaller) external returns (uint64)",
];

// ============================================================================
// Helpers
// ============================================================================

const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function formatUsdc(amount: bigint): string {
  const abs = amount < 0n ? -amount : amount;
  const sign = amount < 0n ? "-" : "";
  const whole = abs / 1000000n;
  const frac = (abs % 1000000n).toString().padStart(6, "0");
  return `${sign}${whole}.${frac}`;
}

function passed(msg: string) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function failed(msg: string) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
function info(msg: string)   { console.log(`  → ${msg}`); }

/** Wait for tx receipt with retries (public RPCs can return transient errors like "indexing in progress") */
async function waitForTx(tx: ethers.TransactionResponse, retries = 10, delayMs = 5000): Promise<ethers.TransactionReceipt> {
  for (let i = 0; i < retries; i++) {
    try {
      const receipt = await tx.wait();
      if (receipt) return receipt;
    } catch (e: any) {
      const msg = e?.error?.message ?? e?.message ?? "";
      if (msg.includes("indexing") || msg.includes("coalesce") || msg.includes("not found")) {
        info(`Receipt not ready (attempt ${i + 1}/${retries}), retrying in ${delayMs / 1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw e; // re-throw non-transient errors
    }
  }
  throw new Error(`Tx ${tx.hash} — receipt not available after ${retries} retries`);
}

/** Get EIP-1559 fee overrides with a bumped priority fee to avoid stuck txs on public testnets */
async function getFeeOverrides(provider: ethers.JsonRpcProvider, gasLimit = 200000) {
  const feeData = await provider.getFeeData();
  const baseFee = feeData.maxFeePerGas ?? 2000000000n; // 2 gwei fallback
  const tip = feeData.maxPriorityFeePerGas ?? 1000000000n; // 1 gwei fallback
  // 2x the tip to get picked up quickly, cap maxFee at 2x base + tip
  const bumpedTip = tip * 2n > 1500000000n ? tip * 2n : 1500000000n; // at least 1.5 gwei
  return {
    maxPriorityFeePerGas: bumpedTip,
    maxFeePerGas: baseFee * 2n + bumpedTip,
    gasLimit,
  };
}

// ============================================================================
// Test: Contract Connectivity
// ============================================================================

async function testConnectivity(config: ReturnType<typeof getNetworkConfig>) {
  console.log("\n" + "=".repeat(60));
  console.log("  CHECK 1: Contract Connectivity");
  console.log("=".repeat(60));

  const hubProvider = new ethers.JsonRpcProvider(config.hub.rpc);
  const clientAProvider = new ethers.JsonRpcProvider(config.clientA.rpc);

  // Hub chain
  console.log("\n  Hub (Ethereum Sepolia):");
  const hubDeployment = loadDeployment("privacy-pool-hub-sepolia.json");
  if (!hubDeployment) { failed("Hub deployment not found"); return false; }

  const hubPool = new ethers.Contract(hubDeployment.contracts.privacyPool, PRIVACY_POOL_ABI, hubProvider);
  const hubUsdc = new ethers.Contract(hubDeployment.cctp.usdc, ERC20_ABI, hubProvider);

  try {
    const owner = await hubPool.owner();
    const domain = await hubPool.localDomain();
    const treeNum = await hubPool.treeNumber();
    const merkleRoot = await hubPool.merkleRoot();
    const shieldFee = await hubPool.shieldFee();
    const treasury = await hubPool.treasury();
    const testingMode = await hubPool.testingMode();
    const usdcSymbol = await hubUsdc.symbol();
    const usdcDecimals = await hubUsdc.decimals();

    passed(`PrivacyPool at ${hubDeployment.contracts.privacyPool}`);
    info(`Owner: ${owner}`);
    info(`Domain: ${domain}, Tree: ${treeNum}, Shield fee: ${shieldFee} bps`);
    info(`Treasury: ${treasury}`);
    info(`Merkle root: ${merkleRoot}`);
    info(`Testing mode: ${testingMode}`);
    passed(`USDC: ${usdcSymbol} (${usdcDecimals} decimals)`);

    // Check verification keys loaded
    const vkConfigs = [
      { n: 1, c: 1 }, // Cross-contract: lend/redeem
      { n: 1, c: 2 }, // Shield: 1 input -> 2 outputs
      { n: 2, c: 2 }, // Simple transfer
      { n: 2, c: 3 }, // Transfer with change
      { n: 8, c: 4 }, // Medium consolidation
    ];
    const vkResults: string[] = [];
    let vkAllLoaded = true;
    for (const { n, c } of vkConfigs) {
      try {
        const vk = await hubPool.getVerificationKey(n, c);
        if (vk.alpha1.x !== 0n) {
          vkResults.push(`${n}x${c}`);
        } else {
          vkAllLoaded = false;
          failed(`Verification key ${n}x${c} not loaded (alpha1.x == 0)`);
        }
      } catch (e: any) {
        vkAllLoaded = false;
        failed(`Verification key ${n}x${c} check failed: ${e.message}`);
      }
    }
    if (vkAllLoaded) {
      passed(`Verification keys loaded: ${vkResults.join(", ")}`);
    }

    // Check authorized spoke clients (Hub's remotePools mapping)
    const remotePoolA = await hubPool.remotePools(config.clientA.cctpDomain);
    if (remotePoolA !== ethers.ZeroHash) {
      passed(`Client A authorized on Hub (domain ${config.clientA.cctpDomain}): ${remotePoolA}`);
    } else {
      failed(`Client A not authorized on Hub (domain ${config.clientA.cctpDomain})`);
    }

    const remotePoolB = await hubPool.remotePools(config.clientB.cctpDomain);
    if (remotePoolB !== ethers.ZeroHash) {
      passed(`Client B authorized on Hub (domain ${config.clientB.cctpDomain}): ${remotePoolB}`);
    } else {
      info(`Client B not authorized on Hub (domain ${config.clientB.cctpDomain})`);
    }
  } catch (e: any) {
    failed(`Hub contract calls failed: ${e.message}`);
    return false;
  }

  // Client A chain
  console.log("\n  Client A (Base Sepolia):");
  const clientDeployment = loadDeployment("privacy-pool-client-sepolia.json");
  if (!clientDeployment) { failed("Client A deployment not found"); return false; }

  const clientPool = new ethers.Contract(clientDeployment.contracts.privacyPoolClient, PRIVACY_POOL_CLIENT_ABI, clientAProvider);

  try {
    const owner = await clientPool.owner();
    const domain = await clientPool.localDomain();
    const hubDomain = await clientPool.hubDomain();
    const hubPoolAddr = await clientPool.hubPool();

    passed(`PrivacyPoolClient at ${clientDeployment.contracts.privacyPoolClient}`);
    info(`Owner: ${owner}`);
    info(`Domain: ${domain}, Hub domain: ${hubDomain}`);
    info(`Hub pool: ${hubPoolAddr}`);
  } catch (e: any) {
    failed(`Client A contract calls failed: ${e.message}`);
    return false;
  }

  // Client B chain
  console.log("\n  Client B (Arbitrum Sepolia):");
  const clientBDeployment = loadDeployment("privacy-pool-clientB-sepolia.json");
  if (!clientBDeployment) {
    info("Client B deployment not found (skipped)");
  } else {
    const clientBProvider = new ethers.JsonRpcProvider(config.clientB.rpc);
    const clientBPool = new ethers.Contract(clientBDeployment.contracts.privacyPoolClient, PRIVACY_POOL_CLIENT_ABI, clientBProvider);

    try {
      const owner = await clientBPool.owner();
      const domain = await clientBPool.localDomain();
      const hubDomain = await clientBPool.hubDomain();
      const hubPoolAddr = await clientBPool.hubPool();

      passed(`PrivacyPoolClient at ${clientBDeployment.contracts.privacyPoolClient}`);
      info(`Owner: ${owner}`);
      info(`Domain: ${domain}, Hub domain: ${hubDomain}`);
      info(`Hub pool: ${hubPoolAddr}`);
    } catch (e: any) {
      failed(`Client B contract calls failed: ${e.message}`);
    }
  }

  // Deployer balances
  console.log("\n  Deployer Balances:");
  const signer = new ethers.Wallet(config.deployerPrivateKey, hubProvider);
  const deployerAddress = signer.address;

  const hubEth = await hubProvider.getBalance(deployerAddress);
  const hubUsdcBal = await hubUsdc.balanceOf(deployerAddress);
  info(`Hub ETH:  ${ethers.formatEther(hubEth)}`);
  info(`Hub USDC: ${formatUsdc(BigInt(hubUsdcBal))}`);

  const clientAUsdc = new ethers.Contract(clientDeployment.cctp.usdc, ERC20_ABI, clientAProvider);
  const clientAEth = await clientAProvider.getBalance(deployerAddress);
  const clientAUsdcBal = await clientAUsdc.balanceOf(deployerAddress);
  info(`Client A ETH:  ${ethers.formatEther(clientAEth)}`);
  info(`Client A USDC: ${formatUsdc(BigInt(clientAUsdcBal))}`);

  if (clientBDeployment) {
    const clientBProvider = new ethers.JsonRpcProvider(config.clientB.rpc);
    const clientBUsdc = new ethers.Contract(clientBDeployment.cctp.usdc, ERC20_ABI, clientBProvider);
    const clientBEth = await clientBProvider.getBalance(deployerAddress);
    const clientBUsdcBal = await clientBUsdc.balanceOf(deployerAddress);
    info(`Client B ETH:  ${ethers.formatEther(clientBEth)}`);
    info(`Client B USDC: ${formatUsdc(BigInt(clientBUsdcBal))}`);
  }

  if (hubUsdcBal === 0n && clientAUsdcBal === 0n) {
    console.log("\n  ⚠  No USDC on either chain. Get testnet USDC from https://faucet.circle.com/");
  }

  return true;
}

// ============================================================================
// Test: Hub Shield
// ============================================================================

async function testHubShield(config: ReturnType<typeof getNetworkConfig>, amount: bigint) {
  console.log("\n" + "=".repeat(60));
  console.log("  CHECK 2: Hub Shield");
  console.log("=".repeat(60));

  const hubProvider = new ethers.JsonRpcProvider(config.hub.rpc);
  const signer = new ethers.Wallet(config.deployerPrivateKey, hubProvider);
  const deployerAddress = signer.address;

  const hubDeployment = loadDeployment("privacy-pool-hub-sepolia.json");
  if (!hubDeployment) { failed("Hub deployment not found"); return false; }

  const privacyPoolAddress = hubDeployment.contracts.privacyPool;
  const usdcAddress = hubDeployment.cctp.usdc;

  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
  const privacyPool = new ethers.Contract(privacyPoolAddress, PRIVACY_POOL_ABI, signer);

  // Check balance
  const balance = BigInt(await usdc.balanceOf(deployerAddress));
  info(`USDC balance: ${formatUsdc(balance)}`);
  if (balance < amount) {
    failed(`Insufficient USDC. Need ${formatUsdc(amount)}, have ${formatUsdc(balance)}`);
    info("Get testnet USDC from https://faucet.circle.com/");
    return false;
  }

  // Read state before
  const merkleRootBefore = await privacyPool.merkleRoot();
  const poolBalBefore = BigInt(await usdc.balanceOf(privacyPoolAddress));
  const treasury = await privacyPool.treasury();
  const treasuryBalBefore = BigInt(await usdc.balanceOf(treasury));

  info(`Merkle root before: ${merkleRootBefore}`);
  info(`Pool USDC before:   ${formatUsdc(poolBalBefore)}`);

  // Approve
  console.log("\n  Step 1: Approve USDC...");
  const fees = await getFeeOverrides(hubProvider);
  info(`Gas: maxFee=${ethers.formatUnits(fees.maxFeePerGas, "gwei")} gwei, tip=${ethers.formatUnits(fees.maxPriorityFeePerGas, "gwei")} gwei`);
  const approveTx = await usdc.approve(privacyPoolAddress, amount, fees);
  info(`Tx: ${approveTx.hash}`);
  await waitForTx(approveTx);
  passed("USDC approved");

  // Build shield request
  console.log("  Step 2: Shield...");
  const rawNpk = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`sepolia-smoke-test-${Date.now()}`)));
  const validNpk = rawNpk % SNARK_SCALAR_FIELD;
  const npk = ethers.zeroPadValue(ethers.toBeHex(validNpk), 32);

  const shieldRequest = {
    preimage: {
      npk,
      token: {
        tokenType: 0, // ERC20
        tokenAddress: usdcAddress,
        tokenSubID: 0,
      },
      value: amount,
    },
    ciphertext: {
      encryptedBundle: [
        ethers.keccak256(ethers.toUtf8Bytes("sepolia-enc1")),
        ethers.keccak256(ethers.toUtf8Bytes("sepolia-enc2")),
        ethers.keccak256(ethers.toUtf8Bytes("sepolia-enc3")),
      ] as [string, string, string],
      shieldKey: ethers.keccak256(ethers.toUtf8Bytes("sepolia-shield-key")),
    },
  };

  const fees2 = await getFeeOverrides(hubProvider, 2000000); // shield needs ~1.5M gas (Poseidon + Merkle tree)
  const shieldTx = await privacyPool.shield([shieldRequest], fees2);
  info(`Tx: ${shieldTx.hash}`);
  const receipt = await waitForTx(shieldTx);
  passed(`Shield confirmed in block ${receipt.blockNumber}`);

  // Verify results
  console.log("  Step 3: Verify...");
  const merkleRootAfter = await privacyPool.merkleRoot();
  const poolBalAfter = BigInt(await usdc.balanceOf(privacyPoolAddress));
  const treasuryBalAfter = BigInt(await usdc.balanceOf(treasury));

  const shieldFee = BigInt(await privacyPool.shieldFee());
  const expectedFee = amount * shieldFee / 10000n;
  const expectedBase = amount - expectedFee;

  if (merkleRootAfter !== merkleRootBefore) {
    passed(`Merkle root changed: ${merkleRootAfter}`);
  } else {
    failed("Merkle root did NOT change");
  }

  const poolReceived = poolBalAfter - poolBalBefore;
  if (poolReceived === expectedBase) {
    passed(`Pool received ${formatUsdc(poolReceived)} USDC (base after ${shieldFee} bps fee)`);
  } else {
    failed(`Pool received ${formatUsdc(poolReceived)} USDC (expected ${formatUsdc(expectedBase)})`);
  }

  const treasuryReceived = treasuryBalAfter - treasuryBalBefore;
  if (treasury.toLowerCase() === deployerAddress.toLowerCase()) {
    // Treasury == sender: net change is -(base), since sender pays amount but gets fee back
    const expectedNet = expectedFee - amount;
    if (treasuryReceived === expectedNet) {
      passed(`Treasury fee correct (treasury == sender, net change: ${formatUsdc(expectedNet)} USDC, fee: ${formatUsdc(expectedFee)})`);
    } else {
      failed(`Treasury net change ${formatUsdc(treasuryReceived)} USDC (expected ${formatUsdc(expectedNet)})`);
    }
  } else if (treasuryReceived === expectedFee) {
    passed(`Treasury received ${formatUsdc(treasuryReceived)} USDC fee`);
  } else {
    failed(`Treasury received ${formatUsdc(treasuryReceived)} USDC (expected ${formatUsdc(expectedFee)})`);
  }

  return true;
}

// ============================================================================
// Test: Cross-Chain Shield (Client A → Hub)
// ============================================================================

async function testCrossChainShield(config: ReturnType<typeof getNetworkConfig>, amount: bigint) {
  console.log("\n" + "=".repeat(60));
  console.log("  CHECK 3: Cross-Chain Shield (Base Sepolia → Ethereum Sepolia)");
  console.log("=".repeat(60));

  const clientAProvider = new ethers.JsonRpcProvider(config.clientA.rpc);
  const signer = new ethers.Wallet(config.deployerPrivateKey, clientAProvider);
  const deployerAddress = signer.address;

  const clientDeployment = loadDeployment("privacy-pool-client-sepolia.json");
  if (!clientDeployment) { failed("Client A deployment not found"); return false; }

  const clientAddress = clientDeployment.contracts.privacyPoolClient;
  const usdcAddress = clientDeployment.cctp.usdc;

  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
  const client = new ethers.Contract(clientAddress, PRIVACY_POOL_CLIENT_ABI, signer);

  // Check balance
  const balance = BigInt(await usdc.balanceOf(deployerAddress));
  info(`Base Sepolia USDC balance: ${formatUsdc(balance)}`);
  if (balance < amount) {
    failed(`Insufficient USDC on Base Sepolia. Need ${formatUsdc(amount)}, have ${formatUsdc(balance)}`);
    info("Get testnet USDC from https://faucet.circle.com/ (select Base Sepolia)");
    return false;
  }

  // Cross-chain shield params
  const MAX_FEE = ethers.parseUnits("0", 6); // 0 fee for testing (CCTP testnet doesn't charge)
  const rawNpk = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`sepolia-xchain-${Date.now()}`)));
  const validNpk = rawNpk % SNARK_SCALAR_FIELD;
  const npk = ethers.zeroPadValue(ethers.toBeHex(validNpk), 32);
  const encryptedBundle: [string, string, string] = [
    ethers.keccak256(ethers.toUtf8Bytes("xchain-enc1")),
    ethers.keccak256(ethers.toUtf8Bytes("xchain-enc2")),
    ethers.keccak256(ethers.toUtf8Bytes("xchain-enc3")),
  ];
  const shieldKey = ethers.keccak256(ethers.toUtf8Bytes("xchain-shield-key"));

  // Approve
  console.log("\n  Step 1: Approve USDC on Base Sepolia...");
  const fees = await getFeeOverrides(clientAProvider);
  info(`Gas: maxFee=${ethers.formatUnits(fees.maxFeePerGas, "gwei")} gwei, tip=${ethers.formatUnits(fees.maxPriorityFeePerGas, "gwei")} gwei`);
  const approveTx = await usdc.approve(clientAddress, amount, fees);
  info(`Tx: ${approveTx.hash}`);
  await waitForTx(approveTx);
  passed("USDC approved");

  // Cross-chain shield
  console.log("  Step 2: Cross-chain shield...");
  const fees2 = await getFeeOverrides(clientAProvider, 500000); // cross-chain shield: CCTP burn + message send
  const shieldTx = await client.crossChainShield(
    amount,
    MAX_FEE,
    npk,
    encryptedBundle,
    shieldKey,
    ethers.ZeroHash, // any relayer can relay
    fees2
  ,
  ethers.ZeroAddress);
  info(`Tx: ${shieldTx.hash}`);
  const receipt = await waitForTx(shieldTx);
  passed(`Cross-chain shield initiated in block ${receipt.blockNumber}`);

  // Verify USDC was burned
  const balanceAfter = BigInt(await usdc.balanceOf(deployerAddress));
  const spent = balance - balanceAfter;
  if (spent === amount) {
    passed(`${formatUsdc(amount)} USDC burned on Base Sepolia`);
  } else {
    failed(`Expected to burn ${formatUsdc(amount)}, actual: ${formatUsdc(spent)}`);
  }

  console.log("\n  Step 3: Wait for relay...");
  info("CCTP message sent. The relayer will:");
  info("  1. Detect the MessageSent event on Base Sepolia");
  info("  2. Poll Iris API for attestation (~20s fast finality)");
  info("  3. Relay to Hub (Ethereum Sepolia)");
  info("  4. Hub PrivacyPool will shield and insert commitment");
  info("");
  info("Run the relayer: npm run relayer:sepolia");
  info("Then check the Hub merkle root to verify completion.");

  return true;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const config = getNetworkConfig();

  if (config.env !== "sepolia") {
    console.error("Error: DEPLOY_ENV must be 'sepolia'");
    console.error("Run: source config/sepolia.env");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const doShield = args.includes("--shield");
  const doCrossChain = args.includes("--cross-chain");
  const runAll = !checkOnly && !doShield && !doCrossChain;

  const SHIELD_AMOUNT = ethers.parseUnits("1", 6); // 1 USDC
  const CROSS_CHAIN_AMOUNT = ethers.parseUnits("1", 6); // 1 USDC

  console.log("=".repeat(60));
  console.log("  SEPOLIA SMOKE TEST");
  console.log("=".repeat(60));
  console.log(`  Hub:      ${config.hub.name} (${config.hub.rpc})`);
  console.log(`  Client A: ${config.clientA.name} (${config.clientA.rpc})`);
  console.log(`  Client B: ${config.clientB.name} (${config.clientB.rpc})`);

  // Always run connectivity check
  const connected = await testConnectivity(config);
  if (!connected) {
    console.error("\nConnectivity check failed. Fix deployment issues first.");
    process.exit(1);
  }

  if (checkOnly) {
    console.log("\n✓ Connectivity check passed. Use --shield or --cross-chain to run transactions.");
    process.exit(0);
  }

  // Hub shield
  if (runAll || doShield) {
    await testHubShield(config, SHIELD_AMOUNT);
  }

  // Cross-chain shield
  if (runAll || doCrossChain) {
    await testCrossChainShield(config, CROSS_CHAIN_AMOUNT);
  }

  console.log("\n" + "=".repeat(60));
  console.log("  SMOKE TEST COMPLETE");
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error("\nSmoke test failed:", e);
  process.exit(1);
});
