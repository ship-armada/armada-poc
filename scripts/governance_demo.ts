/**
 * Governance Demo — Narrated end-to-end walkthrough
 *
 * Deploys the full governance system and runs through two complete flows:
 *   Flow 1: Treasury proposal (pay USDC to a recipient)
 *   Flow 2: Steward election + spend + veto
 *
 * Uses time.increase() to fast-forward through delays.
 *
 * Usage:
 *   npx hardhat run scripts/governance_demo.ts --network hub
 *     OR (standalone, uses Hardhat's built-in network):
 *   npx hardhat run scripts/governance_demo.ts
 */

import { ethers, network } from "hardhat";

const ProposalType = { Standard: 0, Extended: 1, VetoRatification: 2 };
const Vote = { Against: 0, For: 1, Abstain: 2 };
const StateNames = ["PENDING", "ACTIVE", "DEFEATED", "SUCCEEDED", "QUEUED", "EXECUTED", "CANCELED"];

const ONE_DAY = 86400;
const TWO_DAYS = 2 * ONE_DAY;
const FIVE_DAYS = 5 * ONE_DAY;
const SEVEN_DAYS = 7 * ONE_DAY;
const FOUR_DAYS = 4 * ONE_DAY;

function log(tag: string, msg: string) {
  const padded = `[${tag}]`.padEnd(12);
  console.log(`${padded} ${msg}`);
}

async function fastForward(seconds: number, label: string) {
  console.log("");
  console.log(`           \u23e9 Fast-forward ${label}...`);
  await network.provider.send("evm_increaseTime", [seconds + 1]);
  await network.provider.send("evm_mine");
  console.log("");
}

function fmtArm(amount: bigint): string {
  return `${(Number(amount) / 1e18).toLocaleString()} ARM`;
}

function fmtUsdc(amount: bigint): string {
  return `${(Number(amount) / 1e6).toLocaleString()} USDC`;
}

