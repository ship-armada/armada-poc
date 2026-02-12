/**
 * Hardhat Tasks for Armada Governance
 *
 * Individual governance actions callable from the CLI.
 * Loads deployment addresses from deployments/governance-{network}.json.
 *
 * Usage:
 *   npx hardhat lock-tokens --amount 10000 --network hub
 *   npx hardhat propose --type treasury --description "Pay Alice 500 USDC" --network hub
 *   npx hardhat vote --proposal 1 --support for --network hub
 *   npx hardhat proposal-state --proposal 1 --network hub
 *   npx hardhat queue-proposal --proposal 1 --network hub
 *   npx hardhat execute-proposal --proposal 1 --network hub
 *   npx hardhat steward-spend --token 0x... --to 0x... --amount 500 --network hub
 *   npx hardhat steward-status --network hub
 */

import { task } from "hardhat/config";
import * as fs from "fs";
import * as path from "path";

const StateNames = ["PENDING", "ACTIVE", "DEFEATED", "SUCCEEDED", "QUEUED", "EXECUTED", "CANCELED"];

function loadDeployment(networkName: string) {
  const filePath = path.join(__dirname, "..", "deployments", `governance-${networkName}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployment file not found: ${filePath}. Run deploy_governance.ts first.`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getNetworkName(chainId: number): string {
  if (chainId === 31337) return "hub";
  if (chainId === 31338) return "client";
  if (chainId === 31339) return "clientB";
  return "unknown";
}

// ============ Token Operations ============

task("lock-tokens", "Lock ARM tokens for voting")
  .addParam("amount", "Amount of ARM to lock (in whole tokens)")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const [signer] = await ethers.getSigners();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadDeployment(getNetworkName(chainId));

    const amount = ethers.parseUnits(args.amount, 18);
    const armToken = await ethers.getContractAt("ArmadaToken", deployment.contracts.armToken);
    const votingLocker = await ethers.getContractAt("VotingLocker", deployment.contracts.votingLocker);

    await armToken.approve(deployment.contracts.votingLocker, amount);
    await votingLocker.lock(amount);

    const locked = await votingLocker.getLockedBalance(signer.address);
    console.log(`Locked ${args.amount} ARM. Total locked: ${ethers.formatUnits(locked, 18)} ARM`);
  });

task("unlock-tokens", "Unlock ARM tokens")
  .addParam("amount", "Amount of ARM to unlock (in whole tokens)")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const [signer] = await ethers.getSigners();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadDeployment(getNetworkName(chainId));

    const amount = ethers.parseUnits(args.amount, 18);
    const votingLocker = await ethers.getContractAt("VotingLocker", deployment.contracts.votingLocker);

    await votingLocker.unlock(amount);

    const locked = await votingLocker.getLockedBalance(signer.address);
    console.log(`Unlocked ${args.amount} ARM. Remaining locked: ${ethers.formatUnits(locked, 18)} ARM`);
  });

task("arm-balance", "Check ARM balance and locked amount")
  .addOptionalParam("account", "Account address (defaults to signer)")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const [signer] = await ethers.getSigners();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadDeployment(getNetworkName(chainId));

    const account = args.account || signer.address;
    const armToken = await ethers.getContractAt("ArmadaToken", deployment.contracts.armToken);
    const votingLocker = await ethers.getContractAt("VotingLocker", deployment.contracts.votingLocker);

    const balance = await armToken.balanceOf(account);
    const locked = await votingLocker.getLockedBalance(account);

    console.log(`Account: ${account}`);
    console.log(`  Free ARM: ${ethers.formatUnits(balance, 18)}`);
    console.log(`  Locked ARM: ${ethers.formatUnits(locked, 18)}`);
  });

// ============ Proposals ============

task("propose", "Create a governance proposal")
  .addParam("type", "Proposal type: parameter, treasury, or steward")
  .addParam("description", "Proposal description")
  .addOptionalParam("target", "Target contract address")
  .addOptionalParam("calldata", "Encoded function call data")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadDeployment(getNetworkName(chainId));

    const governor = await ethers.getContractAt("ArmadaGovernor", deployment.contracts.governor);

    const typeMap: Record<string, number> = { parameter: 0, treasury: 1, steward: 2 };
    const proposalType = typeMap[args.type];
    if (proposalType === undefined) throw new Error("Invalid type. Use: parameter, treasury, steward");

    const targets = args.target ? [args.target] : [deployment.contracts.treasury];
    const values = [0n];
    const calldatas = args.calldata ? [args.calldata] : ["0x"];

    await governor.propose(proposalType, targets, values, calldatas, args.description);
    const count = await governor.proposalCount();
    console.log(`Proposal #${count} created: "${args.description}" (type: ${args.type})`);
  });

