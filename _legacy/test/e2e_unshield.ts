import { ethers } from "ethers";
import { config } from "../relayer/config";
import {
  generateNullifier,
  formatUSDC,
} from "../lib/note_generator";
import * as fs from "fs";
import * as path from "path";

/**
 * E2E Unshield Test
 *
 * Tests the unshield flow (Hub → Client):
 * 1. Load a shielded note from the hub pool
 * 2. Call SimpleShieldAdapter.unshieldToBridge()
 * 3. This burns on hub MockUSDC, emits BurnForDeposit
 * 4. Relayer picks up and calls receiveMessage on client
 * 5. User receives USDC on client chain
 *
 * Prerequisites:
 * - Run e2e_shield.ts (or e2e_transfer.ts) to have a note to unshield
 * - Both chains and relayer running
 */

// ============ ABIs ============

const SIMPLE_SHIELD_ADAPTER_ABI = [
  "function unshieldToBridge(bytes32 nullifier, uint256 amount, uint32 destinationChainId, address destinationAddress) external",
  "function nullifiers(bytes32) view returns (bool)",
  "function getCommitmentCount() view returns (uint256)",
  "event Unshield(address indexed recipient, uint256 amount, bytes32 nullifier)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

// ============ Load Data ============

function loadDeployments(): { client: any; hub: any } {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const clientPath = path.join(deploymentsDir, "client.json");
  const hubPath = path.join(deploymentsDir, "hub.json");

  if (!fs.existsSync(clientPath) || !fs.existsSync(hubPath)) {
    throw new Error("Deployments not found. Run 'npm run deploy:all' first.");
  }

  return {
    client: JSON.parse(fs.readFileSync(clientPath, "utf-8")),
    hub: JSON.parse(fs.readFileSync(hubPath, "utf-8")),
  };
}

function loadNoteToUnshield(): {
  commitment: string;
  randomness: string;
  amount: string;
  recipient: string;
  commitmentIndex: number;
} {
  const notesDir = path.join(__dirname, "../notes");

  // Try to load transfer output first (user2's note from transfer test)
  const transferNotePath = path.join(notesDir, "transfer_output_user2.json");
  if (fs.existsSync(transferNotePath)) {
    console.log("Using note from transfer test (user2's output)");
    return JSON.parse(fs.readFileSync(transferNotePath, "utf-8"));
  }

  // Fall back to original shielded note
  const shieldNotePath = path.join(notesDir, "shielded_note.json");
  if (fs.existsSync(shieldNotePath)) {
    console.log("Using original shielded note");
    return JSON.parse(fs.readFileSync(shieldNotePath, "utf-8"));
  }

  throw new Error(
    "No note found to unshield. Run 'npm run test:shield' first."
  );
}

// ============ Test ============

async function main() {
  console.log(`
${"=".repeat(60)}
  E2E UNSHIELD TEST
${"=".repeat(60)}
`);

  // Load deployments and note
  const deployments = loadDeployments();
  const noteToUnshield = loadNoteToUnshield();

  console.log("\nNote to unshield:");
  console.log(`  Commitment: ${noteToUnshield.commitment}`);
  console.log(`  Amount: ${formatUSDC(BigInt(noteToUnshield.amount))} USDC`);
  console.log(`  Original recipient: ${noteToUnshield.recipient}`);

  // Setup providers and wallets
  const clientProvider = new ethers.JsonRpcProvider(config.clientChain.rpc);
  const hubProvider = new ethers.JsonRpcProvider(config.hubChain.rpc);

  // Operator on hub (to call unshield)
  const operator = new ethers.Wallet(
    config.accounts.deployer.privateKey,
    hubProvider
  );

  // Recipient on client chain (where funds will be sent)
  // Use user2 as the unshield recipient
  const recipientAddress = config.accounts.user2.address;
  console.log(`\nUnshield recipient (client chain): ${recipientAddress}`);

  // Connect to contracts
  const shieldAdapter = new ethers.Contract(
    deployments.hub.contracts.shieldAdapter,
    SIMPLE_SHIELD_ADAPTER_ABI,
    operator
  );

  const clientUSDC = new ethers.Contract(
    deployments.client.contracts.mockUSDC,
    ERC20_ABI,
    clientProvider
  );

  // ============ Check Initial State ============

  console.log("\n--- Initial State ---");

  const nullifier = generateNullifier(
    noteToUnshield.commitment,
    noteToUnshield.randomness
  );
  console.log(`Nullifier: ${nullifier}`);

  const nullifierAlreadySpent = await shieldAdapter.nullifiers(nullifier);
  if (nullifierAlreadySpent) {
    console.error("ERROR: Nullifier already spent! Cannot unshield.");
    console.error("This note may have already been used in a transfer or unshield.");
    process.exit(1);
  }
  console.log("Nullifier not yet spent: ✓");

  const initialClientBalance: bigint = await clientUSDC.balanceOf(recipientAddress);
  console.log(`Recipient client USDC balance: ${formatUSDC(initialClientBalance)} USDC`);

  // ============ Prepare Unshield ============

  const unshieldAmount = BigInt(noteToUnshield.amount);
  const destinationChainId = config.clientChain.chainId;

  console.log(`\n--- Preparing Unshield ---`);
  console.log(`Amount: ${formatUSDC(unshieldAmount)} USDC`);
  console.log(`Destination chain: ${destinationChainId} (client)`);
  console.log(`Recipient: ${recipientAddress}`);

  // ============ Execute Unshield ============

  console.log("\n--- Executing Unshield ---");

  const tx = await shieldAdapter.unshieldToBridge(
    nullifier,
    unshieldAmount,
    destinationChainId,
    recipientAddress
  );

  console.log(`Unshield tx (hub): ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block: ${receipt?.blockNumber}`);

  // ============ Wait for Relayer ============

  console.log("\n--- Waiting for relayer to bridge to client ---");
  console.log("  (Relayer should pick up BurnForDeposit from hub and call client)");

  const maxWaitTime = 30000;
  const pollInterval = 2000;
  const startTime = Date.now();
  let bridged = false;

  while (Date.now() - startTime < maxWaitTime) {
    const currentBalance = await clientUSDC.balanceOf(recipientAddress);

    if (currentBalance > initialClientBalance) {
      bridged = true;
      console.log(`\n  Funds arrived on client chain!`);
      console.log(`  New balance: ${formatUSDC(currentBalance)} USDC`);
      break;
    }

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  if (!bridged) {
    console.error("\n  ERROR: Funds not received on client after 30 seconds");
    console.error("  Make sure the relayer is running (npm run relay)");
    process.exit(1);
  }

  // ============ Verify State ============

  console.log("\n--- Final State ---");

  // Check nullifier is spent
  const nullifierNowSpent = await shieldAdapter.nullifiers(nullifier);
  console.log(`Nullifier spent on hub: ${nullifierNowSpent ? "✓" : "✗"}`);

  if (!nullifierNowSpent) {
    console.error("ERROR: Nullifier should be spent!");
    process.exit(1);
  }

  // Check client balance
  const finalClientBalance: bigint = await clientUSDC.balanceOf(recipientAddress);
  const received = BigInt(finalClientBalance) - BigInt(initialClientBalance);
  console.log(`Client USDC received: ${formatUSDC(received)} USDC`);

  if (received !== unshieldAmount) {
    console.error(`ERROR: Expected ${formatUSDC(unshieldAmount)}, got ${formatUSDC(received)}`);
    process.exit(1);
  }

  // ============ Summary ============

  console.log(`
${"=".repeat(60)}
  UNSHIELD TEST PASSED!
${"=".repeat(60)}

Summary:
  - Unshielded: ${formatUSDC(unshieldAmount)} USDC
  - From hub commitment: ${noteToUnshield.commitment}
  - Nullifier: ${nullifier} (now spent)
  - Bridged to client chain ID: ${destinationChainId}
  - Recipient: ${recipientAddress}
  - Client balance increased by: ${formatUSDC(received)} USDC

The full cycle is complete:
  1. Shield: User deposited USDC on client → shielded on hub
  2. Transfer: Private transfer within hub pool (optional)
  3. Unshield: Withdrew from hub → received USDC on client

This demonstrates the hub-based MASP architecture working end-to-end!
`);

  // Clean up used note file
  const usedNotePath = path.join(__dirname, "../notes/transfer_output_user2.json");
  if (fs.existsSync(usedNotePath)) {
    fs.unlinkSync(usedNotePath);
    console.log("Cleaned up used note file");
  }
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
