// ABOUTME: Resolves how the deployer signs on live networks — a raw private key or a Ledger device.
// ABOUTME: Shared by hardhat.config.ts (signer wiring) and config/networks.ts (env validation).

export type DeployerSigner =
  | { kind: "key"; privateKey: string }
  | { kind: "ledger"; address: string }
  | { kind: "none" };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Read DEPLOYER_PRIVATE_KEY / DEPLOYER_LEDGER_ADDRESS. Exactly one may be set: with both,
 * Hardhat would list the key's account first and deploy from it, not from the Ledger.
 */
export function resolveDeployerSigner(env: NodeJS.ProcessEnv): DeployerSigner {
  const privateKey = env.DEPLOYER_PRIVATE_KEY?.trim() ?? "";
  const ledgerAddress = env.DEPLOYER_LEDGER_ADDRESS?.trim() ?? "";

  if (privateKey && ledgerAddress) {
    throw new Error(
      "Set DEPLOYER_PRIVATE_KEY or DEPLOYER_LEDGER_ADDRESS, not both. For a Ledger deploy, " +
      "remove DEPLOYER_PRIVATE_KEY from config/secrets.env."
    );
  }
  if (ledgerAddress) {
    if (!ADDRESS.test(ledgerAddress)) {
      throw new Error(`DEPLOYER_LEDGER_ADDRESS must be a 0x-prefixed 20-byte address, got "${ledgerAddress}"`);
    }
    return { kind: "ledger", address: ledgerAddress };
  }
  if (privateKey) return { kind: "key", privateKey };
  return { kind: "none" };
}