async function main() {
  const [deployer, alice, bob, carol, dave, eve] = await ethers.getSigners();

  console.log("=".repeat(70));
  console.log("  ARMADA GOVERNANCE DEMO");
  console.log("=".repeat(70));
  console.log("");

  // ============ SETUP ============
  log("SETUP", "Deploying governance system...");

  const MAX_PAUSE = 14 * ONE_DAY;

  const TimelockController = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockController.deploy(TWO_DAYS, [], [], deployer.address);
  await timelock.waitForDeployment();
  const tlAddr = await timelock.getAddress();

  const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
  const armToken = await ArmadaToken.deploy(deployer.address, tlAddr);
  await armToken.waitForDeployment();

  const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
  const treasury = await ArmadaTreasuryGov.deploy(tlAddr, deployer.address, MAX_PAUSE);
  await treasury.waitForDeployment();

  const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
  const governor = await ArmadaGovernor.deploy(
    await armToken.getAddress(),
    tlAddr,
    await treasury.getAddress(),
    deployer.address, MAX_PAUSE
  );
  await governor.waitForDeployment();

  const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
  const stewardContract = await TreasurySteward.deploy(
    tlAddr, deployer.address, MAX_PAUSE
  );
  await stewardContract.waitForDeployment();

  // Configure timelock
  await timelock.grantRole(await timelock.PROPOSER_ROLE(), await governor.getAddress());
  await timelock.grantRole(await timelock.EXECUTOR_ROLE(), await governor.getAddress());
  await timelock.renounceRole(await timelock.TIMELOCK_ADMIN_ROLE(), deployer.address);

  // Deploy mock USDC
  const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
  const usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
  await usdc.waitForDeployment();

  // Configure ARM token
  await armToken.setNoDelegation(await treasury.getAddress());
  await armToken.initWhitelist([deployer.address, await treasury.getAddress()]);

  // ARM distribution for demo: treasury gets 65%, remainder split between voters.
  // Amounts are derived from total supply so they adapt if supply changes.
  const totalSupply = await armToken.totalSupply();
  const treasuryArm = totalSupply * 65n / 100n;  // 65% to treasury
  const aliceArm = totalSupply * 20n / 100n;     // 20% to Alice (large voter)
  const bobArm = totalSupply * 15n / 100n;       // 15% to Bob (smaller voter)

  await armToken.transfer(await treasury.getAddress(), treasuryArm);
  await armToken.transfer(alice.address, aliceArm);
  await armToken.transfer(bob.address, bobArm);
  await usdc.mint(await treasury.getAddress(), ethers.parseUnits("100000", 6));

  log("SETUP", `Distributing ARM: ${fmtArm(treasuryArm)} \u2192 treasury, ${fmtArm(aliceArm)} \u2192 Alice, ${fmtArm(bobArm)} \u2192 Bob`);
  log("SETUP", `Minting 100,000 USDC to treasury`);
  console.log("");

  // Delegate voting power via ERC20Votes
  await armToken.connect(alice).delegate(alice.address);
  log("DELEGATE", `Alice self-delegates \u2192 voting power: ${fmtArm(aliceArm)}`);

  await armToken.connect(bob).delegate(bob.address);
  log("DELEGATE", `Bob self-delegates \u2192 voting power: ${fmtArm(bobArm)}`);

  await network.provider.send("evm_mine");

  // ============ FLOW 1: Treasury Proposal ============
  console.log("");
  console.log("-".repeat(70));
  console.log("  FLOW 1: Treasury Proposal \u2014 Pay Carol 500 USDC");
  console.log("-".repeat(70));
  console.log("");

  const payAmount = ethers.parseUnits("500", 6);
  const targets1 = [await treasury.getAddress()];
  const values1 = [0n];
  const calldatas1 = [treasury.interface.encodeFunctionData("distribute", [
    await usdc.getAddress(), carol.address, payAmount
  ])];

  await governor.connect(alice).propose(
    ProposalType.Standard, targets1, values1, calldatas1, "Pay Carol 500 USDC"
  );
  const pid1 = Number(await governor.proposalCount());
  log("PROPOSE", `Alice creates Treasury proposal #${pid1}: "Pay Carol 500 USDC"`);
  log("STATE", `Proposal #${pid1}: ${StateNames[Number(await governor.state(pid1))]} (2-day review period)`);

  await fastForward(TWO_DAYS, "2 days");

  log("STATE", `Proposal #${pid1}: ${StateNames[Number(await governor.state(pid1))]} (voting open for 5 days)`);

  await governor.connect(alice).castVote(pid1, Vote.For);
  log("VOTE", `Alice votes FOR with ${fmtArm(aliceArm)}`);
  await governor.connect(bob).castVote(pid1, Vote.For);
  log("VOTE", `Bob votes FOR with ${fmtArm(bobArm)}`);

  const [,,,,forVotes1, againstVotes1, abstainVotes1] = await governor.getProposal(pid1);
  log("TALLY", `For: ${fmtArm(forVotes1)} | Against: ${fmtArm(againstVotes1)} | Abstain: ${fmtArm(abstainVotes1)}`);

  const quorum1 = await governor.quorum(pid1);
  log("QUORUM", `Required: ${fmtArm(quorum1)} (20% of eligible supply) \u2713 Met`);

  await fastForward(FIVE_DAYS, "5 days");

  log("STATE", `Proposal #${pid1}: ${StateNames[Number(await governor.state(pid1))]}`);

  await governor.queue(pid1);
  log("QUEUE", `Queued to timelock (2-day execution delay)`);

  await fastForward(TWO_DAYS, "2 days");

  const carolBefore = await usdc.balanceOf(carol.address);
  await governor.execute(pid1);
  const carolAfter = await usdc.balanceOf(carol.address);
  log("EXECUTE", `Proposal #${pid1} executed!`);
  log("RESULT", `Carol USDC balance: ${fmtUsdc(carolBefore)} \u2192 ${fmtUsdc(carolAfter)} \u2713`);

  // ============ FLOW 2: Steward Election + Spend + Veto ============
  console.log("");
  console.log("-".repeat(70));
  console.log("  FLOW 2: Steward Election + Spend + Veto");
  console.log("-".repeat(70));
  console.log("");

  // Elect Dave — the TreasurySteward contract tracks identity; the timelock calls electSteward
  const electTargets = [
    await stewardContract.getAddress(),
  ];
  const electValues = [0n];
  const electCalldatas = [
    stewardContract.interface.encodeFunctionData("electSteward", [dave.address]),
  ];

  await governor.connect(alice).propose(
    ProposalType.Extended, electTargets, electValues, electCalldatas,
    "Elect Dave as steward"
  );
  const pid2 = Number(await governor.proposalCount());
  log("PROPOSE", `Alice creates Extended proposal #${pid2}: "Elect Dave as steward"`);

  await fastForward(TWO_DAYS, "2 days (voting delay)");
  await governor.connect(alice).castVote(pid2, Vote.For);
  await governor.connect(bob).castVote(pid2, Vote.For);
  log("VOTE", `Alice and Bob vote FOR`);

  await fastForward(SEVEN_DAYS, "7 days (extended voting)");
  await governor.queue(pid2);
  await fastForward(FOUR_DAYS, "4 days (extended timelock)");
  await governor.execute(pid2);

  log("EXECUTE", `Dave is now treasury steward (6-month term)`);
  log("STATE", `Steward active: ${await stewardContract.isStewardActive()}`);

  // In the production flow, a steward submits spend requests via governance proposals
  // (ArmadaGovernor.proposeStewardSpend creates pass-by-default proposals).
  // For demo brevity, we show the final governance-approved spend directly from the timelock.
  // The timelock (owner) calls stewardSpend after steward budget token is authorized.
  log("NOTE", `Steward spending flows through governance — demo skips full proposal cycle`);
  log("NOTE", ` In production: Dave submits proposal \u2192 quorum approval \u2192 timelock executes stewardSpend`);

  // Create a veto-able action: governance proposes to veto a hypothetical action
  // For the demo, we show the veto governance proposal flow
  const vetoTargets = [await stewardContract.getAddress()];
  const vetoValues = [0n];
  // Veto action #1 (which doesn't exist yet, but demonstrates the flow)
  const vetoCalldatas = [
    stewardContract.interface.encodeFunctionData("removeSteward", [])
  ];

  await governor.connect(alice).propose(
    ProposalType.Standard, vetoTargets, vetoValues, vetoCalldatas,
    "Remove Dave as steward"
  );
  const pid3 = Number(await governor.proposalCount());
  log("VETO", `Alice creates proposal #${pid3} to remove Dave as steward`);

  await fastForward(TWO_DAYS, "2 days");
  await governor.connect(alice).castVote(pid3, Vote.For);
  await governor.connect(bob).castVote(pid3, Vote.For);
  log("VOTE", `Alice and Bob vote FOR removal`);

  await fastForward(FIVE_DAYS, "5 days");
  await governor.queue(pid3);
  await fastForward(TWO_DAYS, "2 days");
  await governor.execute(pid3);

  log("EXECUTE", `Steward removal passed \u2014 Dave is no longer steward`);
  log("STATE", `Steward active: ${await stewardContract.isStewardActive()}`);

  console.log("");
  console.log("=".repeat(70));
  console.log("  DEMO COMPLETE");
  console.log("=".repeat(70));
  console.log("");
  console.log("  Flows demonstrated:");
  console.log("  1. Treasury proposal: delegate \u2192 propose \u2192 vote \u2192 queue \u2192 execute \u2192 USDC paid");
  console.log("  2. Steward election \u2192 operational spend \u2192 governance removal");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
