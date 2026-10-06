// ABOUTME: Verify-deployment scope: Launch 1 runs skip the Launch 2 groups (SNARK keys, privacy pool,
// ABOUTME: yield/fee) and end with a Launch-1-specific verdict; standalone runs keep the full check set.
import { expect } from "chai";
import { LAUNCH2_GROUPS, resolveVerifyScope, verificationVerdict } from "../scripts/verify-scope";

describe("verify_deployment scope", function () {
  describe("resolveVerifyScope", function () {
    // WHY: a standalone run (and Launch 2) must keep checking every group, as before.
    it("defaults to the full check set", function () {
      expect(resolveVerifyScope({})).to.equal("full");
      expect(resolveVerifyScope({ VERIFY_SCOPE: "" })).to.equal("full");
    });

    // WHY: the Launch 1 orchestrator asks for its own scope explicitly.
    it("accepts launch1", function () {
      expect(resolveVerifyScope({ VERIFY_SCOPE: "launch1" })).to.equal("launch1");
    });

    // WHY: a typo must not silently fall back to a different set of checks.
    it("rejects an unknown scope", function () {
      expect(() => resolveVerifyScope({ VERIFY_SCOPE: "lauch1" })).to.throw(/VERIFY_SCOPE/);
    });
  });

  // WHY: these are the groups that depend on Launch 2 manifests. In a Launch 1 run they are
  // either absent (mainnet: "manifest not found" warnings) or stale (Sepolia: an older stack's
  // privacy pool compared against the fresh governance contracts, i.e. false failures).
  it("lists the Launch 2 groups", function () {
    expect(LAUNCH2_GROUPS).to.deep.equal(["SNARK Verification", "Privacy Pool Wiring", "Yield + Fee Wiring"]);
  });

  describe("verificationVerdict", function () {
    // WHY: any failure stops the launch announcement, whatever the scope.
    it("fails with exit code 1 on any failed check", function () {
      for (const scope of ["full", "launch1"] as const) {
        expect(verificationVerdict(scope, { passes: 50, warns: 0, fails: 1 }))
          .to.deep.equal({ exitCode: 1, message: "DEPLOYMENT VERIFICATION FAILED" });
      }
    });

    // WHY: a clean Launch 1 run should say exactly that, not "verified with warnings".
    it("reports a clean Launch 1 deploy plainly", function () {
      expect(verificationVerdict("launch1", { passes: 59, warns: 0, fails: 0 }))
        .to.deep.equal({ exitCode: 0, message: "LAUNCH 1 DEPLOYMENT VERIFIED" });
      expect(verificationVerdict("launch1", { passes: 59, warns: 1, fails: 0 }).message)
        .to.match(/Launch 1 deployment verified with 1 warning; review the WARN row/);
    });

    // WHY: the full scope keeps its existing wording for partial deployments.
    it("keeps the full-scope messages", function () {
      expect(verificationVerdict("full", { passes: 10, warns: 2, fails: 0 }).message)
        .to.equal("Deployment verified with warnings (may be expected for partial deployments)");
      expect(verificationVerdict("full", { passes: 10, warns: 0, fails: 0 }).message).to.equal("ALL CHECKS PASSED");
    });
  });
});
