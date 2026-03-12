// ABOUTME: MCP tool that checks RPC connectivity, block numbers, balances, and contract deployment status.
// ABOUTME: Read-only — queries each chain's RPC endpoint and reports health status.

import { type ChainRole, getChainByRole } from "../../../config/networks";
import { checkRpc, getBalance, hasCode } from "../lib/providers";
import {
  loadAllDeployments,
  getPoolAddress,
  type AllDeployments,
} from "../lib/deployments";
import { type DeployEnv } from "../../../config/networks";

interface ChainHealthReport {
  chain: string;
  role: ChainRole;
  rpc: string;
  reachable: boolean;
  blockNumber: number | null;
  chainId: {
    expected: number;
    actual: number | null;
    match: boolean | null;
  };
  deployerBalance: string | null;
  contracts: {
    usdc: { address: string | null; deployed: boolean | null };
    privacyPool: { address: string | null; deployed: boolean | null };
  };
}

export async function getChainHealth(
  env: DeployEnv,
  chains: ChainRole[] = ["hub", "clientA", "clientB"]
): Promise<ChainHealthReport[]> {
  const deployments = loadAllDeployments(env);

  const reports = await Promise.allSettled(
    chains.map((role) => checkSingleChain(role, deployments))
  );

  return reports.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    // If the check itself threw, return a minimal failure report
    const role = chains[i];
    const chain = getChainByRole(role);
    return {
      chain: chain.name,
      role,
      rpc: chain.rpc,
      reachable: false,
      blockNumber: null,
      chainId: { expected: chain.chainId, actual: null, match: null },
      deployerBalance: null,
      contracts: {
        usdc: { address: null, deployed: null },
        privacyPool: { address: null, deployed: null },
      },
    };
  });
}

async function checkSingleChain(
  role: ChainRole,
  deployments: AllDeployments
): Promise<ChainHealthReport> {
  const chain = getChainByRole(role);
  const rpcResult = await checkRpc(role);
  const reachable = rpcResult !== null;

  // Get addresses from deployment artifacts
  const chainDeploy =
    role === "hub"
      ? deployments.hub
      : role === "clientA"
        ? deployments.clientA
        : deployments.clientB;

  const usdcAddress = chainDeploy.cctp?.contracts.usdc ?? null;
  const poolAddress = chainDeploy.privacyPool ? getPoolAddress(chainDeploy.privacyPool) : null;
  const deployerAddress = chainDeploy.cctp?.deployer ?? chainDeploy.privacyPool?.deployer ?? null;

  // Only query on-chain state if RPC is reachable
  let deployerBalance: string | null = null;
  let usdcDeployed: boolean | null = null;
  let poolDeployed: boolean | null = null;

  if (reachable) {
    const checks = await Promise.allSettled([
      deployerAddress ? getBalance(role, deployerAddress) : null,
      usdcAddress ? hasCode(role, usdcAddress) : null,
      poolAddress ? hasCode(role, poolAddress) : null,
    ]);

    deployerBalance =
      checks[0].status === "fulfilled" ? (checks[0].value as string | null) : null;
    usdcDeployed =
      checks[1].status === "fulfilled" ? (checks[1].value as boolean | null) : null;
    poolDeployed =
      checks[2].status === "fulfilled" ? (checks[2].value as boolean | null) : null;
  }

  return {
    chain: chain.name,
    role,
    rpc: chain.rpc,
    reachable,
    blockNumber: rpcResult?.blockNumber ?? null,
    chainId: {
      expected: chain.chainId,
      actual: rpcResult?.chainId ?? null,
      match: rpcResult ? rpcResult.chainId === chain.chainId : null,
    },
    deployerBalance,
    contracts: {
      usdc: { address: usdcAddress, deployed: usdcDeployed },
      privacyPool: { address: poolAddress, deployed: poolDeployed },
    },
  };
}
