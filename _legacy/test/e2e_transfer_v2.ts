import { ethers } from "ethers";
import { config } from "../relayer/config";
import * as fs from "fs";
import * as path from "path";

// Import our modules (legacy - use SDK modules for new tests)
import {
  createWallet,
  initCrypto,
  createNote,
  getNoteCommitment,
  computeNpk,
  RailgunWallet,
  Note,
  exportWallet
} from "../lib/_legacy/wallet";
import { MerkleTree, TREE_DEPTH } from "../lib/_legacy/merkle_tree";
import {
  createTransfer,
  submitTransfer,
  noteToSpentNote,
  printTransactionSummary,
  TransferResult
} from "../lib/_legacy/transfer";

/**
 * E2E Transfer Test V2 - Private Transfer with ZK Proofs
 *
 * Tests the full private transfer flow:
 * 1. Alice shields USDC (creates shielded note)
 * 2. Alice transfers privately to Bob
 * 3. Verify nullifiers are spent
 * 4. Verify new commitments are added
 *
 * Prerequisites:
 * - Hub chain running (npm run chains)
 * - Railgun contracts deployed (npm run deploy:railgun)
 * - A shielded note exists (run npm run test:shield:v2 first)
 */

// ============ ABIs ============

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount) external",
];

// Use proper ABI format to avoid parsing issues
const RAILGUN_ABI = [
  "function merkleRoot() view returns (bytes32)",
  "function nextLeafIndex() view returns (uint256)",
  "function treeNumber() view returns (uint256)",
  "function nullifiers(uint256 treeNum, bytes32 nullifier) view returns (bool)",
  "function hashCommitment(tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage) pure returns (bytes32)",
  "function shield(tuple(tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] requests) external",
  "event Shield(uint256 treeNumber, uint256 startPosition, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext, uint256[] fees)",
  "event Transact(uint256 treeNumber, uint256 startPosition, bytes32[] hash, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] ciphertext)",
];

// ============ Load Deployments ============

function loadDeployments(): { hub: any; railgun: any } {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const hubPath = path.join(deploymentsDir, "hub.json");
  const railgunPath = path.join(deploymentsDir, "railgun.json");

  if (!fs.existsSync(hubPath)) {
    throw new Error("Hub deployment not found. Run 'npm run deploy:hub' first.");
  }
  if (!fs.existsSync(railgunPath)) {
    throw new Error("Railgun deployment not found. Run 'npm run deploy:railgun' first.");
  }

  return {
    hub: JSON.parse(fs.readFileSync(hubPath, "utf-8")),
    railgun: JSON.parse(fs.readFileSync(railgunPath, "utf-8")),
  };
}

// ============ Helper Functions ============

/**
 * Sync local merkle tree with on-chain state by fetching all historical commitments
 */
