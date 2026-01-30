import { ethers } from "ethers";
import { config } from "../relayer/config";
import {
  createShieldRequest,
  formatUSDC,
  parseUSDC,
} from "../lib/_legacy/shield_request";
import * as fs from "fs";
import * as path from "path";

/**
 * E2E Shield Test V2 - Real Railgun Integration
 *
 * Tests the full shield flow using RailgunSmartWallet:
 * 1. User generates ShieldRequest off-chain (npk, encryptedBundle, shieldKey)
 * 2. User approves USDC on client chain
 * 3. User calls ClientShieldProxyV2.shield()
 * 4. MockUSDC burns and emits BurnForDeposit
 * 5. Relayer picks up event and calls receiveMessage on hub
 * 6. HubCCTPReceiverV2 calls RailgunSmartWallet.shield()
 * 7. Commitment is added to Railgun merkle tree
 *
 * Prerequisites:
 * - Both Anvil chains running (npm run chains)
 * - Contracts deployed (npm run deploy:all)
 * - V2 contracts deployed (npm run deploy:v2)
 * - Relayer running (npm run relay)
 */

// ============ ABIs ============

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const CLIENT_SHIELD_PROXY_V2_ABI = [
  "function shield(uint256 amount, bytes32 npk, bytes32[3] calldata encryptedBundle, bytes32 shieldKey) external returns (uint64 nonce)",
  "function mockUSDC() view returns (address)",
  "function hubChainId() view returns (uint32)",
  "function hubReceiver() view returns (address)",
  "event ShieldInitiated(address indexed user, uint256 amount, bytes32 indexed npk, uint64 nonce)",
];

const RAILGUN_SMART_WALLET_ABI = [
  "function merkleRoot() view returns (bytes32)",
  "function nextLeafIndex() view returns (uint256)",
  "function treeNumber() view returns (uint256)",
  "function rootHistory(uint256, bytes32) view returns (bool)",
  "event Shield(uint256 treeNumber, uint256 startPosition, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext, uint256[] fees)",
];

// ============ Load Deployments ============

function loadDeployments(): { client: any; hub: any; railgun: any } {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const clientPath = path.join(deploymentsDir, "client.json");
  const hubPath = path.join(deploymentsDir, "hub.json");
  const railgunPath = path.join(deploymentsDir, "railgun.json");

  if (!fs.existsSync(clientPath) || !fs.existsSync(hubPath)) {
    throw new Error(
      "Deployments not found. Run 'npm run deploy:all' first."
    );
  }

  if (!fs.existsSync(railgunPath)) {
    throw new Error(
      "Railgun deployment not found. Run 'npm run deploy:railgun' first."
    );
  }

  const client = JSON.parse(fs.readFileSync(clientPath, "utf-8"));
  const hub = JSON.parse(fs.readFileSync(hubPath, "utf-8"));
  const railgun = JSON.parse(fs.readFileSync(railgunPath, "utf-8"));

  // Check for V2 contracts
  if (!client.contracts.clientShieldProxyV2) {
    throw new Error(
      "ClientShieldProxyV2 not found. Run 'npm run deploy:v2' first."
    );
  }

  if (!hub.contracts.hubCCTPReceiverV2) {
    throw new Error(
      "HubCCTPReceiverV2 not found. Run 'npm run deploy:v2' first."
    );
  }

  return { client, hub, railgun };
}

// ============ Test ============

