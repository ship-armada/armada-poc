// ABOUTME: MCP tool that queries live contract state (view functions) for privacy pool, governance, yield, crowdfund.
// ABOUTME: Read-only — uses minimal ABI fragments to call view functions and return structured results.

import { type ChainRole, type DeployEnv } from "../../../config/networks";
import { callView, getProvider } from "../lib/providers";
import { loadAllDeployments, getPoolAddress } from "../lib/deployments";
import { ethers } from "ethers";

// ============================================================================
// Minimal ABI fragments — only the view functions we query
// ============================================================================

const PRIVACY_POOL_ABI = [
  "function testingMode() view returns (bool)",
  "function merkleRoot() view returns (bytes32)",
  "function nextLeafIndex() view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const GOVERNANCE_ABI = [
  "function proposalThreshold() view returns (uint256)",
  // votingDelay/votingPeriod are per-proposal-type, accessed via proposalTypeParams mapping
  "function proposalTypeParams(uint8) view returns (uint256 votingDelay, uint256 votingPeriod, uint256 executionDelay, uint256 quorumBps)",
];

const TIMELOCK_ABI = [
  "function getMinDelay() view returns (uint256)",
];

const TREASURY_GOV_ABI = [
  "function getStewardBudget(address token) view returns (uint256 budget, uint256 spent, uint256 remaining)",
];

const YIELD_VAULT_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

const TREASURY_ABI = [
  "function getBalance(address token) view returns (uint256)",
];

const CROWDFUND_ABI = [
  "function totalCommitted() view returns (uint256)",
  "function phase() view returns (uint8)",
  "function commitmentEnd() view returns (uint256)",
  "function getSaleStats() view returns (uint256 totalCommitted, uint8 phase, uint256 invitationEnd, uint256 commitmentEnd)",
  "function BASE_SALE() view returns (uint256)",
  "function MAX_SALE() view returns (uint256)",
  "function MIN_SALE() view returns (uint256)",
];

// ============================================================================
// Query helpers
// ============================================================================

type ContractQueryResult = Record<string, unknown>;

