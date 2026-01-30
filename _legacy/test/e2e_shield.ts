import { ethers } from "ethers";
import { config } from "../relayer/config";
import {
  createShieldRequest,
  parseUSDC,
  formatUSDC,
} from "../lib/note_generator";
import * as fs from "fs";
import * as path from "path";

/**
 * E2E Shield Test
 *
 * Tests the full shield flow:
 * 1. User approves USDC on client chain
 * 2. User calls ClientShieldProxy.shield()
 * 3. MockUSDC burns and emits BurnForDeposit
 * 4. Relayer picks up event and calls receiveMessage on hub
 * 5. HubCCTPReceiver forwards to SimpleShieldAdapter
 * 6. Commitment is added to shielded pool
 *
 * Prerequisites:
 * - Both Anvil chains running (npm run chains)
 * - Contracts deployed (npm run deploy:all)
 * - Relayer running (npm run relay)
 */

// ============ ABIs ============

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const CLIENT_SHIELD_PROXY_ABI = [
  "function shield(uint256 amount, bytes32 commitment, bytes calldata encryptedNote) external",
  "function mockUSDC() view returns (address)",
  "function hubChainId() view returns (uint32)",
  "function hubReceiver() view returns (address)",
  "event ShieldInitiated(address indexed sender, uint256 amount, bytes32 commitment)",
];

const SIMPLE_SHIELD_ADAPTER_ABI = [
  "function commitments(uint256) view returns (bytes32)",
  "function getCommitmentCount() view returns (uint256)",
  "function getCommitment(uint256 index) view returns (bytes32)",
  "function commitmentExists(bytes32) view returns (bool)",
  "event CommitmentInserted(uint256 indexed index, bytes32 indexed commitment, uint256 amount, bytes encryptedNote)",
];

// ============ Load Deployments ============

function loadDeployments(): { client: any; hub: any } {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const clientPath = path.join(deploymentsDir, "client.json");
  const hubPath = path.join(deploymentsDir, "hub.json");

  if (!fs.existsSync(clientPath) || !fs.existsSync(hubPath)) {
    throw new Error(
      "Deployments not found. Run 'npm run deploy:all' first."
    );
  }

  return {
    client: JSON.parse(fs.readFileSync(clientPath, "utf-8")),
    hub: JSON.parse(fs.readFileSync(hubPath, "utf-8")),
  };
}

// ============ Test ============

