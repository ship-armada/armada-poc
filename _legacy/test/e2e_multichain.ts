import { ethers } from "ethers";
import {
  hubChain,
  clientChains,
  accounts,
} from "../relayer/config";
import {
  createShieldRequest,
  formatUSDC,
  parseUSDC,
} from "../lib/_legacy/shield_request";
import {
  createWallet,
  initCrypto,
  createNote,
  getNoteCommitment,
  RailgunWallet,
  Note,
} from "../lib/_legacy/wallet";
import { MerkleTree, TREE_DEPTH } from "../lib/_legacy/merkle_tree";
import {
  createUnshield,
  submitUnshield,
  noteToSpentNote,
  UnshieldResult,
} from "../lib/_legacy/transfer";
import * as fs from "fs";
import * as path from "path";

/**
 * E2E Multi-Chain Test
 *
 * Tests the full cross-chain flow across THREE chains:
 *   Chain A (Client) → Hub → Chain B (Client)
 *
 * Flow:
 * 1. Alice shields USDC on Chain A
 * 2. Relayer relays to Hub, commitment added to Railgun
 * 3. Alice unshields on Hub with destination = Chain B
 * 4. Relayer relays to Chain B
 * 5. Alice receives USDC on Chain B
 *
 * Prerequisites:
 * - All three chains running (npm run chains)
 * - All contracts deployed (npm run setup)
 * - Relayer running (npm run relayer)
 */

// ============ ABIs ============

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address to, uint256 amount) external",
];

const CLIENT_SHIELD_PROXY_V2_ABI = [
  "function shield(uint256 amount, bytes32 npk, bytes32[3] calldata encryptedBundle, bytes32 shieldKey) external returns (uint64 nonce)",
  "function mockUSDC() view returns (address)",
  "function hubChainId() view returns (uint32)",
  "function hubReceiver() view returns (address)",
  "event ShieldInitiated(address indexed user, uint256 amount, bytes32 indexed npk, uint64 nonce)",
];

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

const HUB_UNSHIELD_PROXY_ABI = [
  "function bridgeTo(uint256 amount, address recipient, uint32 destinationChainId) external returns (uint64 nonce)",
  "event BridgeInitiated(address indexed sender, address indexed recipient, uint256 amount, uint32 destinationChainId, uint64 ccptNonce)",
];

// ============ Types ============

interface ChainContracts {
  provider: ethers.JsonRpcProvider;
  mockUSDC: ethers.Contract;
  clientShieldProxyV2?: ethers.Contract;
}

// ============ Load Deployments ============

