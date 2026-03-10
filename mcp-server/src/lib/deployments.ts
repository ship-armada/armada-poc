// ABOUTME: Loads and parses deployment JSON artifacts from the deployments/ directory.
// ABOUTME: Provides typed structures for each deployment component (CCTP, pool, yield, governance, crowdfund).

import * as fs from "fs";
import * as path from "path";
import {
  type DeployEnv,
  type ChainRole,
  getCCTPDeploymentFile,
  getPrivacyPoolDeploymentFile,
  getYieldDeploymentFile,
  getAaveMockDeploymentFile,
  getGovernanceDeploymentFile,
  getCrowdfundDeploymentFile,
} from "../../../config/networks";

// ============================================================================
// Deployment artifact types — mirrors the JSON schemas in deployments/
// ============================================================================

export interface CCTPDeployment {
  chainId: number;
  domain: number;
  deployer: string;
  cctpMode?: string;
  contracts: {
    usdc: string;
    messageTransmitter: string;
    tokenMessenger: string;
  };
  timestamp: string;
}

// Hub deploys PrivacyPool (with modules); client chains deploy PrivacyPoolClient (no modules).
// Both share the same deployment file structure but differ in the contracts object.
export interface PrivacyPoolDeployment {
  chainId: number;
  domain: number;
  deployer: string;
  contracts: {
    privacyPool?: string;
    privacyPoolClient?: string;
    merkleModule?: string;
    verifierModule?: string;
    shieldModule?: string;
    transactModule?: string;
    hookRouter?: string;
  };
  cctp: {
    tokenMessenger: string;
    messageTransmitter: string;
    usdc: string;
  };
  hub?: {
    domain: number;
    privacyPool: string;
  };
  timestamp: string;
}

/**
 * Get the pool contract address from a deployment, handling hub vs client key names.
 */
export function getPoolAddress(deployment: PrivacyPoolDeployment): string | null {
  return deployment.contracts.privacyPool ?? deployment.contracts.privacyPoolClient ?? null;
}

export interface YieldDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    armadaTreasury: string;
    armadaYieldVault: string;
    armadaYieldAdapter: string;
  };
  config: {
    usdc: string;
    mockAaveSpoke: string;
    reserveId: number;
    yieldFeeBps: number;
  };
  timestamp: string;
}

export interface AaveMockDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    mockAaveSpoke: string;
  };
  reserves: Record<
    string,
    { reserveId: number; underlying: string; annualYieldBps: number }
  >;
  timestamp: string;
}

export interface GovernanceDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    armToken: string;
    votingLocker: string;
    timelockController: string;
    treasury: string;
    governor: string;
    steward: string;
  };
  config: {
    timelockMinDelay: number;
    stewardActionDelay: number;
    totalSupply: string;
    treasuryAllocation: string;
  };
  timestamp: string;
}

export interface CrowdfundDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    armToken: string;
    usdc: string;
    crowdfund: string;
  };
  config: {
    baseSale: string;
    maxSale: string;
    minSale: string;
    armPrice: string;
    armFunded: string;
  };
  timestamp: string;
}

// ============================================================================
// Aggregated deployment state for a single environment
// ============================================================================

export interface ChainDeployments {
  cctp: CCTPDeployment | null;
  privacyPool: PrivacyPoolDeployment | null;
}

export interface HubDeployments extends ChainDeployments {
  yield: YieldDeployment | null;
  aaveMock: AaveMockDeployment | null;
  governance: GovernanceDeployment | null;
  crowdfund: CrowdfundDeployment | null;
}

export interface AllDeployments {
  env: DeployEnv;
  hub: HubDeployments;
  clientA: ChainDeployments;
  clientB: ChainDeployments;
}

// ============================================================================
// Loading
// ============================================================================

const DEPLOYMENTS_DIR = path.resolve(__dirname, "../../../deployments");

function loadJson<T>(filename: string): T | null {
  const filePath = path.join(DEPLOYMENTS_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function loadChainDeployments(role: ChainRole): ChainDeployments {
  return {
    cctp: loadJson<CCTPDeployment>(getCCTPDeploymentFile(role)),
    privacyPool: loadJson<PrivacyPoolDeployment>(
      getPrivacyPoolDeploymentFile(role)
    ),
  };
}

/**
 * Load all deployment artifacts for the current environment.
 * Environment is determined by DEPLOY_ENV (set before server starts).
 */
export function loadAllDeployments(env: DeployEnv): AllDeployments {
  const hubBase = loadChainDeployments("hub");
  return {
    env,
    hub: {
      ...hubBase,
      yield: loadJson<YieldDeployment>(getYieldDeploymentFile()),
      aaveMock: loadJson<AaveMockDeployment>(getAaveMockDeploymentFile("hub")),
      governance: loadJson<GovernanceDeployment>(getGovernanceDeploymentFile()),
      crowdfund: loadJson<CrowdfundDeployment>(getCrowdfundDeploymentFile()),
    },
    clientA: loadChainDeployments("clientA"),
    clientB: loadChainDeployments("clientB"),
  };
}

/**
 * List all deployment JSON files present in the deployments directory.
 */
export function listDeploymentFiles(): string[] {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) return [];
  return fs
    .readdirSync(DEPLOYMENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}