async function main() {
  console.log(`
${"=".repeat(60)}
  E2E SHIELD TEST
${"=".repeat(60)}
`);

  // Load deployments
  const deployments = loadDeployments();
  console.log("Loaded deployments:");
  console.log(`  Client MockUSDC: ${deployments.client.contracts.mockUSDC}`);
  console.log(`  ClientShieldProxy: ${deployments.client.contracts.clientShieldProxy}`);
  console.log(`  Hub ShieldAdapter: ${deployments.hub.contracts.shieldAdapter}`);

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

  const clientShieldProxy = new ethers.Contract(
    deployments.client.contracts.clientShieldProxy,
    CLIENT_SHIELD_PROXY_ABI,
    user
  );

  const hubShieldAdapter = new ethers.Contract(
    deployments.hub.contracts.shieldAdapter,
    SIMPLE_SHIELD_ADAPTER_ABI,
    hubProvider
  );

  // ============ Check Initial State ============

  console.log("\n--- Initial State ---");

  const initialClientBalance: bigint = await clientUSDC.balanceOf(user.address);
  console.log(`Client USDC balance: ${formatUSDC(initialClientBalance)} USDC`);

  const initialCommitmentCount = await hubShieldAdapter.getCommitmentCount();
  console.log(`Hub commitment count: ${initialCommitmentCount}`);

  // ============ Prepare Shield Request ============

  const shieldAmount = parseUSDC("100"); // Shield 100 USDC
  console.log(`\n--- Shielding ${formatUSDC(shieldAmount)} USDC ---`);

  // Generate commitment and payload
  const { note, payload } = createShieldRequest(user.address, shieldAmount);
  console.log(`Generated commitment: ${note.commitment}`);
  console.log(`Randomness (secret): ${note.randomness.slice(0, 20)}...`);

  // ============ Approve USDC ============

  console.log("\nStep 1: Approving USDC...");
  const approveTx = await clientUSDC.approve(
    deployments.client.contracts.clientShieldProxy,
    shieldAmount
  );
  await approveTx.wait();
  console.log(`  Approved ${formatUSDC(shieldAmount)} USDC for ClientShieldProxy`);

  // ============ Call Shield ============

  console.log("\nStep 2: Calling shield()...");
  const shieldTx = await clientShieldProxy.shield(
    shieldAmount,
    note.commitment,
    note.encryptedNote
  );
  const shieldReceipt = await shieldTx.wait();
  console.log(`  Shield tx: ${shieldTx.hash}`);
  console.log(`  Block: ${shieldReceipt?.blockNumber}`);

  // ============ Wait for Relayer ============

  console.log("\nStep 3: Waiting for relayer to process...");
  console.log("  (The relayer should pick up the BurnForDeposit event)");

  // Poll for commitment to appear on hub
  const maxWaitTime = 30000; // 30 seconds
  const pollInterval = 2000; // 2 seconds
  const startTime = Date.now();
  let found = false;

  while (Date.now() - startTime < maxWaitTime) {
    const currentCount = await hubShieldAdapter.getCommitmentCount();

    if (currentCount > initialCommitmentCount) {
      found = true;
      console.log(`  Commitment appeared on hub! Count: ${currentCount}`);
      break;
    }

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  if (!found) {
    console.error("\n  ERROR: Commitment not found on hub after 30 seconds");
    console.error("  Make sure the relayer is running (npm run relay)");
    process.exit(1);
  }

  // ============ Verify State ============

  console.log("\n--- Final State ---");

  const finalClientBalance: bigint = await clientUSDC.balanceOf(user.address);
  console.log(`Client USDC balance: ${formatUSDC(finalClientBalance)} USDC`);
  console.log(`  Difference: -${formatUSDC(BigInt(initialClientBalance) - BigInt(finalClientBalance))} USDC`);

  const finalCommitmentCount = await hubShieldAdapter.getCommitmentCount();
  console.log(`Hub commitment count: ${finalCommitmentCount}`);

  // Verify our commitment exists
  const commitmentExists = await hubShieldAdapter.commitmentExists(note.commitment);

  if (!commitmentExists) {
    console.error("  ERROR: Our commitment not found in the pool!");
    process.exit(1);
  }

  // Find our commitment index (it should be the last one added)
  const ourCommitmentIndex = Number(finalCommitmentCount) - 1;
  const storedCommitment = await hubShieldAdapter.getCommitment(ourCommitmentIndex);

  if (storedCommitment.toLowerCase() === note.commitment.toLowerCase()) {
    console.log(`  Our commitment found at index: ${ourCommitmentIndex}`);
  } else {
    console.error("  ERROR: Commitment at expected index doesn't match!");
    process.exit(1);
  }

  // ============ Summary ============

  console.log(`
${"=".repeat(60)}
  SHIELD TEST PASSED!
${"=".repeat(60)}

Summary:
  - Shielded: ${formatUSDC(shieldAmount)} USDC
  - Commitment: ${note.commitment}
  - Client balance reduced by: ${formatUSDC(BigInt(initialClientBalance) - BigInt(finalClientBalance))} USDC
  - Commitment added to hub pool at index: ${ourCommitmentIndex}

The funds are now in the shielded pool on the hub chain.
User can later:
  - Transfer privately to another user (test:transfer)
  - Unshield back to any chain (test:unshield)
`);

  // Save note data for use in other tests
  const noteData = {
    commitment: note.commitment,
    randomness: note.randomness,
    amount: shieldAmount.toString(),
    recipient: user.address,
    commitmentIndex: ourCommitmentIndex,
    timestamp: new Date().toISOString(),
  };

  const notesDir = path.join(__dirname, "../notes");
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(notesDir, "shielded_note.json"),
    JSON.stringify(noteData, null, 2)
  );
  console.log("Note data saved to notes/shielded_note.json");
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
