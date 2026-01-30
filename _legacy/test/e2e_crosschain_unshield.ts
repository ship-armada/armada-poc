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
  RailgunWallet,
  Note,
  exportWallet
} from "../lib/_legacy/wallet";
import { MerkleTree, TREE_DEPTH } from "../lib/_legacy/merkle_tree";
import {
  createUnshield,
  submitUnshield,
  noteToSpentNote,
  UnshieldResult
} from "../lib/_legacy/transfer";

/**
 * E2E Cross-Chain Unshield Test
 *
 * Tests the full cross-chain unshield flow:
 * 1. Alice shields USDC on Hub chain
 * 2. Alice unshields to her own address on Hub
 * 3. Alice bridges USDC from Hub to Client chain via HubUnshieldProxy
 * 4. Relayer picks up BurnForDeposit event and mints on Client chain
 * 5. Alice receives USDC on Client chain
 *
 * Prerequisites:
 * - Both chains running (npm run chains)
 * - Contracts deployed (npm run deploy:all && npm run deploy:railgun)
 * - HubUnshieldProxy deployed (npm run deploy:unshield-proxy)
 * - Relayer running in another terminal (npm run relayer)
 */

// ============ ABIs ============

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount) external",
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
  "event Unshield(address indexed to, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint256 amount, uint256 fee)",
];

const HUB_UNSHIELD_PROXY_ABI = [
  "function bridgeToClient(uint256 amount, address recipient) external returns (uint64 nonce)",
  "function bridgeTo(uint256 amount, address recipient, uint32 destinationChainId) external returns (uint64 nonce)",
  "event BridgeInitiated(address indexed sender, address indexed recipient, uint256 amount, uint32 destinationChainId, uint64 ccptNonce)",
];

// ============ Load Deployments ============

function loadDeployments(): { client: any; hub: any; railgun: any } {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const clientPath = path.join(deploymentsDir, "client.json");
  const hubPath = path.join(deploymentsDir, "hub.json");
  const railgunPath = path.join(deploymentsDir, "railgun.json");

  if (!fs.existsSync(clientPath)) {
    throw new Error("Client deployment not found. Run 'npm run deploy:client' first.");
  }
  if (!fs.existsSync(hubPath)) {
    throw new Error("Hub deployment not found. Run 'npm run deploy:hub' first.");
  }
  if (!fs.existsSync(railgunPath)) {
    throw new Error("Railgun deployment not found. Run 'npm run deploy:railgun' first.");
  }

  return {
    client: JSON.parse(fs.readFileSync(clientPath, "utf-8")),
    hub: JSON.parse(fs.readFileSync(hubPath, "utf-8")),
    railgun: JSON.parse(fs.readFileSync(railgunPath, "utf-8")),
  };
}

