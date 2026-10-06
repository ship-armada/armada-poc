// ABOUTME: Scope for verify_deployment.ts: "launch1" (set by the Launch 1 orchestrator) skips the Launch 2
// ABOUTME: groups and ends with a Launch-1-specific verdict; "full" (default) checks every group.

export type VerifyScope = "full" | "launch1";

/**
 * Groups that check Launch 2 components. In a Launch 1 run their manifests are absent (mainnet)
 * or belong to an older stack (Sepolia), so checking them only produces warnings or false failures.
 */
export const LAUNCH2_GROUPS = ["SNARK Verification", "Privacy Pool Wiring", "Yield + Fee Wiring"];

/** VERIFY_SCOPE: unset or empty = full, "launch1" = Launch 1 only. */
export function resolveVerifyScope(env: NodeJS.ProcessEnv): VerifyScope {
  const scope = env.VERIFY_SCOPE?.trim() ?? "";
  if (scope === "") return "full";
  if (scope === "launch1") return "launch1";
  throw new Error(`VERIFY_SCOPE must be "launch1" or unset, got "${scope}"`);
}

/** The closing line and exit code for a verification run. */
export function verificationVerdict(
  scope: VerifyScope,
  counts: { passes: number; warns: number; fails: number },
): { exitCode: number; message: string } {
  if (counts.fails > 0) return { exitCode: 1, message: "DEPLOYMENT VERIFICATION FAILED" };
  if (scope === "launch1") {
    return counts.warns > 0
      ? {
        exitCode: 0,
        message: `Launch 1 deployment verified with ${counts.warns} warning${counts.warns === 1 ? "" : "s"}; ` +
          `review the WARN row${counts.warns === 1 ? "" : "s"} above`,
      }
      : { exitCode: 0, message: "LAUNCH 1 DEPLOYMENT VERIFIED" };
  }
  return counts.warns > 0
    ? { exitCode: 0, message: "Deployment verified with warnings (may be expected for partial deployments)" }
    : { exitCode: 0, message: "ALL CHECKS PASSED" };
}
