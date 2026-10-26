// ABOUTME: Checks the ARMADA_CIRCUITS_DIR override for the circuit artifact location.
// ABOUTME: Covers the SDK artifact loader and scripts/fetch-circuits.sh (offline, via its stamp file).
import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { circuitsBuildDir, getArtifact } from "../lib/sdk/armada-artifacts";

const ROOT = path.join(__dirname, "..");
const FETCH_SCRIPT = path.join(ROOT, "scripts", "fetch-circuits.sh");

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "armada-circuits-dir-"));
}

/** Writes the stamp fetch-circuits.sh checks, so the script exits before any download. */
function stampFetched(buildDir: string): void {
  const script = fs.readFileSync(FETCH_SCRIPT, "utf8");
  const tag = script.match(/^CIRCUITS_TAG="([^"]+)"/m)![1];
  const sha = script.match(/^TARBALL_SHA256="([^"]+)"/m)![1];
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, `.fetched-${tag}`), `${sha}\n`);
}

/** Writes placeholder artifacts for one shape; the vkey records which root it came from. */
function writeFakeShape(root: string, shape: string): void {
  const shapeDir = path.join(root, "build", shape);
  fs.mkdirSync(path.join(shapeDir, `main_${shape}_js`), { recursive: true });
  fs.writeFileSync(path.join(shapeDir, `main_${shape}_js`, `main_${shape}.wasm`), "fake-wasm");
  fs.writeFileSync(path.join(shapeDir, "final.zkey"), "fake-zkey");
  fs.writeFileSync(path.join(shapeDir, "vkey.json"), JSON.stringify({ marker: root }));
}

function runFetch(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(FETCH_SCRIPT, args, { cwd: ROOT, encoding: "utf8", env });
}

describe("ARMADA_CIRCUITS_DIR override", function () {
  const saved = process.env.ARMADA_CIRCUITS_DIR;
  let tmp: string;

  beforeEach(function () {
    tmp = makeTempDir();
  });

  afterEach(function () {
    if (saved === undefined) delete process.env.ARMADA_CIRCUITS_DIR;
    else process.env.ARMADA_CIRCUITS_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("SDK artifact loader", function () {
    // WHY: Without the override every checkout must keep armada-circuits next to the repo.
    it("defaults to <repo-parent>/armada-circuits/build", function () {
      delete process.env.ARMADA_CIRCUITS_DIR;
      expect(circuitsBuildDir()).to.equal(path.resolve(ROOT, "..", "armada-circuits", "build"));
    });

    it("uses $ARMADA_CIRCUITS_DIR/build when the override is set", function () {
      process.env.ARMADA_CIRCUITS_DIR = tmp;
      expect(circuitsBuildDir()).to.equal(path.join(tmp, "build"));
    });

    it("loads artifacts from the overridden location", function () {
      const root = path.join(tmp, "populated");
      writeFakeShape(root, "1x1");
      process.env.ARMADA_CIRCUITS_DIR = root;

      const artifact = getArtifact(1, 1);
      expect(Buffer.from(artifact.zkey).toString()).to.equal("fake-zkey");
      expect(artifact.vkey).to.deep.equal({ marker: root });
    });

    // WHY: Artifacts are cached per shape. A cache hit from another location must not
    // mask the override, or the wrong verifying keys would be served.
    it("does not serve artifacts cached from a different location", function () {
      const populated = path.join(tmp, "populated");
      writeFakeShape(populated, "1x1");
      process.env.ARMADA_CIRCUITS_DIR = populated;
      getArtifact(1, 1);

      const empty = path.join(tmp, "empty");
      process.env.ARMADA_CIRCUITS_DIR = empty;
      expect(() => getArtifact(1, 1)).to.throw(path.join(empty, "build", "1x1", "final.zkey"));
    });
  });

  describe("scripts/fetch-circuits.sh", function () {
    it("installs into $ARMADA_CIRCUITS_DIR/build when the override is set", function () {
      const buildDir = path.join(tmp, "build");
      stampFetched(buildDir);
      const result = runFetch([], { ...process.env, ARMADA_CIRCUITS_DIR: tmp });
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.contain(`already present at ${buildDir}`);
    });

    it("lets an explicit destination argument win over the override", function () {
      const explicit = path.join(tmp, "explicit");
      stampFetched(explicit);
      const result = runFetch([explicit], { ...process.env, ARMADA_CIRCUITS_DIR: path.join(tmp, "unused") });
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.contain(`already present at ${explicit}`);
    });
  });
});