async function safeCall(
  role: ChainRole,
  address: string,
  abi: string[],
  fn: string,
  args: unknown[] = []
): Promise<unknown> {
  try {
    return await callView(role, address, abi, fn, args);
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}

function formatUsdc(value: unknown): string {
  if (typeof value === "bigint") {
    return ethers.formatUnits(value, 6) + " USDC";
  }
  return String(value);
}

function formatArm(value: unknown): string {
  if (typeof value === "bigint") {
    return ethers.formatUnits(value, 18) + " ARM";
  }
  return String(value);
}

// ============================================================================
// Component queries
// ============================================================================

async function queryPrivacyPool(
  env: DeployEnv,
  role: ChainRole
): Promise<ContractQueryResult> {
  const deployments = loadAllDeployments(env);
  const chain =
    role === "hub"
      ? deployments.hub
      : role === "clientA"
        ? deployments.clientA
        : deployments.clientB;

  if (!chain.privacyPool) {
    return { error: `No privacy pool deployment found for ${role}` };
  }

  const poolAddr = getPoolAddress(chain.privacyPool);
  if (!poolAddr) {
    return { error: `No pool contract address found in deployment for ${role}` };
  }
  const usdcAddr = chain.privacyPool.cctp.usdc;

  const [testingMode, merkleRoot, nextLeafIndex, usdcBalance] =
    await Promise.all([
      safeCall(role, poolAddr, PRIVACY_POOL_ABI, "testingMode"),
      safeCall(role, poolAddr, PRIVACY_POOL_ABI, "merkleRoot"),
      safeCall(role, poolAddr, PRIVACY_POOL_ABI, "nextLeafIndex"),
      safeCall(role, usdcAddr, ERC20_ABI, "balanceOf", [poolAddr]),
    ]);

  return {
    address: poolAddr,
    testingMode,
    merkleRoot: typeof merkleRoot === "string" && merkleRoot.startsWith("error")
      ? merkleRoot
      : String(merkleRoot),
    nextLeafIndex: typeof nextLeafIndex === "bigint" ? Number(nextLeafIndex) : nextLeafIndex,
    usdcBalance: formatUsdc(usdcBalance),
    modules: chain.privacyPool.contracts,
  };
}

async function queryGovernance(env: DeployEnv): Promise<ContractQueryResult> {
  const deployments = loadAllDeployments(env);
  if (!deployments.hub.governance) {
    return { error: "No governance deployment found" };
  }

  const gov = deployments.hub.governance.contracts;
  const usdcAddr = deployments.hub.cctp?.contracts.usdc;

  // ProposalType enum: 0 = Standard, 1 = Extended, 2 = VetoRatification
  const [
    proposalThreshold,
    treasuryParams,
    constitutionalParams,
    timelockDelay,
    armSupply,
    treasuryUsdc,
    stewardBudget,
  ] = await Promise.all([
    safeCall("hub", gov.governor, GOVERNANCE_ABI, "proposalThreshold"),
    safeCall("hub", gov.governor, GOVERNANCE_ABI, "proposalTypeParams", [0]),
    safeCall("hub", gov.governor, GOVERNANCE_ABI, "proposalTypeParams", [1]),
    safeCall("hub", gov.timelockController, TIMELOCK_ABI, "getMinDelay"),
    safeCall("hub", gov.armToken, ERC20_ABI, "totalSupply"),
    usdcAddr
      ? safeCall("hub", usdcAddr, ERC20_ABI, "balanceOf", [gov.treasury])
      : "no USDC address",
    usdcAddr
      ? safeCall("hub", gov.treasury, TREASURY_GOV_ABI, "getStewardBudget", [usdcAddr])
      : "no USDC address",
  ]);

  function formatParams(params: unknown): Record<string, string> | string {
    if (typeof params === "string") return params;
    if (Array.isArray(params) && params.length >= 4) {
      return {
        votingDelay: `${Number(params[0])} seconds`,
        votingPeriod: `${Number(params[1])} seconds`,
        executionDelay: `${Number(params[2])} seconds`,
        quorumBps: `${Number(params[3])} bps`,
      };
    }
    return String(params);
  }

  function formatBudget(budget: unknown): Record<string, string> | string {
    if (typeof budget === "string") return budget;
    if (Array.isArray(budget) && budget.length >= 3) {
      return {
        budget: formatUsdc(budget[0]),
        spent: formatUsdc(budget[1]),
        remaining: formatUsdc(budget[2]),
      };
    }
    return String(budget);
  }

  return {
    addresses: gov,
    armTotalSupply: formatArm(armSupply),
    proposalThreshold: formatArm(proposalThreshold),
    proposalTypes: {
      treasury: formatParams(treasuryParams),
      constitutional: formatParams(constitutionalParams),
    },
    timelockDelay: typeof timelockDelay === "bigint" ? `${Number(timelockDelay)} seconds` : timelockDelay,
    treasuryUsdc: formatUsdc(treasuryUsdc),
    stewardBudget: formatBudget(stewardBudget),
  };
}

async function queryYield(env: DeployEnv): Promise<ContractQueryResult> {
  const deployments = loadAllDeployments(env);
  if (!deployments.hub.yield) {
    return { error: "No yield deployment found" };
  }

  const yieldDeploy = deployments.hub.yield;
  const contracts = yieldDeploy.contracts;
  const usdcAddr = yieldDeploy.config.usdc;

  const [vaultAssets, vaultShares, treasuryBalance, adapterUsdc] =
    await Promise.all([
      safeCall("hub", contracts.armadaYieldVault, YIELD_VAULT_ABI, "totalAssets"),
      safeCall("hub", contracts.armadaYieldVault, YIELD_VAULT_ABI, "totalSupply"),
      safeCall("hub", contracts.armadaTreasury, TREASURY_ABI, "getBalance", [usdcAddr]),
      safeCall("hub", usdcAddr, ERC20_ABI, "balanceOf", [
        contracts.armadaYieldAdapter,
      ]),
    ]);

  return {
    addresses: contracts,
    vault: {
      totalAssets: formatUsdc(vaultAssets),
      totalShares: typeof vaultShares === "bigint" ? vaultShares.toString() : vaultShares,
    },
    treasuryUsdcBalance: formatUsdc(treasuryBalance),
    adapterUsdcBalance: formatUsdc(adapterUsdc),
    config: yieldDeploy.config,
  };
}

async function queryCrowdfund(env: DeployEnv): Promise<ContractQueryResult> {
  const deployments = loadAllDeployments(env);
  if (!deployments.hub.crowdfund) {
    return { error: "No crowdfund deployment found" };
  }

  const cf = deployments.hub.crowdfund.contracts;

  // Phase enum: 0 = Setup, 1 = Invitation, 2 = Commitment, 3 = Finalized, 4 = Canceled
  const CROWDFUND_PHASES = [
    "Setup",
    "Invitation",
    "Commitment",
    "Finalized",
    "Canceled",
  ];

  const [saleStats, baseSale, maxSale, minSale] =
    await Promise.all([
      safeCall("hub", cf.crowdfund, CROWDFUND_ABI, "getSaleStats"),
      safeCall("hub", cf.crowdfund, CROWDFUND_ABI, "BASE_SALE"),
      safeCall("hub", cf.crowdfund, CROWDFUND_ABI, "MAX_SALE"),
      safeCall("hub", cf.crowdfund, CROWDFUND_ABI, "MIN_SALE"),
    ]);

  // getSaleStats returns (totalCommitted, phase, invitationEnd, commitmentEnd)
  let totalCommitted: unknown = null;
  let phase: unknown = null;
  let commitmentEnd: unknown = null;
  let invitationEnd: unknown = null;

  if (Array.isArray(saleStats) && saleStats.length >= 4) {
    totalCommitted = saleStats[0];
    phase = saleStats[1];
    invitationEnd = saleStats[2];
    commitmentEnd = saleStats[3];
  } else {
    totalCommitted = saleStats;
  }

  const phaseNum = typeof phase === "bigint" ? Number(phase) :
    typeof phase === "number" ? phase : null;

  return {
    address: cf.crowdfund,
    totalCommitted: formatUsdc(totalCommitted),
    phase: phaseNum !== null ? CROWDFUND_PHASES[phaseNum] ?? `Unknown(${phaseNum})` : phase,
    invitationEnd:
      typeof invitationEnd === "bigint"
        ? invitationEnd > 0n ? new Date(Number(invitationEnd) * 1000).toISOString() : "not set"
        : invitationEnd,
    commitmentEnd:
      typeof commitmentEnd === "bigint"
        ? commitmentEnd > 0n ? new Date(Number(commitmentEnd) * 1000).toISOString() : "not set"
        : commitmentEnd,
    saleLimits: {
      base: formatUsdc(baseSale),
      min: formatUsdc(minSale),
      max: formatUsdc(maxSale),
    },
  };
}

// ============================================================================
// Exported dispatcher
// ============================================================================

export type ContractComponent =
  | "privacy-pool"
  | "governance"
  | "yield"
  | "crowdfund";

export async function getContractState(
  env: DeployEnv,
  component: ContractComponent,
  chain: ChainRole = "hub"
): Promise<ContractQueryResult> {
  switch (component) {
    case "privacy-pool":
      return queryPrivacyPool(env, chain);
    case "governance":
      return queryGovernance(env);
    case "yield":
      return queryYield(env);
    case "crowdfund":
      return queryCrowdfund(env);
    default:
      return { error: `Unknown component: ${component}` };
  }
}