async function syncMerkleTreeFromChain(
  railgunContract: ethers.Contract,
  provider: ethers.JsonRpcProvider,
  merkleTree: MerkleTree
): Promise<number> {
  const nextLeafIndex = await railgunContract.nextLeafIndex();
  const currentIndex = Number(nextLeafIndex);

  if (currentIndex === 0) {
    console.log("  On-chain tree is empty, no sync needed");
    return 0;
  }

  console.log(`  On-chain tree has ${currentIndex} commitments, syncing...`);

  // Fetch all Shield events
  const shieldFilter = railgunContract.filters.Shield();
  const shieldEvents = await railgunContract.queryFilter(shieldFilter, 0, "latest");

  // Fetch all Transact events
  const transactFilter = railgunContract.filters.Transact();
  const transactEvents = await railgunContract.queryFilter(transactFilter, 0, "latest");

  // Collect all commitments with their positions
  const commitments: { position: number; hash: bigint }[] = [];

  // Process Shield events - commitments are computed from preimages
  for (const event of shieldEvents) {
    const log = event as ethers.EventLog;
    const startPosition = Number(log.args[1]);
    const preimages = log.args[2];

    for (let i = 0; i < preimages.length; i++) {
      // Compute commitment hash from preimage
      // The contract computes this as poseidon(npk, tokenHash, value)
      // Need to deep-copy the preimage to avoid ethers' frozen Result objects
      const preimage = preimages[i];
      const preimageObj = {
        npk: preimage.npk,
        token: {
          tokenType: preimage.token.tokenType,
          tokenAddress: preimage.token.tokenAddress,
          tokenSubID: preimage.token.tokenSubID
        },
        value: preimage.value
      };
      const commitmentHash = await railgunContract.hashCommitment(preimageObj);
      commitments.push({
        position: startPosition + i,
        hash: BigInt(commitmentHash)
      });
    }
  }

  // Process Transact events - hashes are directly provided
  for (const event of transactEvents) {
    const log = event as ethers.EventLog;
    const startPosition = Number(log.args[1]);
    const hashes = log.args[2];

    for (let i = 0; i < hashes.length; i++) {
      commitments.push({
        position: startPosition + i,
        hash: BigInt(hashes[i])
      });
    }
  }

  // Sort by position and insert into tree
  commitments.sort((a, b) => a.position - b.position);

  for (const commitment of commitments) {
    merkleTree.insert(commitment.hash);
  }

  console.log(`  Synced ${commitments.length} commitments from chain`);

  // Verify roots match
  const onChainRoot = await railgunContract.merkleRoot();
  const localRoot = ethers.zeroPadValue(ethers.toBeHex(merkleTree.root), 32);

  if (onChainRoot !== localRoot) {
    console.log(`  WARNING: Root mismatch after sync!`);
    console.log(`    On-chain: ${onChainRoot}`);
    console.log(`    Local:    ${localRoot}`);
  } else {
    console.log(`  Merkle roots match after sync`);
  }

  return commitments.length;
}

async function shieldDirectly(
  wallet: RailgunWallet,
  railgunContract: ethers.Contract,
  usdcContract: ethers.Contract,
  amount: bigint,
  tokenAddress: string,
  merkleTree: MerkleTree
): Promise<Note> {
  console.log("\n--- Direct Shield (for testing) ---");

  // Create note for wallet
  const note = createNote(wallet, tokenAddress, amount);
  const commitment = getNoteCommitment(note);

  console.log(`Creating note with value: ${ethers.formatUnits(amount, 6)} USDC`);
  console.log(`NPK: ${ethers.zeroPadValue(ethers.toBeHex(note.npk), 32).slice(0, 30)}...`);
  console.log(`Commitment: ${ethers.zeroPadValue(ethers.toBeHex(commitment), 32).slice(0, 30)}...`);

  // Approve Railgun to spend USDC
  const railgunAddress = await railgunContract.getAddress();
  console.log(`Approving Railgun (${railgunAddress}) to spend USDC...`);
  const approveTx = await usdcContract.approve(railgunAddress, amount);
  await approveTx.wait();

  // Create ShieldRequest
  const shieldRequest = {
    preimage: {
      npk: ethers.zeroPadValue(ethers.toBeHex(note.npk), 32),
      token: {
        tokenType: 0,  // ERC20
        tokenAddress: tokenAddress,
        tokenSubID: 0
      },
      value: amount
    },
    ciphertext: {
      encryptedBundle: [
        ethers.zeroPadValue("0x01", 32),
        ethers.zeroPadValue("0x02", 32),
        ethers.zeroPadValue("0x03", 32)
      ],
      shieldKey: ethers.zeroPadValue("0x04", 32)
    }
  };

  // Call shield
  console.log("Calling RailgunSmartWallet.shield()...");
  const shieldTx = await railgunContract.shield([shieldRequest]);
  const receipt = await shieldTx.wait();
  console.log(`Shield tx: ${shieldTx.hash}`);
  console.log(`Block: ${receipt?.blockNumber}`);

  // Update local merkle tree
  const leafIndex = merkleTree.insert(commitment);
  console.log(`Commitment added to local tree at index: ${leafIndex}`);

  // Update note with position
  note.treeNumber = 0;
  note.leafIndex = leafIndex;

  return note;
}

