// ABOUTME: Checks that verify_etherscan rebuilds the exact constructor arguments of hardened-launch
// ABOUTME: contracts — the timelock deployed at delay 0 and a crowdfund whose launch team is not the deployer.
import { expect } from "chai";
import hre from "hardhat";
import { timelockConstructorDelay, crowdfundConstructorArgs } from "../scripts/verify_etherscan";

const { ethers } = hre;

describe("Etherscan constructor arguments", function () {
  // WHY: Etherscan matches source by re-encoding the constructor arguments against the
  // creation transaction. The harden profile deploys the timelock at delay 0 and raises it to
  // the production value later, so the manifest's final delay is the wrong argument.
  it("recovers the timelock's constructor delay after the delay was raised", async function () {
    const [deployer] = await ethers.getSigners();
    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(0, [deployer.address], [deployer.address], deployer.address);
    await timelock.waitForDeployment();
    const deployTx = timelock.deploymentTransaction()!;
    const deployBlock = (await deployTx.wait())!.blockNumber;

    // Raise the delay the way deploy_crowdfund's harden step does: a self-call via the timelock.
    const ZERO = ethers.ZeroHash;
    const call = timelock.interface.encodeFunctionData("updateDelay", [172800]);
    const addr = await timelock.getAddress();
    await (await timelock.schedule(addr, 0, call, ZERO, ZERO, 0)).wait();
    await (await timelock.execute(addr, 0, call, ZERO, ZERO)).wait();
    expect(await timelock.getMinDelay()).to.equal(172800n);

    const delay = await timelockConstructorDelay(addr, deployBlock);
    expect(delay).to.equal(0n);
    const rebuilt = Timelock.getDeployTransaction(delay, [deployer.address], [deployer.address], deployer.address);
    expect((await rebuilt).data).to.equal(deployTx.data);
  });

  // WHY: on mainnet the launch team must differ from the deployer, so assuming
  // launchTeam = deployer produces arguments that do not match the creation transaction.
  it("rebuilds the crowdfund's arguments when the launch team is not the deployer", async function () {
    const signers = await ethers.getSigners();
    const addr = (i: number) => signers[i].address;
    const latest = await ethers.provider.getBlock("latest");
    const Crowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
    const crowdfund = await Crowdfund.deploy(addr(1), addr(2), addr(3), addr(4), addr(5), latest!.timestamp + 86400);
    await crowdfund.waitForDeployment();
    expect(addr(4)).to.not.equal(signers[0].address);

    const args = await crowdfundConstructorArgs(await crowdfund.getAddress());
    const rebuilt = await Crowdfund.getDeployTransaction(...(args as Parameters<typeof Crowdfund.deploy>));
    expect(rebuilt.data).to.equal(crowdfund.deploymentTransaction()!.data);
  });
});
