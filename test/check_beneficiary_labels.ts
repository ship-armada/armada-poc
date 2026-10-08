// ABOUTME: Runs the pre-commit beneficiary-label check and the full hook in throwaway git repos.
// ABOUTME: Mainnet beneficiary lists may only be committed with neutral labels; names never.
import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const CHECK = path.join(ROOT, "scripts", "check-beneficiary-labels.sh");
const MAINNET_FILE = path.join("config", "revenue-lock-beneficiaries-mainnet.json");
// A made-up name standing in for a real beneficiary label.
const NAME = "Alice Example";

// Synthetic addresses, built at runtime so this file carries no address-shaped literal.
function beneficiaries(labels: string[]): string {
  const list = labels.map((label, i) => ({
    address: "0x" + (i + 1).toString(16).padStart(2, "0").repeat(20),
    amount: "1000",
    label,
  }));
  return JSON.stringify(list, null, 2) + "\n";
}

function neutral(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `beneficiary ${String(i + 1).padStart(3, "0")}`);
}

function git(repo: string, ...args: string[]) {
  return spawnSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, encoding: "utf8" }
  );
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "check-beneficiary-labels-"));
  git(repo, "init", "-q");
  return repo;
}

function writeAndStage(repo: string, relative: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), content);
  git(repo, "add", relative);
}

function check(repo: string, ...files: string[]) {
  return spawnSync(CHECK, files, { cwd: repo, encoding: "utf8" });
}

describe("Pre-commit beneficiary label check", function () {
  let repo: string;

  beforeEach(function () {
    repo = makeRepo();
  });

  afterEach(function () {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  // WHY: control case — the deploy file itself must stay committable, or the rule blocks the
  // launch config along with the names.
  it("allows a mainnet list with neutral labels", function () {
    writeAndStage(repo, MAINNET_FILE, beneficiaries(neutral(3)));
    const result = check(repo, MAINNET_FILE);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("");
  });

  // WHY: a label ties a public address to a person; committing it to a public repo is a
  // privacy breach that cannot be undone.
  it("blocks a mainnet list with a name label and reports only the entry number", function () {
    writeAndStage(repo, MAINNET_FILE, beneficiaries(["beneficiary 001", NAME, "beneficiary 003"]));
    const result = check(repo, MAINNET_FILE);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.contain("non-neutral label in entries 2");
    // WHY: the hook's own output lands in terminals and CI logs, so it must not echo the name.
    expect(result.stdout + result.stderr).to.not.contain("Alice");
  });

  // WHY: an entry without a neutral label is not known to be safe; the check must fail closed.
  it("blocks a missing label", function () {
    const list = JSON.parse(beneficiaries(neutral(2)));
    delete list[1].label;
    writeAndStage(repo, MAINNET_FILE, JSON.stringify(list));
    const result = check(repo, MAINNET_FILE);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.contain("non-neutral label in entries 2");
  });

  // WHY: a hook that skips content it cannot parse would let the named list through.
  it("blocks a mainnet list that is not a JSON array", function () {
    writeAndStage(repo, MAINNET_FILE, `${NAME}\n`);
    expect(check(repo, MAINNET_FILE).stdout).to.contain("not valid JSON");
    writeAndStage(repo, MAINNET_FILE, JSON.stringify({ label: NAME }));
    expect(check(repo, MAINNET_FILE).stdout).to.contain("not a JSON array");
  });

  // WHY: git commits the index, so a neutral working-tree copy must not hide a named staged one.
  it("checks the staged copy, not the working tree", function () {
    writeAndStage(repo, MAINNET_FILE, beneficiaries([NAME]));
    fs.writeFileSync(path.join(repo, MAINNET_FILE), beneficiaries(neutral(1)));
    const result = check(repo, MAINNET_FILE);
    expect(result.status).to.equal(1);
  });

  // WHY: the named original is kept as *.named.json; a copy that drifts back into the repo must
  // be refused even where the mainnet filename rule would not look at it.
  it("blocks any *.named.json file whatever its content", function () {
    const named = path.join("notes", "list.named.json");
    writeAndStage(repo, named, beneficiaries(neutral(1)));
    const result = check(repo, named);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.contain("must never be committed");
  });

  // WHY: the committed Sepolia fixtures carry test labels; they are not mainnet lists.
  it("ignores beneficiary lists for other networks", function () {
    const sepolia = path.join("config", "revenue-lock-beneficiaries-sepolia.json");
    writeAndStage(repo, sepolia, beneficiaries(["test beneficiary1"]));
    const result = check(repo, sepolia);
    expect(result.status).to.equal(0);
  });
});

describe("Pre-commit hook refuses a named beneficiary list", function () {
  let repo: string;

  beforeEach(function () {
    repo = makeRepo();
    // Install the repo's real hook and the check scripts it calls.
    fs.mkdirSync(path.join(repo, ".githooks"));
    fs.copyFileSync(path.join(ROOT, ".githooks", "pre-commit"), path.join(repo, ".githooks", "pre-commit"));
    fs.mkdirSync(path.join(repo, "scripts"));
    for (const script of ["check-anvil-addresses.sh", "check-secrets.sh", "check-beneficiary-labels.sh"]) {
      fs.copyFileSync(path.join(ROOT, "scripts", script), path.join(repo, "scripts", script));
    }
    git(repo, "config", "core.hooksPath", ".githooks");
  });

  afterEach(function () {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function committedFiles(): string {
    return git(repo, "log", "--all", "--name-only", "--format=").stdout;
  }

  // WHY: control case — the real hook must let a neutral list through, so the refusals below are
  // attributable to the labels alone.
  it("commits a neutral list", function () {
    writeAndStage(repo, MAINNET_FILE, beneficiaries(neutral(2)));
    const result = git(repo, "commit", "-q", "-m", "neutral list");
    expect(result.status).to.equal(0);
    expect(committedFiles()).to.contain(MAINNET_FILE);
  });

  // WHY: .gitignore stops a plain `git add`, but `git add -f` bypasses it; the hook is the
  // backstop.
  it("refuses a named list, even when force-added past .gitignore", function () {
    fs.writeFileSync(path.join(repo, ".gitignore"), `${MAINNET_FILE}\n`);
    fs.mkdirSync(path.join(repo, "config"));
    fs.writeFileSync(path.join(repo, MAINNET_FILE), beneficiaries([NAME]));
    git(repo, "add", "-f", MAINNET_FILE);
    const result = git(repo, "commit", "-q", "-m", "named list");
    expect(result.status).to.not.equal(0);
    // git passes hook output through on stderr.
    expect(result.stderr).to.contain("non-neutral label in entries 1");
    expect(committedFiles()).to.not.contain(MAINNET_FILE);
  });

  // WHY: git reports a new file that resembles a deleted one as a rename; the hook must still
  // check it, or deleting a similar file would let a named list through unchecked.
  it("refuses a named list that git records as a rename", function () {
    const other = path.join("config", "other-list.json");
    const labels = neutral(40);
    writeAndStage(repo, other, beneficiaries(labels));
    expect(git(repo, "commit", "-q", "-m", "other list").status).to.equal(0);

    git(repo, "rm", "-q", other);
    labels[0] = NAME;
    writeAndStage(repo, MAINNET_FILE, beneficiaries(labels));
    expect(git(repo, "diff", "--cached", "--name-status").stdout).to.match(/^R\d+/);

    const result = git(repo, "commit", "-q", "-m", "renamed list");
    expect(result.status).to.not.equal(0);
    expect(committedFiles()).to.not.contain(MAINNET_FILE);
  });
});