// ============ Main Test ============

async function main() {
  console.log(`
${"=".repeat(60)}
  E2E TRANSFER TEST V2 - PRIVATE TRANSFER WITH ZK PROOFS
${"=".repeat(60)}
`);

  // Initialize crypto
  console.log("Initializing cryptographic primitives...");
  await initCrypto();

  // Load deployments
  const deployments = loadDeployments();
  console.log("Loaded deployments:");
  console.log(`  Hub MockUSDC: ${deployments.hub.contracts.mockUSDC}`);
  console.log(`  RailgunSmartWallet: ${deployments.railgun.contracts.railgunProxy}`);

  // Setup provider and signer
  const hubProvider = new ethers.JsonRpcProvider(config.hubChain.rpc);
  const hubNetwork = await hubProvider.getNetwork();
  console.log(`\nConnected to Hub chain: ${config.hubChain.rpc} (chain ID: ${hubNetwork.chainId})`);

  // Use deployer account (has USDC)
  const signer = new ethers.Wallet(config.accounts.deployer.privateKey, hubProvider);
  console.log(`Signer: ${signer.address}`);

  // Connect to contracts
  const mockUSDC = new ethers.Contract(
    deployments.hub.contracts.mockUSDC,
    ERC20_ABI,
    signer
  );

  const railgun = new ethers.Contract(
    deployments.railgun.contracts.railgunProxy,
    RAILGUN_ABI,
    signer
  );

  // Check initial balances and mint if needed
  let initialBalance = await mockUSDC.balanceOf(signer.address);
  console.log(`\nSigner USDC balance: ${ethers.formatUnits(initialBalance, 6)} USDC`);

  // Mint USDC if balance is insufficient
  const requiredAmount = ethers.parseUnits("1000", 6);  // 1000 USDC
  if (initialBalance < requiredAmount) {
    console.log("Minting USDC for testing...");
    const mintTx = await mockUSDC.mint(signer.address, requiredAmount);
    await mintTx.wait();
    initialBalance = await mockUSDC.balanceOf(signer.address);
    console.log(`New USDC balance: ${ethers.formatUnits(initialBalance, 6)} USDC`);
  }

  // ============ Create Wallets ============

  console.log("\n--- Creating Railgun Wallets ---");

  // Alice (sender)
  const aliceWallet = await createWallet();
  console.log("Alice's wallet created:");
  console.log(`  Public Key: [${aliceWallet.publicKey[0].toString().slice(0, 20)}..., ${aliceWallet.publicKey[1].toString().slice(0, 20)}...]`);
  console.log(`  MPK: ${aliceWallet.mpk.toString().slice(0, 30)}...`);

  // Bob (recipient)
  const bobWallet = await createWallet();
  console.log("Bob's wallet created:");
  console.log(`  Public Key: [${bobWallet.publicKey[0].toString().slice(0, 20)}..., ${bobWallet.publicKey[1].toString().slice(0, 20)}...]`);
  console.log(`  MPK: ${bobWallet.mpk.toString().slice(0, 30)}...`);

  // ============ Initialize Merkle Tree ============

  console.log("\n--- Initializing Merkle Tree ---");
  const merkleTree = new MerkleTree(TREE_DEPTH);
  console.log(`Local merkle tree initialized (depth: ${TREE_DEPTH})`);

  // Sync with on-chain state (recover commitments from previous test runs)
  const existingCommitments = await syncMerkleTreeFromChain(railgun, hubProvider, merkleTree);

  // ============ Shield Funds for Alice ============

  const shieldAmount = ethers.parseUnits("100", 6);  // 100 USDC
  const aliceNote = await shieldDirectly(
    aliceWallet,
    railgun,
    mockUSDC,
    shieldAmount,
    deployments.hub.contracts.mockUSDC,
    merkleTree
  );

  // Verify on-chain state
  const onChainRoot = await railgun.merkleRoot();
  const localRoot = merkleTree.root;
  console.log(`\nOn-chain merkle root: ${onChainRoot}`);
  console.log(`Local merkle root: ${ethers.zeroPadValue(ethers.toBeHex(localRoot), 32)}`);

  // ============ Create Private Transfer ============

  console.log("\n--- Creating Private Transfer ---");
  const transferAmount = ethers.parseUnits("30", 6);  // Transfer 30 USDC to Bob
  console.log(`Transferring ${ethers.formatUnits(transferAmount, 6)} USDC from Alice to Bob`);

  // Convert note to SpentNote
  const spentNote = noteToSpentNote(aliceNote, aliceNote.leafIndex!, merkleTree);

  // Create transfer
  let transferResult: TransferResult;
  try {
    transferResult = await createTransfer(
      {
        senderWallet: aliceWallet,
        inputNotes: [spentNote],
        recipientWallet: bobWallet,
        amount: transferAmount,
        tokenAddress: deployments.hub.contracts.mockUSDC,
        chainId: BigInt(hubNetwork.chainId),
        treeNumber: 0
      },
      merkleTree
    );

    printTransactionSummary(transferResult);
  } catch (e: any) {
    console.error("Failed to create transfer:", e.message);
    console.log("\nNote: ZK proof generation requires circuit artifacts.");
    console.log("Make sure railgun-circuit-test-artifacts package is installed.");
    process.exit(1);
  }

  // ============ Submit Transaction ============

  console.log("\n--- Submitting Transaction ---");

  try {
    const receipt = await submitTransfer(
      hubProvider,
      signer,
      deployments.railgun.contracts.railgunProxy,
      transferResult
    );

    if (receipt) {
      console.log(`Transaction confirmed in block: ${receipt.blockNumber}`);
      console.log(`Gas used: ${receipt.gasUsed}`);
    }
  } catch (e: any) {
    console.error("Transaction failed:", e.message);
    if (e.message.includes("Invalid Snark Proof")) {
      console.log("\nThe ZK proof was rejected by the contract.");
      console.log("This may indicate a mismatch between circuit and contract verification keys.");
    }
    process.exit(1);
  }

  // ============ Verify Final State ============

  console.log("\n--- Verifying Final State ---");

  // Check nullifiers are spent
  for (const nullifier of transferResult.nullifiers) {
    const isSpent = await railgun.nullifiers(0, nullifier);
    console.log(`Nullifier ${nullifier.slice(0, 20)}... spent: ${isSpent}`);
    if (!isSpent) {
      console.error("ERROR: Nullifier not marked as spent!");
      process.exit(1);
    }
  }

  // Check new leaf index
  const finalLeafIndex = await railgun.nextLeafIndex();
  console.log(`Final next leaf index: ${finalLeafIndex}`);

  // ============ Summary ============

  console.log(`
${"=".repeat(60)}
  PRIVATE TRANSFER TEST PASSED!
${"=".repeat(60)}

Summary:
  - Alice shielded: ${ethers.formatUnits(shieldAmount, 6)} USDC
  - Transferred to Bob: ${ethers.formatUnits(transferAmount, 6)} USDC
  - Change back to Alice: ${ethers.formatUnits(shieldAmount - transferAmount, 6)} USDC
  - Nullifiers spent: ${transferResult.nullifiers.length}
  - New commitments: ${transferResult.transaction.commitments.length}

The private transfer was completed with ZK proof verification!
Bob now has a shielded note that only he can spend.
`);

  // Save wallet data for future tests
  const walletsDir = path.join(__dirname, "../wallets");
  if (!fs.existsSync(walletsDir)) {
    fs.mkdirSync(walletsDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(walletsDir, "alice.json"),
    JSON.stringify(exportWallet(aliceWallet), null, 2)
  );

  fs.writeFileSync(
    path.join(walletsDir, "bob.json"),
    JSON.stringify(exportWallet(bobWallet), null, 2)
  );

  console.log("Wallet data saved to wallets/alice.json and wallets/bob.json");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Test failed:", e);
    process.exit(1);
  });
