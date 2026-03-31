// ABOUTME: Shared test helper for deploying ArmadaGovernor behind an ERC1967 UUPS proxy.
// ABOUTME: Used by all Hardhat test files that need a governor instance.

import { ethers } from "hardhat";

/**
 * Deploy ArmadaGovernor implementation + ERC1967Proxy and return the proxied contract instance.
 * Matches the production deployment pattern in scripts/deploy_governance.ts.
 */
export async function deployGovernorProxy(
  armTokenAddress: string,
  timelockAddress: string,
  treasuryAddress: string,
) {
  // Deploy the external library first, then link it to the governor
  const GovernorStringLib = await ethers.getContractFactory("GovernorStringLib");
  const lib = await GovernorStringLib.deploy();
  await lib.waitForDeployment();

  const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor", {
    libraries: { GovernorStringLib: await lib.getAddress() },
  });
  const impl = await ArmadaGovernor.deploy();
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

  // Register the initial set of extended selectors (mirrors production deploy)
  const extSelectors = [
    governor.interface.getFunction("addExtendedSelector")!.selector,
    governor.interface.getFunction("removeExtendedSelector")!.selector,
    governor.interface.getFunction("setSecurityCouncil")!.selector,
    governor.interface.getFunction("setProposalTypeParams")!.selector,
    ethers.id("upgradeTo(address)").slice(0, 10),
    ethers.id("upgradeToAndCall(address,bytes)").slice(0, 10),
    // Yield adapter selectors that require extended governance
    ethers.id("setBaseArmadaTake(uint256)").slice(0, 10),
    ethers.id("addTier(uint256,uint256)").slice(0, 10),
    ethers.id("setTier(uint256,uint256,uint256)").slice(0, 10),
    ethers.id("removeTier(uint256)").slice(0, 10),
    ethers.id("setYieldFee(uint256)").slice(0, 10),
    ethers.id("setIntegratorTerms(address,uint256,uint256,bool)").slice(0, 10),
  ];
  await governor.initExtendedSelectors(extSelectors);

  return governor;
}
