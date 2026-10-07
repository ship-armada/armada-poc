// ABOUTME: Hardhat task that writes the Launch Team's UpgradeGate approve (or revoke) of a governance proposal
// ABOUTME: as a Safe Transaction Builder file, with a summary.md review sheet for the signers.

/**
 * Usage (governor address from the network's governance manifest, or --governor):
 *   npx hardhat gate-safe-approve --proposal 12 --network mainnetHub
 *   npx hardhat gate-safe-approve --proposal 12 --revoke --network mainnetHub
 *
 * Output goes to safe-batches/<time>-gate-approve|gate-revoke/ (gitignored): approve.json or
 * revoke.json plus summary.md. See docs/safe-launch-batches.md §Launch Team upgrade approvals.
 */

import { task } from "hardhat/config";
import { getAddress } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  gateBatchFile,
  readGateProposal,
  renderGateSummary,
  validateGateRequest,
  type GateAction,
} from "../scripts/upgrade-gate-batch";
import { createRunDir, reported } from "./safe-task-utils";

const GOVERNANCE_MANIFESTS: Record<string, string> = {
  mainnetHub: "governance-hub-mainnet.json",
  sepoliaHub: "governance-hub-sepolia.json",
  hub: "governance-hub.json",
};

function resolveGovernor(networkName: string, override: string | undefined): string {
  if (override) return getAddress(override);
  const file = GOVERNANCE_MANIFESTS[networkName];
  if (!file) throw new Error(`No governance manifest is known for network "${networkName}"; pass --governor`);
  const manifest = path.join(__dirname, "..", "deployments", file);
  if (!fs.existsSync(manifest)) throw new Error(`Governance manifest not found: ${manifest}; pass --governor`);
  return getAddress(JSON.parse(fs.readFileSync(manifest, "utf8")).contracts.governor);
}

task("gate-safe-approve", "Write the Launch Team's UpgradeGate approval (or --revoke) of a proposal as a Safe Transaction Builder file")
  .addParam("proposal", "Proposal id")
  .addOptionalParam("governor", "Governor address (default: the network's governance manifest)")
  .addOptionalParam("out", "Directory for the run's output folder", "safe-batches")
  .addFlag("revoke", "Write a revoke of an existing approval instead")
  .setAction(reported("gate-safe-approve", async (args: any, hre) => {
    const action: GateAction = args.revoke ? "revoke" : "approve";
    const provider = hre.ethers.provider;
    const governor = resolveGovernor(hre.network.name, args.governor);
    if (await provider.getCode(governor) === "0x") throw new Error(`No contract at the governor address ${governor}`);

    const proposal = await readGateProposal(provider, governor, BigInt(args.proposal));
    const errors = validateGateRequest(proposal, action);
    if (await provider.getCode(proposal.launchTeam) === "0x") {
      errors.push(`The Launch Team ${proposal.launchTeam} is not a contract; this file is for a Safe`);
    }
    if (errors.length) throw new Error(`Refusing to write the ${action} file:\n  ${errors.join("\n  ")}`);
    for (const finding of proposal.findings) console.log(`WARNING: ${finding}`);

    const dir = createRunDir(args.out, `gate-${action}`);
    const file = gateBatchFile(action, proposal, Date.now());
    fs.writeFileSync(path.join(dir, `${action}.json`), JSON.stringify(file, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "summary.md"), renderGateSummary(proposal, action));
    console.log(`Wrote ${path.join(dir, `${action}.json`)} for the Launch Team Safe ${proposal.launchTeam}`);
    console.log(`Signers review every action in ${path.join(dir, "summary.md")}`);
    return dir;
  }));
