// ABOUTME: Shared test helper for deploying ArmadaGovernor behind an ERC1967 UUPS proxy.
// ABOUTME: Used by all Hardhat test files that need a governor instance.

import { ethers } from "hardhat";

/**
 * Deploy ArmadaGovernor implementation + ERC1967Proxy and return the proxied contract instance.
 * Matches the production deployment pattern in scripts/deploy_governance.ts.
 * When no upgrade gate is given, deploys one whose Launch Team is the first signer, so tests
 * that never execute gated proposals need no gate setup.
 */
export async function deployGovernorProxy(
  armTokenAddress: string,
  timelockAddress: string,
  treasuryAddress: string,
  upgradeGateAddress?: string,
) {
  let gateAddress = upgradeGateAddress;
  if (!gateAddress) {
    const [defaultTeam] = await ethers.getSigners();
    const gate = await (await ethers.getContractFactory("UpgradeGate")).deploy(defaultTeam.address);
    await gate.waitForDeployment();
    gateAddress = await gate.getAddress();
  }

  const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
  const impl = await ArmadaGovernor.deploy(gateAddress);
  await impl.waitForDeployment();

  const initData = ArmadaGovernor.interface.encodeFunctionData("initialize", [
    armTokenAddress,
    timelockAddress,
    treasuryAddress,
  ]);

  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  const governor = ArmadaGovernor.attach(await proxy.getAddress());

  // Extended selectors are hardcoded in initialize() — no setup step needed.

  return governor;
}