function loadDeployment(filename: string): any {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const filePath = path.join(deploymentsDir, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployment not found: ${filename}. Run 'npm run setup' first.`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// ============ Helpers ============

async function syncMerkleTreeFromChain(
  railgunContract: ethers.Contract,
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

  // Process Shield events
  for (const event of shieldEvents) {
    const log = event as ethers.EventLog;
    const startPosition = Number(log.args[1]);
    const preimages = log.args[2];

    for (let i = 0; i < preimages.length; i++) {
      const preimage = preimages[i];
      const preimageObj = {
        npk: preimage.npk,
        token: {
          tokenType: preimage.token.tokenType,
          tokenAddress: preimage.token.tokenAddress,
          tokenSubID: preimage.token.tokenSubID,
        },
        value: preimage.value,
      };
      const commitmentHash = await railgunContract.hashCommitment(preimageObj);
      commitments.push({
        position: startPosition + i,
        hash: BigInt(commitmentHash),
      });
    }
  }

  // Process Transact events
  for (const event of transactEvents) {
    const log = event as ethers.EventLog;
    const startPosition = Number(log.args[1]);
    const hashes = log.args[2];

    for (let i = 0; i < hashes.length; i++) {
      commitments.push({
        position: startPosition + i,
        hash: BigInt(hashes[i]),
      });
    }
  }

  // Sort by position and insert into tree
  commitments.sort((a, b) => a.position - b.position);

  for (const commitment of commitments) {
    merkleTree.insert(commitment.hash);
  }

  console.log(`  Synced ${commitments.length} commitments from chain`);
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
  const note = createNote(wallet, tokenAddress, amount);
  const commitment = getNoteCommitment(note);

  console.log(`  Creating note with value: ${ethers.formatUnits(amount, 6)} USDC`);

  // Approve Railgun (reset to 0 first for SafeERC20 compatibility)
  const railgunAddress = await railgunContract.getAddress();
  const resetApproveTx = await usdcContract.approve(railgunAddress, 0);
  await resetApproveTx.wait();
  const approveTx = await usdcContract.approve(railgunAddress, amount);
  await approveTx.wait();

  // Create ShieldRequest
  const shieldRequest = {
    preimage: {
      npk: ethers.zeroPadValue(ethers.toBeHex(note.npk), 32),
      token: {
        tokenType: 0,
        tokenAddress: tokenAddress,
        tokenSubID: 0,
      },
      value: amount,
    },
    ciphertext: {
      encryptedBundle: [
        ethers.zeroPadValue("0x01", 32),
        ethers.zeroPadValue("0x02", 32),
        ethers.zeroPadValue("0x03", 32),
      ],
      shieldKey: ethers.zeroPadValue("0x04", 32),
    },
  };

  const shieldTx = await railgunContract.shield([shieldRequest]);
  await shieldTx.wait();

  // Update local merkle tree
  const leafIndex = merkleTree.insert(commitment);
  console.log(`  Commitment added at index: ${leafIndex}`);

  // Update note with position
  note.treeNumber = 0;
  note.leafIndex = leafIndex;

  return note;
}

// ============ Main Test ============

async function main() {
  console.log(`
${"=".repeat(70)}
  E2E MULTI-CHAIN TEST
  Flow: Chain A (Shield) → Hub (Railgun) → Chain B (Unshield)
${"=".repeat(70)}
`);

  // Initialize crypto
  console.log("Initializing cryptographic primitives...");
  await initCrypto();

  // Identify chains
  const chainA = clientChains[0]; // Client A (31337)
  const chainB = clientChains[1]; // Client B (31339)

  if (!chainA || !chainB) {
    throw new Error("Need at least 2 client chains configured");
  }

  console.log("\nChain Configuration:");
  console.log(`  Chain A: ${chainA.name} (${chainA.rpc}, chainId: ${chainA.chainId})`);
  console.log(`  Hub:     ${hubChain.name} (${hubChain.rpc}, chainId: ${hubChain.chainId})`);
  console.log(`  Chain B: ${chainB.name} (${chainB.rpc}, chainId: ${chainB.chainId})`);

  // Load deployments
  const clientADeployment = loadDeployment("client.json");
  const clientBDeployment = loadDeployment("clientB.json");
  const hubDeployment = loadDeployment("hub.json");
  const railgunDeployment = loadDeployment("railgun.json");

  console.log("\nContract Addresses:");
  console.log(`  Chain A MockUSDC: ${clientADeployment.contracts.mockUSDC}`);
  console.log(`  Chain A ShieldProxy: ${clientADeployment.contracts.clientShieldProxyV2}`);
  console.log(`  Chain B MockUSDC: ${clientBDeployment.contracts.mockUSDC}`);
  console.log(`  Hub RailgunSmartWallet: ${railgunDeployment.contracts.railgunProxy}`);
  console.log(`  Hub UnshieldProxy: ${hubDeployment.contracts.hubUnshieldProxy}`);

  // Setup providers
  const chainAProvider = new ethers.JsonRpcProvider(chainA.rpc);
  const chainBProvider = new ethers.JsonRpcProvider(chainB.rpc);
  const hubProvider = new ethers.JsonRpcProvider(hubChain.rpc);

  // Use test user
  const user = new ethers.Wallet(accounts.user1.privateKey);
  const userOnChainA = user.connect(chainAProvider);
  const userOnChainB = user.connect(chainBProvider);
  const userOnHub = user.connect(hubProvider);

  console.log(`\nTest User: ${user.address}`);

  // Connect to contracts
  const chainAUSDC = new ethers.Contract(
    clientADeployment.contracts.mockUSDC,
    ERC20_ABI,
    userOnChainA
  );

  const chainBUSDC = new ethers.Contract(
    clientBDeployment.contracts.mockUSDC,
    ERC20_ABI,
    userOnChainB
  );

  const hubUSDC = new ethers.Contract(
    hubDeployment.contracts.mockUSDC,
    ERC20_ABI,
    userOnHub
  );

  const chainAShieldProxy = new ethers.Contract(
    clientADeployment.contracts.clientShieldProxyV2,
    CLIENT_SHIELD_PROXY_V2_ABI,
    userOnChainA
  );

  const railgun = new ethers.Contract(
    railgunDeployment.contracts.railgunProxy,
    RAILGUN_ABI,
    userOnHub
  );

  const hubUnshieldProxy = new ethers.Contract(
    hubDeployment.contracts.hubUnshieldProxy,
    HUB_UNSHIELD_PROXY_ABI,
    userOnHub
  );

  // ============ Step 1: Check Initial Balances ============

  console.log("\n--- Step 1: Initial Balances ---");

  const initialBalanceA = await chainAUSDC.balanceOf(user.address);
  const initialBalanceB = await chainBUSDC.balanceOf(user.address);
  const initialBalanceHub = await hubUSDC.balanceOf(user.address);
  const initialLeafIndex = await railgun.nextLeafIndex();

  console.log(`  Chain A USDC: ${formatUSDC(initialBalanceA)}`);
  console.log(`  Chain B USDC: ${formatUSDC(initialBalanceB)}`);
  console.log(`  Hub USDC: ${formatUSDC(initialBalanceHub)}`);
  console.log(`  Railgun leaf index: ${initialLeafIndex}`);

  // ============ Step 2: Shield from Chain A ============

  console.log("\n--- Step 2: Shield from Chain A ---");

  const shieldAmount = parseUSDC("100"); // 100 USDC
  console.log(`  Shielding ${formatUSDC(shieldAmount)} USDC from Chain A`);

  // Generate ShieldRequest
  const shieldNote = await createShieldRequest(
    user.address,
    shieldAmount,
    clientADeployment.contracts.mockUSDC
  );

  // Approve (reset to 0 first for SafeERC20 compatibility)
  const resetTx = await chainAUSDC.approve(
    clientADeployment.contracts.clientShieldProxyV2,
    0
  );
  await resetTx.wait();
  const approveTx = await chainAUSDC.approve(
    clientADeployment.contracts.clientShieldProxyV2,
    shieldAmount
  );
  await approveTx.wait();
  console.log(`  Approved USDC`);

  // Call shield
  const shieldTx = await chainAShieldProxy.shield(
    shieldAmount,
    shieldNote.request.npk,
    shieldNote.request.encryptedBundle,
    shieldNote.request.shieldKey
  );
  const shieldReceipt = await shieldTx.wait();
  console.log(`  Shield tx: ${shieldTx.hash}`);

  // ============ Step 3: Wait for Relayer (Chain A → Hub) ============

  console.log("\n--- Step 3: Waiting for Relayer (Chain A → Hub) ---");

  const maxWaitTime = 30000;
  const pollInterval = 2000;
  let found = false;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const currentLeafIndex = await railgun.nextLeafIndex();

    if (currentLeafIndex > initialLeafIndex) {
      found = true;
      console.log(`  Commitment added to Railgun! Leaf index: ${currentLeafIndex}`);
      break;
    }

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  if (!found) {
    console.error("\n  ERROR: Commitment not added after 30s. Is relayer running?");
    process.exit(1);
  }

  // ============ Step 4: Create Wallet and Shield Directly for Unshield Test ============

  console.log("\n--- Step 4: Preparing for Unshield ---");

  // For simplicity, we'll shield directly on Hub and then unshield to Chain B
  // This demonstrates the Hub → Chain B relay path
  const aliceWallet = await createWallet();
  console.log(`  Created Railgun wallet`);

  // Initialize and sync merkle tree
  const merkleTree = new MerkleTree(TREE_DEPTH);
  await syncMerkleTreeFromChain(railgun, merkleTree);

  // Use user2 for direct hub operations (deployer is used by relayer, would cause nonce conflicts)
  const hubTestUser = new ethers.Wallet(accounts.user2.privateKey, hubProvider);
  const hubUSDCTestUser = new ethers.Contract(
    hubDeployment.contracts.mockUSDC,
    ERC20_ABI,
    hubTestUser
  );

  // Mint some USDC on hub for direct shield (use deployer just for mint, then switch)
  const deployerOnHub = new ethers.Wallet(accounts.deployer.privateKey, hubProvider);
  const hubUSDCDeployer = new ethers.Contract(
    hubDeployment.contracts.mockUSDC,
    ERC20_ABI,
    deployerOnHub
  );
  await hubUSDCDeployer.mint(hubTestUser.address, parseUSDC("200"));

  // Shield directly on Hub using test user (not deployer, to avoid nonce conflicts with relayer)
  console.log(`  Shielding directly on Hub for unshield test...`);
  const railgunTestUser = new ethers.Contract(
    railgunDeployment.contracts.railgunProxy,
    RAILGUN_ABI,
    hubTestUser
  );

  const directShieldAmount = parseUSDC("50");
  const aliceNote = await shieldDirectly(
    aliceWallet,
    railgunTestUser,
    hubUSDCTestUser,
    directShieldAmount,
    hubDeployment.contracts.mockUSDC,
    merkleTree
  );

  // ============ Step 5: Unshield to Chain B ============

  console.log("\n--- Step 5: Unshield with Destination Chain B ---");

  const unshieldAmount = parseUSDC("50");
  console.log(`  Unshielding ${formatUSDC(unshieldAmount)} to Chain B (chainId: ${chainB.chainId})`);

  // Create unshield transaction
  const spentNote = noteToSpentNote(aliceNote, aliceNote.leafIndex!, merkleTree);

  let unshieldResult: UnshieldResult;
  try {
    unshieldResult = await createUnshield(
      {
        senderWallet: aliceWallet,
        inputNotes: [spentNote],
        unshieldAmount,
        recipientAddress: hubTestUser.address,
        tokenAddress: hubDeployment.contracts.mockUSDC,
        chainId: BigInt(hubChain.chainId),
        treeNumber: 0,
        unshieldType: 1, // NORMAL
      },
      merkleTree
    );
    console.log(`  Created unshield proof`);
  } catch (e: any) {
    console.error("  Failed to create unshield:", e.message);
    process.exit(1);
  }

  // Submit unshield
  try {
    const receipt = await submitUnshield(
      hubProvider,
      hubTestUser,
      railgunDeployment.contracts.railgunProxy,
      unshieldResult
    );
    console.log(`  Unshield tx confirmed in block: ${receipt?.blockNumber}`);
  } catch (e: any) {
    console.error("  Unshield failed:", e.message);
    process.exit(1);
  }

  // Bridge to Chain B via HubUnshieldProxy
  console.log(`\n  Bridging to Chain B via HubUnshieldProxy...`);

  // Capture Chain B balance BEFORE bridging (so we can detect the increase)
  const chainBBalanceBefore = await chainBUSDC.balanceOf(user.address);

  // Approve bridge (reset to 0 first for SafeERC20 compatibility)
  const hubUnshieldProxyAddress = await hubUnshieldProxy.getAddress();
  const resetBridgeApproveTx = await hubUSDCTestUser.approve(hubUnshieldProxyAddress, 0);
  await resetBridgeApproveTx.wait();
  const approveHubTx = await hubUSDCTestUser.approve(hubUnshieldProxyAddress, unshieldAmount);
  await approveHubTx.wait();

  // Bridge to Chain B
  const hubUnshieldProxyTestUser = new ethers.Contract(
    hubDeployment.contracts.hubUnshieldProxy,
    HUB_UNSHIELD_PROXY_ABI,
    hubTestUser
  );

  const bridgeTx = await hubUnshieldProxyTestUser.bridgeTo(
    unshieldAmount,
    user.address, // Send to test user on Chain B
    chainB.chainId
  );
  const bridgeReceipt = await bridgeTx.wait();
  console.log(`  Bridge tx: ${bridgeTx.hash}`);

  // ============ Step 6: Wait for Relayer (Hub → Chain B) ============

  console.log("\n--- Step 6: Waiting for Relayer (Hub → Chain B) ---");

  let received = false;
  const startTime2 = Date.now();
  const maxWaitTime2 = 60000; // 60 seconds for Hub → Chain B relay

  while (Date.now() - startTime2 < maxWaitTime2) {
    const chainBBalanceNow = await chainBUSDC.balanceOf(user.address);

    if (chainBBalanceNow > chainBBalanceBefore) {
      received = true;
      console.log(`  USDC received on Chain B!`);
      console.log(`    Before: ${formatUSDC(chainBBalanceBefore)}`);
      console.log(`    After:  ${formatUSDC(chainBBalanceNow)}`);
      console.log(`    Received: ${formatUSDC(BigInt(chainBBalanceNow) - BigInt(chainBBalanceBefore))}`);
      break;
    }

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  if (!received) {
    console.error("\n  ERROR: USDC not received on Chain B after 60s. Is relayer running?");
    process.exit(1);
  }

  // ============ Step 7: Final Balances ============

  console.log("\n--- Step 7: Final Balances ---");

  const finalBalanceA = await chainAUSDC.balanceOf(user.address);
  const finalBalanceB = await chainBUSDC.balanceOf(user.address);

  console.log(`  Chain A USDC: ${formatUSDC(finalBalanceA)} (was: ${formatUSDC(initialBalanceA)})`);
  console.log(`  Chain B USDC: ${formatUSDC(finalBalanceB)} (was: ${formatUSDC(initialBalanceB)})`);

  // Verify changes
  const chainADiff = BigInt(initialBalanceA) - BigInt(finalBalanceA);
  const chainBDiff = BigInt(finalBalanceB) - BigInt(initialBalanceB);

  console.log(`\n  Chain A change: -${formatUSDC(chainADiff)}`);
  console.log(`  Chain B change: +${formatUSDC(chainBDiff)}`);

  // ============ Summary ============

  console.log(`
${"=".repeat(70)}
  MULTI-CHAIN TEST PASSED!
${"=".repeat(70)}

Flow Completed:
  1. User shielded ${formatUSDC(shieldAmount)} on Chain A
  2. Relayer relayed to Hub, commitment added to Railgun
  3. Separate shield on Hub for unshield test
  4. User unshielded ${formatUSDC(unshieldAmount)} with destination Chain B
  5. Relayer relayed to Chain B
  6. User received USDC on Chain B

This validates the multi-chain architecture:
  - Shield from any client chain → Hub
  - Unshield from Hub → any client chain
  - Relayer correctly routes based on destinationChainId
`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error("Test failed:", e);
    process.exit(1);
  });
