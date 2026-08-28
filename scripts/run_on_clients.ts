// ABOUTME: Runs a hardhat script against every configured client chain, in order — the N-client
// ABOUTME: local-deploy helper backing the deploy:*:clients npm scripts.

import { execSync } from "child_process";
import { getNetworkConfig } from "../config/networks";

const script = process.argv[2];
if (!script) {
  console.error("Usage: ts-node scripts/run_on_clients.ts <hardhat-script-path>");
  process.exit(1);
}

const config = getNetworkConfig();
for (const client of config.clients) {
  const cmd = `npx hardhat run ${script} --network ${client.hardhatNetwork}`;
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
  } catch {
    console.error(`\nFailed running ${script} on ${client.name} (${client.hardhatNetwork})`);
    process.exit(1);
  }
}
