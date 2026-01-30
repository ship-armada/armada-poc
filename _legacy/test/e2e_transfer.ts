import { ethers } from "ethers";
import { config } from "../relayer/config";
import {
  generateCommitment,
  generateNullifier,
  formatUSDC,
  parseUSDC,
  encodeShieldPayload,
} from "../lib/note_generator";
import { generateTransferProof } from "../lib/proof_helper";
import * as fs from "fs";
import * as path from "path";

/**
 * E2E Transfer Test
 *
 * Tests private transfer within the shielded pool:
 * 1. Load a previously shielded note
 * 2. Generate a transfer proof spending that note
 * 3. Create new output commitment(s) for recipient(s)
 * 4. Call SimpleShieldAdapter.transfer()
 * 5. Verify old nullifier is spent, new commitments exist
 *
 * Prerequisites:
 * - Run e2e_shield.ts first to create a shielded note
 * - Hub chain running
 */

// ============ ABIs ============

const SIMPLE_SHIELD_ADAPTER_ABI = [
  "function transfer(bytes32[] calldata inputNullifiers, bytes32[] calldata outputCommitments, bytes[] calldata encryptedNotes, bytes calldata proof) external",
  "function commitments(uint256) view returns (bytes32)",
  "function getCommitmentCount() view returns (uint256)",
  "function getCommitment(uint256 index) view returns (bytes32)",
  "function commitmentExists(bytes32) view returns (bool)",
  "function nullifiers(bytes32) view returns (bool)",
  "event CommitmentInserted(uint256 indexed index, bytes32 indexed commitment, uint256 amount, bytes encryptedNote)",
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

function loadShieldedNote(): {
  commitment: string;
  randomness: string;
  amount: string;
  recipient: string;
  commitmentIndex: number;
} {
  const notePath = path.join(__dirname, "../notes/shielded_note.json");

  if (!fs.existsSync(notePath)) {
    throw new Error(
      "Shielded note not found. Run 'npm run test:shield' first."
    );
  }

  return JSON.parse(fs.readFileSync(notePath, "utf-8"));
}

// ============ Test ============

async function main() {
  console.log(`
${"=".repeat(60)}
  E2E TRANSFER TEST
${"=".repeat(60)}
`);

  // Load deployments and note
  const deployments = loadDeployments();
  const inputNote = loadShieldedNote();

  console.log("Loaded shielded note:");
  console.log(`  Commitment: ${inputNote.commitment}`);
  console.log(`  Amount: ${formatUSDC(BigInt(inputNote.amount))} USDC`);
  console.log(`  Index: ${inputNote.commitmentIndex}`);

  // Setup provider and wallet
  const hubProvider = new ethers.JsonRpcProvider(config.hubChain.rpc);

  // Use deployer wallet (has permission to call transfer in POC)
  const operator = new ethers.Wallet(
    config.accounts.deployer.privateKey,
    hubProvider
  );
  console.log(`\nOperator: ${operator.address}`);

  // Connect to SimpleShieldAdapter
  const shieldAdapter = new ethers.Contract(
    deployments.hub.contracts.shieldAdapter,
    SIMPLE_SHIELD_ADAPTER_ABI,
    operator
  );

  // ============ Check Initial State ============

  console.log("\n--- Initial State ---");

  const inputNullifier = generateNullifier(
    inputNote.commitment,
    inputNote.randomness
  );
  console.log(`Input nullifier: ${inputNullifier}`);

  const nullifierAlreadySpent = await shieldAdapter.nullifiers(inputNullifier);
  if (nullifierAlreadySpent) {
    console.error("ERROR: Nullifier already spent! Cannot transfer.");
    process.exit(1);
  }
  console.log("Nullifier not yet spent: ✓");

  const initialCommitmentCount = await shieldAdapter.getCommitmentCount();
  console.log(`Current commitment count: ${initialCommitmentCount}`);

  // ============ Prepare Transfer ============

  const inputAmount = BigInt(inputNote.amount);

  // Split into two outputs: 60 USDC to user2, 40 USDC back to user1 (change)
  const output1Amount = parseUSDC("60");
  const output2Amount = inputAmount - output1Amount; // Change

  console.log(`\n--- Preparing Transfer ---`);
  console.log(`Input: ${formatUSDC(inputAmount)} USDC`);
  console.log(`Output 1: ${formatUSDC(output1Amount)} USDC → User 2`);
  console.log(`Output 2: ${formatUSDC(output2Amount)} USDC → User 1 (change)`);

  // Generate output commitments
  const output1Note = generateCommitment(config.accounts.user2.address, output1Amount);
  const output2Note = generateCommitment(config.accounts.user1.address, output2Amount);

  console.log(`\nOutput commitments:`);
  console.log(`  1: ${output1Note.commitment}`);
  console.log(`  2: ${output2Note.commitment}`);

  // Generate mock proof
  const proof = generateTransferProof(
    [inputNullifier],
    [output1Note.commitment, output2Note.commitment],
    [inputAmount],
    [output1Amount, output2Amount]
  );

  // ============ Execute Transfer ============

  console.log("\n--- Executing Transfer ---");

  const tx = await shieldAdapter.transfer(
    [inputNullifier],
    [output1Note.commitment, output2Note.commitment],
    [output1Note.encryptedNote, output2Note.encryptedNote],
    proof.proof
  );

  console.log(`Transfer tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block: ${receipt?.blockNumber}`);

  // ============ Verify State ============

  console.log("\n--- Final State ---");

  // Check nullifier is now spent
  const nullifierNowSpent = await shieldAdapter.nullifiers(inputNullifier);
  console.log(`Nullifier spent: ${nullifierNowSpent ? "✓" : "✗"}`);

  if (!nullifierNowSpent) {
    console.error("ERROR: Nullifier should be spent!");
    process.exit(1);
  }

  // Check new commitments exist
  const finalCommitmentCount = await shieldAdapter.getCommitmentCount();
  console.log(`Commitment count: ${initialCommitmentCount} → ${finalCommitmentCount}`);

  // Verify output commitments exist
  const output1Exists = await shieldAdapter.commitmentExists(output1Note.commitment);
  const output2Exists = await shieldAdapter.commitmentExists(output2Note.commitment);

  if (!output1Exists || !output2Exists) {
    console.error("ERROR: Output commitments not found!");
    process.exit(1);
  }

  // The new commitments should be at the end
  const output1Index = Number(finalCommitmentCount) - 2;
  const output2Index = Number(finalCommitmentCount) - 1;

  console.log(`Output 1 commitment index: ${output1Index}`);
  console.log(`Output 2 commitment index: ${output2Index}`);

  // ============ Summary ============

  console.log(`
${"=".repeat(60)}
  TRANSFER TEST PASSED!
${"=".repeat(60)}

Summary:
  Input:
    - Commitment: ${inputNote.commitment}
    - Nullifier: ${inputNullifier} (now spent)
    - Amount: ${formatUSDC(inputAmount)} USDC

  Outputs:
    1. ${formatUSDC(output1Amount)} USDC → User 2
       Commitment: ${output1Note.commitment}
       Index: ${output1Index}

    2. ${formatUSDC(output2Amount)} USDC → User 1 (change)
       Commitment: ${output2Note.commitment}
       Index: ${output2Index}

The transfer was completed privately within the shielded pool.
No external observer can link the input to the outputs.
`);

  // Save output notes for use in unshield test
  const notesDir = path.join(__dirname, "../notes");

  // Save user2's note (for potential unshield test)
  const user2Note = {
    commitment: output1Note.commitment,
    randomness: output1Note.randomness,
    amount: output1Amount.toString(),
    recipient: config.accounts.user2.address,
    commitmentIndex: output1Index,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(notesDir, "transfer_output_user2.json"),
    JSON.stringify(user2Note, null, 2)
  );

  // Save user1's change note
  const user1ChangeNote = {
    commitment: output2Note.commitment,
    randomness: output2Note.randomness,
    amount: output2Amount.toString(),
    recipient: config.accounts.user1.address,
    commitmentIndex: output2Index,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(notesDir, "transfer_output_user1_change.json"),
    JSON.stringify(user1ChangeNote, null, 2)
  );

  console.log("Output notes saved to notes/ directory");
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
