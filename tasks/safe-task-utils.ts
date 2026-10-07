// ABOUTME: Shared helpers for the Hardhat tasks that write Safe Transaction Builder files.
// ABOUTME: Fresh per-run output folders and plain reporting of expected refusals.
import { HardhatPluginError } from "hardhat/plugins";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

/** A fresh output directory per run, so files from different runs never mix. */
export function createRunDir(out: string, kind: string): string {
  const dir = path.resolve(out, `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}`);
  if (fs.existsSync(dir)) throw new Error(`Output directory already exists: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Refusals (bad CSV, failed checks) are expected outcomes: report them as plugin errors so
 * Hardhat prints the message plainly instead of "An unexpected error occurred" with a stack.
 */
export function reported<A>(taskName: string, action: (args: A, hre: HardhatRuntimeEnvironment) => Promise<unknown>) {
  return async (args: A, hre: HardhatRuntimeEnvironment) => {
    try {
      return await action(args, hre);
    } catch (error) {
      throw new HardhatPluginError(taskName, (error as Error).message, error as Error);
    }
  };
}
