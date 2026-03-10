// ABOUTME: Integration tests for MCP server chain-health and contract-state tools.
// ABOUTME: Requires running Anvil chains (`npm run chains`) and deployed contracts (`npm run setup`).

import { expect } from "chai";
import { getChainHealth } from "../src/tools/chain-health";
import { getContractState } from "../src/tools/contract-state";

describe("MCP Server — Integration Tests (requires running chains)", function () {
  // RPC calls can be slow
  this.timeout(15_000);

  // ========================================================================
  // Chain Health
  // ========================================================================

  describe("getChainHealth", function () {
    it("returns health reports for all three chains", async function () {
      const reports = await getChainHealth("local");
      expect(reports).to.have.length(3);

      for (const report of reports) {
        expect(report.role).to.be.oneOf(["hub", "clientA", "clientB"]);
        expect(report.rpc).to.be.a("string");
      }
    });

    it("reports chains as reachable when Anvil is running", async function () {
      const reports = await getChainHealth("local");
      for (const report of reports) {
        expect(report.reachable).to.be.true;
        expect(report.blockNumber).to.be.a("number");
      }
    });

    it("returns correct chain IDs", async function () {
      const reports = await getChainHealth("local");
      for (const report of reports) {
        expect(report.chainId.match).to.be.true;
        expect(report.chainId.actual).to.equal(report.chainId.expected);
      }
    });

    it("detects deployed USDC contracts", async function () {
      const reports = await getChainHealth("local");
      for (const report of reports) {
        expect(report.contracts.usdc.address).to.be.a("string");
        expect(report.contracts.usdc.deployed).to.be.true;
      }
    });

    it("detects deployed privacy pool contracts (hub and clients)", async function () {
      const reports = await getChainHealth("local");
      for (const report of reports) {
        expect(report.contracts.privacyPool.address).to.be.a("string");
        expect(report.contracts.privacyPool.deployed).to.be.true;
      }
    });

    it("reports deployer balances", async function () {
      const reports = await getChainHealth("local");
      for (const report of reports) {
        expect(report.deployerBalance).to.be.a("string");
        // Anvil default accounts have ~10000 ETH
        expect(parseFloat(report.deployerBalance!)).to.be.greaterThan(0);
      }
    });

    it("works for a single chain", async function () {
      const reports = await getChainHealth("local", ["hub"]);
      expect(reports).to.have.length(1);
      expect(reports[0].role).to.equal("hub");
    });
  });

  // ========================================================================
  // Contract State — Privacy Pool
  // ========================================================================

  describe("getContractState — privacy-pool", function () {
    it("returns pool state for hub", async function () {
      const result = await getContractState("local", "privacy-pool", "hub");
      expect(result.error).to.be.undefined;
      expect(result.address).to.be.a("string");
      expect(result).to.have.property("testingMode");
      expect(result).to.have.property("merkleRoot");
      expect(result).to.have.property("nextLeafIndex");
      expect(result).to.have.property("usdcBalance");
      expect(result).to.have.property("modules");
    });

    it("returns pool state for clientA", async function () {
      const result = await getContractState("local", "privacy-pool", "clientA");
      expect(result.error).to.be.undefined;
      expect(result.address).to.be.a("string");
    });

    it("returns pool state for clientB", async function () {
      const result = await getContractState("local", "privacy-pool", "clientB");
      expect(result.error).to.be.undefined;
      expect(result.address).to.be.a("string");
    });
  });

  // ========================================================================
  // Contract State — Governance
  // ========================================================================

  describe("getContractState — governance", function () {
    it("returns governance state", async function () {
      const result = await getContractState("local", "governance");
      expect(result.error).to.be.undefined;
      expect(result).to.have.property("addresses");
      expect(result).to.have.property("armTotalSupply");
      expect(result).to.have.property("proposalThreshold");
      expect(result).to.have.property("proposalTypes");
      expect(result).to.have.property("timelockDelay");
    });
  });

  // ========================================================================
  // Contract State — Yield
  // ========================================================================

  describe("getContractState — yield", function () {
    it("returns yield state", async function () {
      const result = await getContractState("local", "yield");
      expect(result.error).to.be.undefined;
      expect(result).to.have.property("addresses");
      expect(result).to.have.property("vault");
      expect(result).to.have.property("treasuryUsdcBalance");
      expect(result).to.have.property("config");
    });
  });

  // ========================================================================
  // Contract State — Crowdfund
  // ========================================================================

  describe("getContractState — crowdfund", function () {
    it("returns crowdfund state", async function () {
      const result = await getContractState("local", "crowdfund");
      expect(result.error).to.be.undefined;
      expect(result).to.have.property("address");
      expect(result).to.have.property("totalCommitted");
      expect(result).to.have.property("phase");
      expect(result).to.have.property("saleLimits");
    });
  });
});
