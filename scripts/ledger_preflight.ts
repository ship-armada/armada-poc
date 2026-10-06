// ABOUTME: Ledger pre-flight run by deploy_mainnet.ts before any transaction: the device signs a
// ABOUTME: message (no transaction) proving it is connected, unlocked and holds the deployer key.

import { ethers } from "hardhat";
import { getNetworkConfig } from "../config/networks";
import { assertLedgerSigner, assertSignedBy, ledgerPreflightMessage } from "./ledger-preflight";

async function main() {
  const config = getNetworkConfig();
  const ledgerAddress = config.deployerLedgerAddress;
  if (!ledgerAddress) {
    throw new Error("DEPLOYER_LEDGER_ADDRESS is not set; the Ledger pre-flight only applies to Ledger deploys.");
  }

  const [signer] = await ethers.getSigners();
  assertLedgerSigner(ledgerAddress, signer.address);

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const message = ledgerPreflightMessage(chainId, process.env.DEPLOY_COMMIT?.trim() || undefined);
  console.log("Approve the pre-flight message on the Ledger (no transaction is sent):\n");
  console.log(message.split("\n").map((line) => `  ${line}`).join("\n") + "\n");
  const signature = await signer.signMessage(message);
  assertSignedBy(message, signature, ledgerAddress);

  const balance = await ethers.provider.getBalance(signer.address);
  console.log(`Ledger OK: ${signer.address} on chain ${chainId}, balance ${ethers.formatEther(balance)} ETH.`);
  console.log("Keep the device unlocked with the Ethereum app open until the deploy finishes.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
