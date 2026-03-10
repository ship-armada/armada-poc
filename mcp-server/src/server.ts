// ABOUTME: MCP server entry point for the Armada development tooling.
// ABOUTME: Exposes read-only tools for deployment inspection, chain health, and contract state queries.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDeploymentState } from "./tools/deployment-state";
import { getChainHealth } from "./tools/chain-health";
import { getContractState } from "./tools/contract-state";
import { type DeployEnv } from "../../config/networks";

const ENV = (process.env.DEPLOY_ENV || "local") as DeployEnv;

const server = new McpServer({
  name: "armada",
  version: "0.1.0",
});

// ============================================================================
// Tool: get_deployment_state
// ============================================================================

server.tool(
  "get_deployment_state",
  "Inspect deployment artifacts for all chains. Reports contract addresses, missing deployments, and cross-reference issues (e.g., USDC address mismatches between pool and CCTP configs).",
  {
    env: z
      .enum(["local", "sepolia"])
      .optional()
      .describe("Environment to inspect (defaults to DEPLOY_ENV)"),
  },
  async ({ env }) => {
    const targetEnv = env ?? ENV;
    const report = getDeploymentState(targetEnv);
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  }
);

// ============================================================================
// Tool: get_chain_health
// ============================================================================

server.tool(
  "get_chain_health",
  "Check RPC connectivity, block numbers, chain IDs, deployer balances, and whether key contracts (USDC, PrivacyPool) have code deployed. Runs checks in parallel across chains.",
  {
    chains: z
      .array(z.enum(["hub", "clientA", "clientB"]))
      .optional()
      .describe("Chains to check (defaults to all three)"),
  },
  async ({ chains }) => {
    const roles = chains ?? ["hub", "clientA", "clientB"];
    const report = await getChainHealth(ENV, roles as any);
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  }
);

// ============================================================================
// Tool: get_contract_state
// ============================================================================

server.tool(
  "get_contract_state",
  "Query live on-chain state for a contract component. Returns view function results: pool merkle root/leaf count/testing mode, governance thresholds/balances, yield vault assets/shares, crowdfund status/raised amount.",
  {
    component: z
      .enum(["privacy-pool", "governance", "yield", "crowdfund"])
      .describe("Which contract component to query"),
    chain: z
      .enum(["hub", "clientA", "clientB"])
      .optional()
      .describe("Chain to query (defaults to hub, only relevant for privacy-pool)"),
  },
  async ({ component, chain }) => {
    const role = chain ?? "hub";
    const result = await getContractState(ENV, component as any, role as any);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================================
// Start
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running and listening on stdin/stdout
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
