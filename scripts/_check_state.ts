// ABOUTME: Debug script to inspect crowdfund contract state on local Anvil.
// ABOUTME: Prints capped demand estimates, per-hop stats, and final ceilings/demands.
import { ethers } from 'hardhat';
import d from '../deployments/crowdfund-hub.json';

async function main() {
  const cf = await ethers.getContractAt('ArmadaCrowdfund', d.contracts.crowdfund);
  const [est, h0, h1, h2] = await Promise.all([
    cf.getEstimatedCappedDemand(),
    cf.getHopStats(0),
    cf.getHopStats(1),
    cf.getHopStats(2),
  ]);
  console.log('globalCapped:', ethers.formatUnits(est[0], 6));
  console.log('perHop:', est[1].map((v: bigint) => ethers.formatUnits(v, 6)));
  console.log('hop0 totalCommitted:', ethers.formatUnits(h0[0], 6), 'cappedCommitted:', ethers.formatUnits(h0[1], 6), 'committers:', h0[2].toString(), 'whitelist:', h0[3].toString());
  console.log('hop1 totalCommitted:', ethers.formatUnits(h1[0], 6), 'cappedCommitted:', ethers.formatUnits(h1[1], 6), 'committers:', h1[2].toString(), 'whitelist:', h1[3].toString());
  console.log('hop2 totalCommitted:', ethers.formatUnits(h2[0], 6), 'cappedCommitted:', ethers.formatUnits(h2[1], 6), 'committers:', h2[2].toString(), 'whitelist:', h2[3].toString());
  
  // Check finalCeilings/finalDemands
  const [fc0, fc1, fc2, fd0, fd1, fd2] = await Promise.all([
    cf.finalCeilings(0), cf.finalCeilings(1), cf.finalCeilings(2),
    cf.finalDemands(0), cf.finalDemands(1), cf.finalDemands(2),
  ]);
  console.log('finalCeilings:', [fc0, fc1, fc2].map((v: bigint) => ethers.formatUnits(v, 6)));
  console.log('finalDemands:', [fd0, fd1, fd2].map((v: bigint) => ethers.formatUnits(v, 6)));
}
main();
