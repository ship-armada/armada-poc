// ABOUTME: Checks for the Ledger pre-flight: signer[0] must be the configured Ledger address, and
// ABOUTME: the device must sign a no-transaction message naming the chain and deploy commit.

import { getAddress, verifyMessage } from "ethers";

/** The message the operator approves on the device. Signing it sends no transaction. */
export function ledgerPreflightMessage(chainId: number, deployCommit: string | undefined): string {
  return [
    "Armada deploy pre-flight",
    `Chain: ${chainId}`,
    `Commit: ${deployCommit ?? "not pinned"}`,
    "No transaction is sent by signing this message.",
  ].join("\n");
}

/** Hardhat lists local accounts before Ledger accounts, so signer[0] must be checked explicitly. */
export function assertLedgerSigner(ledgerAddress: string, signerAddress: string): void {
  if (getAddress(signerAddress) !== getAddress(ledgerAddress)) {
    throw new Error(
      `signer[0] is ${signerAddress}, not the Ledger ${ledgerAddress}. A local account is ` +
      "configured for this network; remove DEPLOYER_PRIVATE_KEY before a Ledger deploy."
    );
  }
}

/** The pre-flight signature must recover to the Ledger address. */
export function assertSignedBy(message: string, signature: string, ledgerAddress: string): void {
  const recovered = verifyMessage(message, signature);
  if (getAddress(recovered) !== getAddress(ledgerAddress)) {
    throw new Error(`Pre-flight message was signed by ${recovered}, not the Ledger ${ledgerAddress}`);
  }
}
