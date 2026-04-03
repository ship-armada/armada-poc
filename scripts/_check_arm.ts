// ABOUTME: Debug script to verify ARM token transfer restrictions against the whitelist.
// ABOUTME: Tests staticCall transfers to whitelisted and non-whitelisted addresses on local Anvil.
import { ethers } from 'hardhat';

async function main() {
  const d = require('../deployments/crowdfund-hub.json');
  const arm = await ethers.getContractAt('ArmadaToken', d.contracts.armToken);
  
  const addr = '0xEfE3DbeACBcde4780F1D5f3e356Ed6B6611ADC52';
  const nonWL = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'; // random non-whitelisted
  const deployer = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const treasury = d.contracts.treasury;
  const crowdfund = d.contracts.crowdfund;
  
  const signer = await ethers.getImpersonatedSigner(addr);
  
  // Test 1: to non-whitelisted address
  try {
    await arm.connect(signer).transfer.staticCall(nonWL, ethers.parseUnits('100', 18));
    console.log('-> non-whitelisted: SUCCEEDS (unexpected)');
  } catch (err: any) {
    console.log(`-> non-whitelisted: REVERTS "${err.reason}"`);
  }
  
  // Test 2: to deployer (whitelisted)
  try {
    await arm.connect(signer).transfer.staticCall(deployer, ethers.parseUnits('100', 18));
    console.log('-> deployer (WL):   SUCCEEDS');
  } catch (err: any) {
    console.log(`-> deployer (WL):   REVERTS "${err.reason}"`);
  }
  
  // Test 3: to treasury (whitelisted)
  try {
    await arm.connect(signer).transfer.staticCall(treasury, ethers.parseUnits('100', 18));
    console.log('-> treasury (WL):   SUCCEEDS');
  } catch (err: any) {
    console.log(`-> treasury (WL):   REVERTS "${err.reason}"`);
  }
  
  // Test 4: to crowdfund (whitelisted)
  try {
    await arm.connect(signer).transfer.staticCall(crowdfund, ethers.parseUnits('100', 18));
    console.log('-> crowdfund (WL):  SUCCEEDS');
  } catch (err: any) {
    console.log(`-> crowdfund (WL):  REVERTS "${err.reason}"`);
  }
}
main();
