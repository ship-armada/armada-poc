/**
 * Deploy Railgun Smart Wallet to Hub Chain
 *
 * This script deploys the core Railgun contracts for the POC:
 * - PoseidonT3 & PoseidonT4 (hash libraries) - actual Poseidon bytecode from circomlibjs
 * - Treasury (fee collection)
 * - ProxyAdmin (upgrade management)
 * - RailgunSmartWallet (main shielded pool via proxy)
 * - Verification keys for SNARK proof verification
 *
 * Note: RelayAdapt is omitted for POC simplicity
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { loadVerificationKeys, TESTING_ARTIFACT_CONFIGS } from "../lib/artifacts";

// Load Poseidon bytecode generated from circomlibjs
const poseidonBytecode = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "lib", "poseidon_bytecode.json"), "utf-8")
);

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("=== Deploying Railgun to Hub Chain ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${network.chainId}`);
  console.log("");

  // 1. Deploy Poseidon Libraries (using actual bytecode from circomlibjs)
  console.log("1. Deploying Poseidon libraries (actual bytecode from circomlibjs)...");

  // Deploy PoseidonT3 with raw bytecode
  const poseidonT3Tx = await deployer.sendTransaction({
    data: poseidonBytecode.PoseidonT3.bytecode,
  });
  const poseidonT3Receipt = await poseidonT3Tx.wait();
  const poseidonT3Address = poseidonT3Receipt!.contractAddress!;
  console.log(`   PoseidonT3: ${poseidonT3Address}`);

  // Deploy PoseidonT4 with raw bytecode
  const poseidonT4Tx = await deployer.sendTransaction({
    data: poseidonBytecode.PoseidonT4.bytecode,
  });
  const poseidonT4Receipt = await poseidonT4Tx.wait();
  const poseidonT4Address = poseidonT4Receipt!.contractAddress!;
  console.log(`   PoseidonT4: ${poseidonT4Address}`);

  // 2. Deploy ProxyAdmin
  console.log("\n2. Deploying ProxyAdmin...");
  const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
  const proxyAdmin = await ProxyAdmin.deploy(deployer.address);
  await proxyAdmin.waitForDeployment();
  const proxyAdminAddress = await proxyAdmin.getAddress();
  console.log(`   ProxyAdmin: ${proxyAdminAddress}`);

  // 3. Deploy Treasury Implementation
  console.log("\n3. Deploying Treasury...");
  const Treasury = await ethers.getContractFactory("Treasury");
  const treasuryImpl = await Treasury.deploy();
  await treasuryImpl.waitForDeployment();
  const treasuryImplAddress = await treasuryImpl.getAddress();
  console.log(`   Treasury Implementation: ${treasuryImplAddress}`);

  // 4. Deploy Treasury Proxy
  const Proxy = await ethers.getContractFactory("PausableUpgradableProxy");
  const treasuryProxy = await Proxy.deploy(proxyAdminAddress);
  await treasuryProxy.waitForDeployment();
  const treasuryProxyAddress = await treasuryProxy.getAddress();
  console.log(`   Treasury Proxy: ${treasuryProxyAddress}`);

  // 5. Set Treasury implementation and unpause
  console.log("\n4. Configuring Treasury proxy...");
  await (await proxyAdmin.upgrade(treasuryProxyAddress, treasuryImplAddress)).wait();
  await (await proxyAdmin.unpause(treasuryProxyAddress)).wait();

  // Initialize Treasury
  const treasury = Treasury.attach(treasuryProxyAddress);
  await (await treasury.initializeTreasury(deployer.address)).wait();
  console.log("   Treasury initialized");

  // 6. Deploy RailgunSmartWallet Implementation (with linked libraries)
  console.log("\n5. Deploying RailgunSmartWallet...");
  const RailgunSmartWallet = await ethers.getContractFactory("RailgunSmartWallet", {
    libraries: {
      PoseidonT3: poseidonT3Address,
      PoseidonT4: poseidonT4Address,
    },
  });
  const railgunImpl = await RailgunSmartWallet.deploy();
  await railgunImpl.waitForDeployment();
  const railgunImplAddress = await railgunImpl.getAddress();
  console.log(`   Implementation: ${railgunImplAddress}`);

  // 7. Deploy Railgun Proxy
  const railgunProxy = await Proxy.deploy(proxyAdminAddress);
  await railgunProxy.waitForDeployment();
  const railgunProxyAddress = await railgunProxy.getAddress();
  console.log(`   Proxy: ${railgunProxyAddress}`);

  // 8. Set Railgun implementation and unpause
  console.log("\n6. Configuring RailgunSmartWallet proxy...");
  await (await proxyAdmin.upgrade(railgunProxyAddress, railgunImplAddress)).wait();
  await (await proxyAdmin.unpause(railgunProxyAddress)).wait();

  // 9. Initialize RailgunSmartWallet
  // Using the implementation ABI but attached to proxy address
  const railgun = RailgunSmartWallet.attach(railgunProxyAddress);

  // Initialize with:
  // - Treasury address
  // - 0 fees for POC (normally 25 basis points each)
  // - Owner address
  await (await railgun.initializeRailgunLogic(
    treasuryProxyAddress,
    0n,  // shieldFee (0 for POC)
    0n,  // unshieldFee (0 for POC)
    0n,  // nftFee (0 for POC)
    deployer.address,
    { gasLimit: 2000000 }
  )).wait();
  console.log("   RailgunSmartWallet initialized");

  // 10. Load verification keys for SNARK proof verification
  console.log("\n7. Loading verification keys...");
  await loadVerificationKeys(railgun as any, TESTING_ARTIFACT_CONFIGS, true);

  // 11. Ensure testing mode is disabled (real SNARK verification)
  console.log("\n8. Verifying SNARK verification is enabled...");
  const testingMode = await railgun.testingMode();
  if (testingMode) {
    console.log("   Disabling testing mode...");
    await (await railgun.setTestingMode(false)).wait();
  }
  console.log("   SNARK verification is ENABLED");

  // Save deployment info
  const verificationKeysLoaded = TESTING_ARTIFACT_CONFIGS.map(
    (c) => `${c.nullifiers}x${c.commitments}`
  );

  const deploymentInfo = {
    chainId: Number(network.chainId),
    deployer: deployer.address,
    contracts: {
      poseidonT3: poseidonT3Address,
      poseidonT4: poseidonT4Address,
      proxyAdmin: proxyAdminAddress,
      treasuryImpl: treasuryImplAddress,
      treasuryProxy: treasuryProxyAddress,
      railgunImpl: railgunImplAddress,
      railgunProxy: railgunProxyAddress,
    },
    config: {
      shieldFee: 0,
      unshieldFee: 0,
      nftFee: 0,
      testingMode: false,
      verificationKeysLoaded,
    },
    timestamp: new Date().toISOString(),
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deploymentPath = path.join(deploymentsDir, "railgun.json");
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));

  console.log("\n=== Deployment Complete ===");
  console.log(`Deployment info saved to: ${deploymentPath}`);
  console.log("");
  console.log("Contract Addresses:");
  console.log(`  RailgunSmartWallet (proxy): ${railgunProxyAddress}`);
  console.log(`  Treasury (proxy):           ${treasuryProxyAddress}`);
  console.log(`  ProxyAdmin:                 ${proxyAdminAddress}`);
  console.log("");
  console.log("Verification Keys Loaded:");
  verificationKeysLoaded.forEach((k) => console.log(`  - ${k}`));
  console.log("");
  console.log("✓ SNARK verification is ENABLED - real proofs required");

  return deploymentInfo;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
