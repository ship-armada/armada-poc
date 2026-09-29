// ABOUTME: Runs the pre-commit secrets check against fixture files.
// ABOUTME: Deployment manifests may carry public tx hashes; other files stay fully scanned.
import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
// Synthetic 32-byte value, built at runtime so this file itself carries no key-shaped literal.
const TX_HASH = "0x" + "ab".repeat(32);
const MANIFEST = JSON.stringify({ revenueLockDeploymentTransaction: TX_HASH }, null, 2);

function checkSecrets(file: string) {
  return spawnSync("./scripts/check-secrets.sh", [file], { cwd: ROOT, encoding: "utf8" });
}

describe("Pre-commit secrets check", function () {
  // WHY: Governance manifests record creation tx hashes (32-byte hex, the same shape as a
  // private key). Committed Sepolia manifests must not be blocked by the pre-commit hook.
  it("allows public transaction hashes in deployment manifests", function () {
    const relative = path.join("deployments", "check-secrets-fixture.json");
    fs.writeFileSync(path.join(ROOT, relative), MANIFEST);
    try {
      const result = checkSecrets(relative);
      expect(result.status).to.equal(0);
      expect(result.stdout).to.equal("");
    } finally {
      fs.unlinkSync(path.join(ROOT, relative));
    }
  });

  // WHY: The manifest exemption must not weaken the check for any other file.
  it("still flags the same 32-byte hex outside deployment manifests", function () {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "check-secrets-")), "config.json");
    fs.writeFileSync(file, MANIFEST);
    try {
      const result = checkSecrets(file);
      expect(result.status).to.equal(1);
      expect(result.stdout).to.contain("Private key (hex)");
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true });
    }
  });
});