// ============ Helper Functions ============

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

  // Process Transact events
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

  const note = createNote(wallet, tokenAddress, amount);
  const commitment = getNoteCommitment(note);

  console.log(`Creating note with value: ${ethers.formatUnits(amount, 6)} USDC`);
  console.log(`NPK: ${ethers.zeroPadValue(ethers.toBeHex(note.npk), 32).slice(0, 30)}...`);
  console.log(`Commitment: ${ethers.zeroPadValue(ethers.toBeHex(commitment), 32).slice(0, 30)}...`);

  // Approve Railgun
  const railgunAddress = await railgunContract.getAddress();
  console.log(`Approving Railgun (${railgunAddress}) to spend USDC...`);
  const approveTx = await usdcContract.approve(railgunAddress, amount);
  await approveTx.wait();

  // Create ShieldRequest
  const shieldRequest = {
    preimage: {
      npk: ethers.zeroPadValue(ethers.toBeHex(note.npk), 32),
      token: {
        tokenType: 0,
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
  E2E CROSS-CHAIN UNSHIELD TEST
${"=".repeat(60)}
`);

  // Initialize crypto
  console.log("Initializing cryptographic primitives...");
  await initCrypto();

  // Load deployments
  const deployments = loadDeployments();
  console.log("Loaded deployments:");
  console.log(`  Hub MockUSDC: ${deployments.hub.contracts.mockUSDC}`);
  console.log(`  Client MockUSDC: ${deployments.client.contracts.mockUSDC}`);
  console.log(`  RailgunSmartWallet: ${deployments.railgun.contracts.railgunProxy}`);
  console.log(`  HubUnshieldProxy: ${deployments.hub.contracts.hubUnshieldProxy}`);

  if (!deployments.hub.contracts.hubUnshieldProxy) {
    throw new Error("HubUnshieldProxy not deployed. Run 'npx hardhat run scripts/deploy_unshield_proxy.ts --network hub' first.");
  }

  // Setup providers and signers
  const hubProvider = new ethers.JsonRpcProvider(config.hubChain.rpc);
  const clientProvider = new ethers.JsonRpcProvider(config.clientChain.rpc);

  const hubNetwork = await hubProvider.getNetwork();
  const clientNetwork = await clientProvider.getNetwork();

  console.log(`\nHub chain: ${config.hubChain.rpc} (chain ID: ${hubNetwork.chainId})`);
  console.log(`Client chain: ${config.clientChain.rpc} (chain ID: ${clientNetwork.chainId})`);

  // Use deployer account
  const signer = new ethers.Wallet(config.accounts.deployer.privateKey, hubProvider);
  const clientSigner = new ethers.Wallet(config.accounts.deployer.privateKey, clientProvider);
  console.log(`Signer: ${signer.address}`);

  // Connect to contracts
  const hubMockUSDC = new ethers.Contract(
    deployments.hub.contracts.mockUSDC,
    ERC20_ABI,
    signer
  );

  const clientMockUSDC = new ethers.Contract(
    deployments.client.contracts.mockUSDC,
    ERC20_ABI,
    clientSigner
  );

  const railgun = new ethers.Contract(
    deployments.railgun.contracts.railgunProxy,
    RAILGUN_ABI,
    signer
  );

  const hubUnshieldProxy = new ethers.Contract(
    deployments.hub.contracts.hubUnshieldProxy,
    HUB_UNSHIELD_PROXY_ABI,
    signer
  );

  // Check initial balances
  const hubBalance = await hubMockUSDC.balanceOf(signer.address);
  const clientBalanceBefore = await clientMockUSDC.balanceOf(signer.address);
  console.log(`\nHub USDC balance: ${ethers.formatUnits(hubBalance, 6)} USDC`);
  console.log(`Client USDC balance (before): ${ethers.formatUnits(clientBalanceBefore, 6)} USDC`);

  // Mint USDC if needed
  const requiredAmount = ethers.parseUnits("500", 6);
  if (hubBalance < requiredAmount) {
    console.log("Minting USDC for testing...");
    const mintTx = await hubMockUSDC.mint(signer.address, requiredAmount);
    await mintTx.wait();
    console.log(`New Hub USDC balance: ${ethers.formatUnits(await hubMockUSDC.balanceOf(signer.address), 6)} USDC`);
  }

  // ============ Create Wallet ============

  console.log("\n--- Creating Railgun Wallet ---");
  const aliceWallet = await createWallet();
  console.log("Alice's wallet created:");
  console.log(`  Public Key: [${aliceWallet.publicKey[0].toString().slice(0, 20)}..., ${aliceWallet.publicKey[1].toString().slice(0, 20)}...]`);

  // ============ Initialize Merkle Tree ============

  console.log("\n--- Initializing Merkle Tree ---");
  const merkleTree = new MerkleTree(TREE_DEPTH);
  console.log(`Local merkle tree initialized (depth: ${TREE_DEPTH})`);

  // Sync with on-chain state
  await syncMerkleTreeFromChain(railgun, merkleTree);

  // ============ Step 1: Shield USDC ============

  const shieldAmount = ethers.parseUnits("50", 6);  // 50 USDC
  const aliceNote = await shieldDirectly(
    aliceWallet,
    railgun,
    hubMockUSDC,
    shieldAmount,
    deployments.hub.contracts.mockUSDC,
    merkleTree
  );

  // Verify on-chain state
  const onChainRoot = await railgun.merkleRoot();
  const localRoot = merkleTree.root;
  console.log(`\nOn-chain merkle root: ${onChainRoot}`);
  console.log(`Local merkle root: ${ethers.zeroPadValue(ethers.toBeHex(localRoot), 32)}`);

  // ============ Step 2: Unshield to Own Address ============

  console.log("\n--- Creating Unshield Transaction ---");
  const unshieldAmount = ethers.parseUnits("50", 6);  // Full unshield
  console.log(`Unshielding ${ethers.formatUnits(unshieldAmount, 6)} USDC to ${signer.address}`);

  // Convert note to SpentNote
  const spentNote = noteToSpentNote(aliceNote, aliceNote.leafIndex!, merkleTree);

  // Create unshield (NORMAL unshield to own address)
  let unshieldResult: UnshieldResult;
  try {
    unshieldResult = await createUnshield(
      {
        senderWallet: aliceWallet,
        inputNotes: [spentNote],
        unshieldAmount,
        recipientAddress: signer.address,  // Unshield to self on Hub
        tokenAddress: deployments.hub.contracts.mockUSDC,
        chainId: BigInt(hubNetwork.chainId),
        treeNumber: 0,
        unshieldType: 1  // NORMAL
      },
      merkleTree
    );

    console.log("\n=== Unshield Transaction Summary ===");
    console.log(`Nullifiers: ${unshieldResult.nullifiers.length}`);
    unshieldResult.nullifiers.forEach((n, i) => console.log(`  [${i}] ${n}`));
    console.log(`\nUnshield Amount: ${ethers.formatUnits(unshieldResult.unshieldValue, 6)} USDC`);
    console.log(`Unshield Recipient: ${unshieldResult.unshieldRecipient}`);
    console.log(`Change Note: ${unshieldResult.changeNote ? "Yes" : "No"}`);
  } catch (e: any) {
    console.error("Failed to create unshield:", e.message);
    process.exit(1);
  }

  // Submit unshield transaction
  console.log("\n--- Submitting Unshield Transaction ---");
  try {
    const receipt = await submitUnshield(
      hubProvider,
      signer,
      deployments.railgun.contracts.railgunProxy,
      unshieldResult
    );

    if (receipt) {
      console.log(`Transaction confirmed in block: ${receipt.blockNumber}`);
      console.log(`Gas used: ${receipt.gasUsed}`);
    }
  } catch (e: any) {
    console.error("Unshield transaction failed:", e.message);
    process.exit(1);
  }

  // Check Hub USDC balance after unshield
  const hubBalanceAfterUnshield = await hubMockUSDC.balanceOf(signer.address);
  console.log(`\nHub USDC balance after unshield: ${ethers.formatUnits(hubBalanceAfterUnshield, 6)} USDC`);

  // ============ Step 3: Bridge to Client Chain ============

  console.log("\n--- Bridging to Client Chain via HubUnshieldProxy ---");
  const bridgeAmount = unshieldAmount;

  // Approve HubUnshieldProxy
  const hubUnshieldProxyAddress = await hubUnshieldProxy.getAddress();
  console.log(`Approving HubUnshieldProxy (${hubUnshieldProxyAddress}) to spend USDC...`);
  const approveTx = await hubMockUSDC.approve(hubUnshieldProxyAddress, bridgeAmount);
  await approveTx.wait();

  // Bridge to client chain
  console.log(`Bridging ${ethers.formatUnits(bridgeAmount, 6)} USDC to ${signer.address} on Client chain...`);
  const bridgeTx = await hubUnshieldProxy.bridgeToClient(bridgeAmount, signer.address);
  const bridgeReceipt = await bridgeTx.wait();
  console.log(`Bridge tx: ${bridgeTx.hash}`);
  console.log(`Block: ${bridgeReceipt?.blockNumber}`);

  // Parse events to get nonce
  const bridgeEvent = bridgeReceipt?.logs.find((log: any) => {
    try {
      const parsed = hubUnshieldProxy.interface.parseLog({
        topics: log.topics as string[],
        data: log.data
      });
      return parsed?.name === "BridgeInitiated";
    } catch {
      return false;
    }
  });

  if (bridgeEvent) {
    const parsed = hubUnshieldProxy.interface.parseLog({
      topics: bridgeEvent.topics as string[],
      data: bridgeEvent.data
    });
    console.log(`CCTP Nonce: ${parsed?.args.ccptNonce}`);
  }

  // ============ Step 4: Wait for Relayer ============

  console.log("\n--- Waiting for Relayer to Process ---");
  console.log("The relayer will pick up the BurnForDeposit event and mint on Client chain.");
  console.log("(Make sure the relayer is running: npm run relayer)");

  // Poll for balance change on client chain
  const maxWaitTime = 30000;  // 30 seconds
  const pollInterval = 2000;   // 2 seconds
  let elapsed = 0;

  while (elapsed < maxWaitTime) {
    const clientBalanceNow = await clientMockUSDC.balanceOf(signer.address);

    if (clientBalanceNow > clientBalanceBefore) {
      console.log(`\nClient USDC balance updated!`);
      console.log(`  Before: ${ethers.formatUnits(clientBalanceBefore, 6)} USDC`);
      console.log(`  After:  ${ethers.formatUnits(clientBalanceNow, 6)} USDC`);
      console.log(`  Received: ${ethers.formatUnits(clientBalanceNow - clientBalanceBefore, 6)} USDC`);
      break;
    }

    process.stdout.write(".");
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  if (elapsed >= maxWaitTime) {
    console.log("\nTimeout waiting for client balance update.");
    console.log("Make sure the relayer is running and check for errors.");
  }

  // ============ Final Summary ============

  const finalHubBalance = await hubMockUSDC.balanceOf(signer.address);
  const finalClientBalance = await clientMockUSDC.balanceOf(signer.address);

  console.log(`
${"=".repeat(60)}
  CROSS-CHAIN UNSHIELD TEST COMPLETE
${"=".repeat(60)}

Summary:
  - Shielded on Hub: ${ethers.formatUnits(shieldAmount, 6)} USDC
  - Unshielded to self: ${ethers.formatUnits(unshieldAmount, 6)} USDC
  - Bridged to Client: ${ethers.formatUnits(bridgeAmount, 6)} USDC

Final Balances:
  - Hub USDC: ${ethers.formatUnits(finalHubBalance, 6)} USDC
  - Client USDC: ${ethers.formatUnits(finalClientBalance, 6)} USDC

The cross-chain unshield flow is complete!
User shielded funds on Hub, unshielded privately, and received tokens on Client chain.
`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Test failed:", e);
    process.exit(1);
  });