task("vote", "Cast a vote on a proposal")
  .addParam("proposal", "Proposal ID")
  .addParam("support", "Vote: for, against, or abstain")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadDeployment(getNetworkName(chainId));

    const governor = await ethers.getContractAt("ArmadaGovernor", deployment.contracts.governor);

    const supportMap: Record<string, number> = { against: 0, for: 1, abstain: 2 };
    const support = supportMap[args.support];
    if (support === undefined) throw new Error("Invalid support. Use: for, against, abstain");

    await governor.castVote(Number(args.proposal), support);
    console.log(`Voted ${args.support.toUpperCase()} on proposal #${args.proposal}`);
  });

task("proposal-state", "Check the state of a proposal")
  .addParam("proposal", "Proposal ID")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadDeployment(getNetworkName(chainId));

    const governor = await ethers.getContractAt("ArmadaGovernor", deployment.contracts.governor);

    const stateId = Number(await governor.state(Number(args.proposal)));
    const [proposer, proposalType, voteStart, voteEnd, forVotes, againstVotes, abstainVotes] =
      await governor.getProposal(Number(args.proposal));

    console.log(`Proposal #${args.proposal}:`);
    console.log(`  State: ${StateNames[stateId]}`);
    console.log(`  Proposer: ${proposer}`);
    console.log(`  Type: ${["ParameterChange", "Treasury", "StewardElection"][Number(proposalType)]}`);
    console.log(`  For: ${ethers.formatUnits(forVotes, 18)} ARM`);
    console.log(`  Against: ${ethers.formatUnits(againstVotes, 18)} ARM`);
    console.log(`  Abstain: ${ethers.formatUnits(abstainVotes, 18)} ARM`);
    console.log(`  Quorum required: ${ethers.formatUnits(await governor.quorum(Number(args.proposal)), 18)} ARM`);
  });

task("queue-proposal", "Queue a succeeded proposal to timelock")
  .addParam("proposal", "Proposal ID")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadDeployment(getNetworkName(chainId));

    const governor = await ethers.getContractAt("ArmadaGovernor", deployment.contracts.governor);
    await governor.queue(Number(args.proposal));
    console.log(`Proposal #${args.proposal} queued to timelock`);
  });

task("execute-proposal", "Execute a queued proposal")
  .addParam("proposal", "Proposal ID")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadDeployment(getNetworkName(chainId));

    const governor = await ethers.getContractAt("ArmadaGovernor", deployment.contracts.governor);
    await governor.execute(Number(args.proposal));
    console.log(`Proposal #${args.proposal} executed`);
  });

// ============ Steward ============

task("steward-spend", "Steward: spend from operational budget")
  .addParam("token", "Token address")
  .addParam("to", "Recipient address")
  .addParam("amount", "Amount (in token decimals)")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadDeployment(getNetworkName(chainId));

    const treasury = await ethers.getContractAt("ArmadaTreasuryGov", deployment.contracts.treasury);
    await treasury.stewardSpend(args.token, args.to, BigInt(args.amount));
    console.log(`Steward spent ${args.amount} to ${args.to}`);
  });

task("steward-status", "Check steward status")
  .setAction(async (_, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployment = loadDeployment(getNetworkName(chainId));

    const steward = await ethers.getContractAt("TreasurySteward", deployment.contracts.steward);
    const treasury = await ethers.getContractAt("ArmadaTreasuryGov", deployment.contracts.treasury);

    const isActive = await steward.isStewardActive();
    const currentSteward = await steward.currentSteward();
    const treasurySteward = await treasury.steward();

    console.log("Steward Status:");
    console.log(`  Active: ${isActive}`);
    console.log(`  Steward (TreasurySteward): ${currentSteward}`);
    console.log(`  Steward (Treasury): ${treasurySteward}`);
    if (isActive) {
      const termEnd = await steward.termEnd();
      console.log(`  Term ends: ${new Date(Number(termEnd) * 1000).toISOString()}`);
    }
  });
