// ABOUTME: MCP tool that inspects deployment artifacts and reports contract addresses, missing files, and cross-ref issues.
// ABOUTME: Read-only — scans deployments/ JSON files and validates completeness and consistency.

import {
  loadAllDeployments,
  listDeploymentFiles,
  type AllDeployments,
  type ChainDeployments,
  type HubDeployments,
} from "../lib/deployments";
import { type DeployEnv } from "../../../config/networks";

interface DeploymentIssue {
  severity: "error" | "warning";
  message: string;
}

interface DeploymentReport {
  env: DeployEnv;
  files: string[];
  hub: ComponentSummary;
  clientA: ComponentSummary;
  clientB: ComponentSummary;
  issues: DeploymentIssue[];
}

interface ComponentSummary {
  [component: string]: {
    deployed: boolean;
    contracts: Record<string, string>;
    timestamp?: string;
  };
}

function summarizeChain(
  chain: ChainDeployments,
  label: string,
  issues: DeploymentIssue[]
): ComponentSummary {
  const summary: ComponentSummary = {};

  if (chain.cctp) {
    summary.cctp = {
      deployed: true,
      contracts: chain.cctp.contracts,
      timestamp: chain.cctp.timestamp,
    };
  } else {
    summary.cctp = { deployed: false, contracts: {} };
    issues.push({
      severity: "error",
      message: `${label}: CCTP deployment missing`,
    });
  }

  if (chain.privacyPool) {
    summary.privacyPool = {
      deployed: true,
      contracts: chain.privacyPool.contracts,
      timestamp: chain.privacyPool.timestamp,
    };
  } else {
    summary.privacyPool = { deployed: false, contracts: {} };
    issues.push({
      severity: "error",
      message: `${label}: Privacy pool deployment missing`,
    });
  }

  return summary;
}

function summarizeHub(
  hub: HubDeployments,
  issues: DeploymentIssue[]
): ComponentSummary {
  const summary = summarizeChain(hub, "Hub", issues);

  // Hub-only components
  const hubOnlyComponents: Array<{
    key: keyof HubDeployments;
    label: string;
  }> = [
    { key: "yield", label: "Yield" },
    { key: "aaveMock", label: "Aave Mock" },
    { key: "governance", label: "Governance" },
    { key: "crowdfund", label: "Crowdfund" },
  ];

  for (const { key, label } of hubOnlyComponents) {
    const deployment = hub[key];
    if (deployment) {
      summary[key] = {
        deployed: true,
        contracts: (deployment as any).contracts,
        timestamp: (deployment as any).timestamp,
      };
    } else {
      summary[key] = { deployed: false, contracts: {} };
      issues.push({
        severity: "warning",
        message: `Hub: ${label} deployment missing`,
      });
    }
  }

  return summary;
}

function crossReferenceChecks(
  deployments: AllDeployments,
  issues: DeploymentIssue[]
): void {
  // Check that client pool CCTP references match the CCTP deployment
  for (const [label, chain] of [
    ["Client A", deployments.clientA],
    ["Client B", deployments.clientB],
  ] as const) {
    if (chain.privacyPool && chain.cctp) {
      const poolUsdc = chain.privacyPool.cctp.usdc;
      const cctpUsdc = chain.cctp.contracts.usdc;
      if (poolUsdc && cctpUsdc && poolUsdc !== cctpUsdc) {
        issues.push({
          severity: "error",
          message: `${label}: Pool USDC (${poolUsdc}) != CCTP USDC (${cctpUsdc})`,
        });
      }
    }
  }

  // Check hub pool CCTP references match
  if (deployments.hub.privacyPool && deployments.hub.cctp) {
    const poolUsdc = deployments.hub.privacyPool.cctp.usdc;
    const cctpUsdc = deployments.hub.cctp.contracts.usdc;
    if (poolUsdc && cctpUsdc && poolUsdc !== cctpUsdc) {
      issues.push({
        severity: "error",
        message: `Hub: Pool USDC (${poolUsdc}) != CCTP USDC (${cctpUsdc})`,
      });
    }
  }

  // Check yield references hub USDC correctly
  if (deployments.hub.yield && deployments.hub.cctp) {
    const yieldUsdc = deployments.hub.yield.config.usdc;
    const cctpUsdc = deployments.hub.cctp.contracts.usdc;
    if (yieldUsdc && cctpUsdc && yieldUsdc !== cctpUsdc) {
      issues.push({
        severity: "error",
        message: `Hub: Yield USDC (${yieldUsdc}) != CCTP USDC (${cctpUsdc})`,
      });
    }
  }

  // Check aave mock reference in yield config
  if (deployments.hub.yield && deployments.hub.aaveMock) {
    const yieldAave = deployments.hub.yield.config.mockAaveSpoke;
    const aaveAddr = deployments.hub.aaveMock.contracts.mockAaveSpoke;
    if (yieldAave && aaveAddr && yieldAave !== aaveAddr) {
      issues.push({
        severity: "error",
        message: `Hub: Yield aave ref (${yieldAave}) != Aave Mock (${aaveAddr})`,
      });
    }
  }
}

export function getDeploymentState(env: DeployEnv): DeploymentReport {
  const deployments = loadAllDeployments(env);
  const files = listDeploymentFiles();
  const issues: DeploymentIssue[] = [];

  const hub = summarizeHub(deployments.hub, issues);
  const clientA = summarizeChain(deployments.clientA, "Client A", issues);
  const clientB = summarizeChain(deployments.clientB, "Client B", issues);

  crossReferenceChecks(deployments, issues);

  return { env, files, hub, clientA, clientB, issues };
}
