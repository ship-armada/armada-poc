// ABOUTME: Unit tests for MCP server deployment loading, pool address resolution, and deployment state reporting.
// ABOUTME: Tests pure functions with real local deployment artifacts — no running chains required.

import { expect } from "chai";
import {
  loadAllDeployments,
  listDeploymentFiles,
  getPoolAddress,
  type PrivacyPoolDeployment,
} from "../src/lib/deployments";
import { getDeploymentState } from "../src/tools/deployment-state";

// These tests use the real deployment artifacts in deployments/.
// They require DEPLOY_ENV=local (the default) and that `npm run setup` has been
// run at least once to generate the deployment JSON files.

describe("MCP Server — Unit Tests", function () {
  // ========================================================================
  // getPoolAddress
  // ========================================================================

  describe("getPoolAddress", function () {
    it("returns privacyPool address for hub deployments", function () {
      const hubDeploy: PrivacyPoolDeployment = {
        chainId: 31337,
        domain: 100,
        deployer: "0xdeadbeef",
        contracts: {
          privacyPool: "0xAAAA",
          merkleModule: "0xBBBB",
          verifierModule: "0xCCCC",
          shieldModule: "0xDDDD",
          transactModule: "0xEEEE",
        },
        cctp: {
          tokenMessenger: "0x1111",
          messageTransmitter: "0x2222",
          usdc: "0x3333",
        },
        timestamp: "2026-01-01T00:00:00.000Z",
      };

      expect(getPoolAddress(hubDeploy)).to.equal("0xAAAA");
    });

    it("returns privacyPoolClient address for client deployments", function () {
      const clientDeploy: PrivacyPoolDeployment = {
        chainId: 31338,
        domain: 101,
        deployer: "0xdeadbeef",
        contracts: {
          privacyPoolClient: "0xFFFF",
          hookRouter: "0xABCD",
        },
        cctp: {
          tokenMessenger: "0x1111",
          messageTransmitter: "0x2222",
          usdc: "0x3333",
        },
        hub: {
          domain: 100,
          privacyPool: "0xAAAA",
        },
        timestamp: "2026-01-01T00:00:00.000Z",
      };

      expect(getPoolAddress(clientDeploy)).to.equal("0xFFFF");
    });

    it("returns null when neither key is present", function () {
      const emptyDeploy: PrivacyPoolDeployment = {
        chainId: 31337,
        domain: 100,
        deployer: "0xdeadbeef",
        contracts: {},
        cctp: {
          tokenMessenger: "0x1111",
          messageTransmitter: "0x2222",
          usdc: "0x3333",
        },
        timestamp: "2026-01-01T00:00:00.000Z",
      };

      expect(getPoolAddress(emptyDeploy)).to.be.null;
    });

    it("prefers privacyPool over privacyPoolClient when both exist", function () {
      const bothDeploy: PrivacyPoolDeployment = {
        chainId: 31337,
        domain: 100,
        deployer: "0xdeadbeef",
        contracts: {
          privacyPool: "0xAAAA",
          privacyPoolClient: "0xBBBB",
        },
        cctp: {
          tokenMessenger: "0x1111",
          messageTransmitter: "0x2222",
          usdc: "0x3333",
        },
        timestamp: "2026-01-01T00:00:00.000Z",
      };

      expect(getPoolAddress(bothDeploy)).to.equal("0xAAAA");
    });
  });

  // ========================================================================
  // listDeploymentFiles
  // ========================================================================

  describe("listDeploymentFiles", function () {
    it("returns a sorted list of JSON files", function () {
      const files = listDeploymentFiles();
      expect(files).to.be.an("array");
      expect(files.length).to.be.greaterThan(0);
      for (const f of files) {
        expect(f).to.match(/\.json$/);
      }
      // Verify sorted
      const sorted = [...files].sort();
      expect(files).to.deep.equal(sorted);
    });
  });

  // ========================================================================
  // loadAllDeployments
  // ========================================================================

  describe("loadAllDeployments", function () {
    it("loads hub, clientA, and clientB deployment data", function () {
      const deployments = loadAllDeployments("local");
      expect(deployments.env).to.equal("local");

      // Hub should have CCTP and privacy pool at minimum
      expect(deployments.hub.cctp).to.not.be.null;
      expect(deployments.hub.privacyPool).to.not.be.null;

      // Client A should have CCTP and privacy pool
      expect(deployments.clientA.cctp).to.not.be.null;
      expect(deployments.clientA.privacyPool).to.not.be.null;

      // Client B should have CCTP and privacy pool
      expect(deployments.clientB.cctp).to.not.be.null;
      expect(deployments.clientB.privacyPool).to.not.be.null;
    });

    it("hub deployment has privacyPool key in contracts", function () {
      const deployments = loadAllDeployments("local");
      expect(deployments.hub.privacyPool!.contracts.privacyPool).to.be.a("string");
    });

    it("client deployment has privacyPoolClient key in contracts", function () {
      const deployments = loadAllDeployments("local");
      expect(deployments.clientA.privacyPool!.contracts.privacyPoolClient).to.be.a("string");
    });

    it("getPoolAddress works correctly for loaded hub deployment", function () {
      const deployments = loadAllDeployments("local");
      const hubAddr = getPoolAddress(deployments.hub.privacyPool!);
      expect(hubAddr).to.be.a("string");
      expect(hubAddr).to.match(/^0x[0-9a-fA-F]{40}$/);
    });

    it("getPoolAddress works correctly for loaded client deployment", function () {
      const deployments = loadAllDeployments("local");
      const clientAddr = getPoolAddress(deployments.clientA.privacyPool!);
      expect(clientAddr).to.be.a("string");
      expect(clientAddr).to.match(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  // ========================================================================
  // getDeploymentState
  // ========================================================================

  describe("getDeploymentState", function () {
    it("returns a report with env, files, hub, clientA, clientB, and issues", function () {
      const report = getDeploymentState("local");
      expect(report.env).to.equal("local");
      expect(report.files).to.be.an("array");
      expect(report.hub).to.be.an("object");
      expect(report.clientA).to.be.an("object");
      expect(report.clientB).to.be.an("object");
      expect(report.issues).to.be.an("array");
    });

    it("reports hub components as deployed when artifacts exist", function () {
      const report = getDeploymentState("local");
      expect(report.hub.cctp.deployed).to.be.true;
      expect(report.hub.privacyPool.deployed).to.be.true;
    });

    it("reports client components as deployed when artifacts exist", function () {
      const report = getDeploymentState("local");
      expect(report.clientA.cctp.deployed).to.be.true;
      expect(report.clientA.privacyPool.deployed).to.be.true;
    });

    it("does not report USDC cross-reference errors for consistent deployments", function () {
      const report = getDeploymentState("local");
      const usdcErrors = report.issues.filter(
        (i) => i.severity === "error" && i.message.includes("USDC")
      );
      expect(usdcErrors).to.have.length(0);
    });
  });
});