async function main() {
  console.log(`
${"=".repeat(60)}
  E2E SHIELD TEST V2 - RAILGUN INTEGRATION
${"=".repeat(60)}
`);

  // Load deployments
  const deployments = loadDeployments();
  console.log("Loaded deployments:");
  console.log(`  Client MockUSDC: ${deployments.client.contracts.mockUSDC}`);
  console.log(`  ClientShieldProxyV2: ${deployments.client.contracts.clientShieldProxyV2}`);
  console.log(`  HubCCTPReceiverV2: ${deployments.hub.contracts.hubCCTPReceiverV2}`);
  console.log(`  RailgunSmartWallet: ${deployments.railgun.contracts.railgunProxy}`);

  // Setup providers and wallets
  const clientProvider = new ethers.JsonRpcProvider(config.clientChain.rpc);
  const hubProvider = new ethers.JsonRpcProvider(config.hubChain.rpc);

  // Verify chain connections
  const clientNetwork = await clientProvider.getNetwork();
  const hubNetwork = await hubProvider.getNetwork();
  console.log(`\nConnected to:`);
  console.log(`  Client chain: ${config.clientChain.rpc} (chain ID: ${clientNetwork.chainId})`);
  console.log(`  Hub chain: ${config.hubChain.rpc} (chain ID: ${hubNetwork.chainId})`);

  if (Number(clientNetwork.chainId) !== 31337) {
    throw new Error(`Expected client chain ID 31337, got ${clientNetwork.chainId}`);
  }
  if (Number(hubNetwork.chainId) !== 31338) {
    throw new Error(`Expected hub chain ID 31338, got ${hubNetwork.chainId}`);
  }

  // Use test user 1
  const user = new ethers.Wallet(config.accounts.user1.privateKey, clientProvider);
  console.log(`\nTest user: ${user.address}`);

  // Connect to contracts
  const clientUSDC = new ethers.Contract(
    deployments.client.contracts.mockUSDC,
    ERC20_ABI,
    user
  );

  const clientShieldProxyV2 = new ethers.Contract(
    deployments.client.contracts.clientShieldProxyV2,
    CLIENT_SHIELD_PROXY_V2_ABI,
    user
  );

  const railgunSmartWallet = new ethers.Contract(
    deployments.railgun.contracts.railgunProxy,
    RAILGUN_SMART_WALLET_ABI,
    hubProvider
  );

  // ============ Check Initial State ============

  console.log("\n--- Initial State ---");

  const initialClientBalance: bigint = await clientUSDC.balanceOf(user.address);
  console.log(`Client USDC balance: ${formatUSDC(initialClientBalance)} USDC`);

  const initialLeafIndex: bigint = await railgunSmartWallet.nextLeafIndex();
  const initialTreeNumber: bigint = await railgunSmartWallet.treeNumber();
  const initialMerkleRoot: string = await railgunSmartWallet.merkleRoot();
  console.log(`Railgun tree number: ${initialTreeNumber}`);
  console.log(`Railgun next leaf index: ${initialLeafIndex}`);
  console.log(`Railgun merkle root: ${initialMerkleRoot.slice(0, 20)}...`);

  // ============ Prepare Shield Request ============

  const shieldAmount = parseUSDC("100"); // Shield 100 USDC
  console.log(`\n--- Shielding ${formatUSDC(shieldAmount)} USDC ---`);

  // Generate ShieldRequest using proper Poseidon-based npk
  console.log("Generating ShieldRequest with Poseidon NPK...");
  const shieldNote = await createShieldRequest(
    user.address,
    shieldAmount,
    deployments.client.contracts.mockUSDC
  );

  console.log(`Generated NPK: ${shieldNote.request.npk.slice(0, 20)}...`);
  console.log(`Shield Key: ${shieldNote.request.shieldKey.slice(0, 20)}...`);
  console.log(`Random (secret): ${shieldNote.random.slice(0, 20)}...`);

  // ============ Approve USDC ============

  console.log("\nStep 1: Approving USDC...");
  const approveTx = await clientUSDC.approve(
    deployments.client.contracts.clientShieldProxyV2,
    shieldAmount
  );
  await approveTx.wait();
  console.log(`  Approved ${formatUSDC(shieldAmount)} USDC for ClientShieldProxyV2`);

  // ============ Call Shield V2 ============

  console.log("\nStep 2: Calling ClientShieldProxyV2.shield()...");
  const shieldTx = await clientShieldProxyV2.shield(
    shieldAmount,
    shieldNote.request.npk,
    shieldNote.request.encryptedBundle,
    shieldNote.request.shieldKey
  );
  const shieldReceipt = await shieldTx.wait();
  console.log(`  Shield tx: ${shieldTx.hash}`);
  console.log(`  Block: ${shieldReceipt?.blockNumber}`);

  // Parse events
  const shieldInterface = new ethers.Interface(CLIENT_SHIELD_PROXY_V2_ABI);
  for (const log of shieldReceipt?.logs || []) {
    try {
      const parsed = shieldInterface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "ShieldInitiated") {
        console.log(`  CCTP Nonce: ${parsed.args.nonce}`);
      }
    } catch {
      // Not our event
    }
  }

  // ============ Wait for Relayer ============

  console.log("\nStep 3: Waiting for relayer to process...");
  console.log("  (The relayer should pick up the BurnForDeposit event)");

  // Poll for commitment to appear on hub (merkle tree update)
  const maxWaitTime = 30000; // 30 seconds
  const pollInterval = 2000; // 2 seconds
  const startTime = Date.now();
  let found = false;

  while (Date.now() - startTime < maxWaitTime) {
    const currentLeafIndex: bigint = await railgunSmartWallet.nextLeafIndex();

    if (currentLeafIndex > initialLeafIndex) {
      found = true;
      console.log(`  Commitment added to Railgun! Leaf index: ${currentLeafIndex}`);
      break;
    }

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  if (!found) {
    console.error("\n  ERROR: Commitment not added to Railgun after 30 seconds");
    console.error("  Make sure the relayer is running (npm run relay)");
    console.error("  Check hub chain logs for errors");
    process.exit(1);
  }

  // ============ Verify State ============

  console.log("\n--- Final State ---");

  const finalClientBalance: bigint = await clientUSDC.balanceOf(user.address);
  console.log(`Client USDC balance: ${formatUSDC(finalClientBalance)} USDC`);
  console.log(`  Difference: -${formatUSDC(BigInt(initialClientBalance) - BigInt(finalClientBalance))} USDC`);

  const finalLeafIndex: bigint = await railgunSmartWallet.nextLeafIndex();
  const finalTreeNumber: bigint = await railgunSmartWallet.treeNumber();
  const finalMerkleRoot: string = await railgunSmartWallet.merkleRoot();
  console.log(`Railgun tree number: ${finalTreeNumber}`);
  console.log(`Railgun next leaf index: ${finalLeafIndex}`);
  console.log(`Railgun merkle root: ${finalMerkleRoot.slice(0, 20)}...`);

  // Verify the new merkle root is in root history
  const rootValid = await railgunSmartWallet.rootHistory(finalTreeNumber, finalMerkleRoot);
  if (!rootValid) {
    console.error("  ERROR: New merkle root not in root history!");
    process.exit(1);
  }
  console.log(`  Merkle root valid in history: ${rootValid}`);

  // Calculate commitment position
  const commitmentPosition = Number(initialLeafIndex);
  console.log(`  Our commitment at position: ${commitmentPosition}`);

  // ============ Summary ============

  console.log(`
${"=".repeat(60)}
  SHIELD V2 TEST PASSED!
${"=".repeat(60)}

Summary:
  - Shielded: ${formatUSDC(shieldAmount)} USDC
  - NPK: ${shieldNote.request.npk.slice(0, 30)}...
  - Tree Number: ${finalTreeNumber}
  - Commitment Position: ${commitmentPosition}
  - Client balance reduced by: ${formatUSDC(BigInt(initialClientBalance) - BigInt(finalClientBalance))} USDC

The funds are now in the REAL Railgun shielded pool on the hub chain!
This uses the actual Railgun Poseidon-based commitment scheme.

User can later:
  - Transfer privately to another user (requires ZK proof)
  - Unshield back to any chain (requires ZK proof)
`);

  // Save note data for use in other tests
  const noteData = {
    npk: shieldNote.request.npk,
    random: shieldNote.random,
    amount: shieldAmount.toString(),
    recipient: user.address,
    tokenAddress: deployments.client.contracts.mockUSDC,
    treeNumber: Number(finalTreeNumber),
    commitmentPosition,
    encryptedBundle: shieldNote.request.encryptedBundle,
    shieldKey: shieldNote.request.shieldKey,
    timestamp: new Date().toISOString(),
  };

  const notesDir = path.join(__dirname, "../notes");
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(notesDir, "shielded_note_v2.json"),
    JSON.stringify(noteData, null, 2)
  );
  console.log("Note data saved to notes/shielded_note_v2.json");
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
