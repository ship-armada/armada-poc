// ABOUTME: Unit tests for the crowdfund model's scenario helpers: amount parsing/formatting, self-fill,
// ABOUTME: validation warnings, and scenario CSV import/export.

import { expect } from "chai";
import { loadModel } from "./loadModel";

const { scenario } = loadModel();

const U = (dollars: number) => BigInt(dollars) * 1_000_000n;

function row(over: Partial<{ name: string; include: boolean; commits: string[]; invites: number[] }> = {}) {
  return { ...scenario.emptyRow(), ...over };
}

describe("crowdfund model scenario — amounts", function () {
  // WHY: amounts must reach the engine as exact integers; float parsing would break contract
  //      parity.
  it("parses dollar strings to exact 6-decimal USDC units", function () {
    expect(scenario.parseUsdc("15000")).to.equal(U(15_000));
    expect(scenario.parseUsdc(" $15,000.50 ")).to.equal(15_000_500_000n);
    expect(scenario.parseUsdc("0.000001")).to.equal(1n);
    expect(scenario.parseUsdc("")).to.equal(0n);
  });

  // WHY: USDC has 6 decimals; silently truncating extra precision or bad text would model a commit
  //      nobody can make.
  it("rejects malformed or over-precise amounts", function () {
    expect(scenario.parseUsdc("1.0000001")).to.equal(null);
    expect(scenario.parseUsdc("abc")).to.equal(null);
    expect(scenario.parseUsdc("-5")).to.equal(null);
    expect(scenario.parseUsdc("1.2.3")).to.equal(null);
  });

  // WHY: display rounds down like the contract, so a shown amount never overstates what a
  //      participant gets.
  it("formats USDC and ARM rounding down to cents", function () {
    expect(scenario.formatUsdc(14_076_539_101n)).to.equal("$14,076.53");
    expect(scenario.formatUsdc(0n)).to.equal("$0.00");
    expect(scenario.formatArm(14_076_539_101n * 10n ** 12n)).to.equal("14,076.53");
  });

  // WHY: exports are the audit trail; they must carry every base unit.
  it("formats exact USDC amounts for CSV without losing precision", function () {
    expect(scenario.formatUsdcExact(14_076_539_101n)).to.equal("14076.539101");
    expect(scenario.formatUsdcExact(U(15_000))).to.equal("15000");
  });
});

describe("crowdfund model scenario — rowToParticipant", function () {
  // WHY: the row → engine boundary is where typed text becomes contract inputs.
  it("converts input strings to an engine participant", function () {
    const r = scenario.rowToParticipant(row({ commits: ["15000", "", "6,000"], invites: [1, 3, 6] }));
    expect(r.errors).to.deep.equal([]);
    expect(r.participant.commits).to.deep.equal([U(15_000), 0n, U(6_000)]);
    expect(r.participant.invitesReceived).to.deep.equal([1, 3, 6]);
  });

  // WHY: a typo must be reported, not crash the model or count as a commit.
  it("reports unparseable amounts and treats them as zero", function () {
    const r = scenario.rowToParticipant(row({ commits: ["lots", "", ""] }));
    expect(r.participant.commits[0]).to.equal(0n);
    expect(r.errors).to.have.length(1);
    expect(r.errors[0].hop).to.equal(0);
  });
});

describe("crowdfund model scenario — selfFill", function () {
  // WHY: participants plan to self-invite their whole tree: 15k + 3 × 4k + 6 × 1k.
  it("fills a blank row as a seed to the $33k self-invite maximum", function () {
    const r = scenario.selfFill(row());
    expect(r.commits).to.deep.equal(["15000", "12000", "6000"]);
    expect(r.invites).to.deep.equal([1, 3, 6]);
  });

  // WHY: a hop-1 invitee can only self-invite into hop-2; hop-0 must stay untouched.
  it("fills from the row's lowest committed hop downward", function () {
    const r = scenario.selfFill(row({ commits: ["", "100", ""], invites: [1, 2, 1] }));
    expect(r.commits).to.deep.equal(["", "8000", "4000"]);
    expect(r.invites).to.deep.equal([1, 2, 4]);
  });

  // WHY: invites received from others stack with self-invites; a hop-1 node with 5 invites
  //      has 10 outgoing hop-2 invites to spend on itself.
  it("keeps stacked invites and spends the larger outgoing budget", function () {
    const r = scenario.selfFill(row({ commits: ["15000", "", ""], invites: [1, 5, 1] }));
    expect(r.invites).to.deep.equal([1, 5, 10]);
    expect(r.commits).to.deep.equal(["15000", "20000", "10000"]);
  });

  // WHY: hop-2 stacking stops at 20 even with a larger outgoing budget; pressing self-fill twice
  //      must not change anything.
  it("caps hop-2 invites at the contract maximum and is idempotent", function () {
    const once = scenario.selfFill(row({ commits: ["15000", "", ""], invites: [1, 10, 1] }));
    expect(once.invites).to.deep.equal([1, 10, 20]);
    expect(scenario.selfFill(once)).to.deep.equal(once);
  });
});

describe("crowdfund model scenario — validate", function () {
  const issuesFor = (rows: any[]) => scenario.validate(rows);

  // WHY: the common case must not raise noise.
  it("returns no issues for a clean self-filled row", function () {
    expect(issuesFor([scenario.selfFill(row())])).to.deep.equal([]);
  });

  // WHY: the contract rejects commits under MIN_COMMIT, so such a row can never happen on-chain.
  it("flags commits below the $10 minimum as errors", function () {
    const issues = issuesFor([row({ commits: ["5", "", ""] })]);
    expect(issues).to.have.length(1);
    expect(issues[0]).to.include({ level: "error", row: 0, hop: 0 });
  });

  // WHY: over-cap commits are legal but partly refunded; the team should see how much.
  it("flags over-cap commits as info", function () {
    const issues = issuesFor([row({ commits: ["20000", "", ""] })]);
    expect(issues).to.have.length(1);
    expect(issues[0]).to.include({ level: "info", row: 0, hop: 0 });
  });

  // WHY: invitesReceived above the stacking cap is impossible on-chain and would inflate the
  //      modeled cap.
  it("flags invite counts outside the per-hop limits", function () {
    const issues = issuesFor([row({ commits: ["", "100", "100"], invites: [1, 11, 21] })]);
    expect(issues.filter((i: any) => i.level === "error").map((i: any) => i.hop)).to.deep.equal([1, 2]);
  });

  // WHY: excluded "maybe" rows must not produce issues for commits that are not being modeled.
  it("ignores excluded rows", function () {
    expect(issuesFor([row({ include: false, commits: ["5", "", ""] })])).to.deep.equal([]);
  });

  // WHY: hop-1 invites come from seeds (3 each) plus the launch team's 100; one seed listed
  //      means at most 103 hop-1 invites can exist among the listed participants.
  it("warns when listed hop-1 invites exceed what seeds and the launch team can issue", function () {
    const rows = [row({ commits: ["15000", "", ""] }), ...Array.from({ length: 104 }, () => row({ commits: ["", "100", ""] }))];
    const issues = issuesFor(rows);
    expect(issues).to.have.length(1);
    expect(issues[0]).to.include({ level: "warning", row: null, hop: 1 });
  });

  // WHY: hop-2 invites come from hop-1 nodes (2 per invite received) plus the launch team's
  //      120; one listed hop-1 node caps the listed hop-2 invites at 122.
  it("warns when listed hop-2 invites exceed what hop-1 nodes and the launch team can issue", function () {
    const rows = [row({ commits: ["", "100", ""] }), ...Array.from({ length: 123 }, () => row({ commits: ["", "", "100"] }))];
    const issues = issuesFor(rows);
    expect(issues).to.have.length(1);
    expect(issues[0]).to.include({ level: "warning", row: null, hop: 2 });
  });

  // WHY: the contract hard-caps seeds at 180.
  it("errors when more than MAX_SEEDS hop-0 participants are listed", function () {
    const rows = Array.from({ length: 181 }, () => row({ commits: ["100", "", ""] }));
    const issues = issuesFor(rows);
    expect(issues).to.have.length(1);
    expect(issues[0]).to.include({ level: "error", row: null, hop: 0 });
  });
});

describe("crowdfund model scenario — CSV", function () {
  // WHY: scenarios move between teammates as CSV; names are free text.
  it("round-trips a scenario including names with commas and quotes", function () {
    const rows = [
      row({ name: 'Alice "A", Ltd', commits: ["15000", "12000", "6000"], invites: [1, 3, 6] }),
      row({ name: "Bob", include: false, commits: ["", "4000", ""], invites: [1, 1, 1] }),
    ];
    const parsed = scenario.scenarioFromCsv(scenario.scenarioToCsv(rows));
    expect(parsed.errors).to.deep.equal([]);
    expect(parsed.rows).to.deep.equal(rows);
  });

  // WHY: importing the wrong file (e.g. a results export) must fail loudly instead of loading
  //      garbage.
  it("rejects a CSV without the expected header", function () {
    const parsed = scenario.scenarioFromCsv("foo,bar\n1,2\n");
    expect(parsed.rows).to.deep.equal([]);
    expect(parsed.errors).to.have.length(1);
  });

  // WHY: results rows must line up with the included participants only.
  it("exports per-participant results for the included rows", function () {
    const rows = [row({ name: "Alice", commits: ["20000", "", ""] }), row({ name: "Bob", include: false })];
    const model = scenario.buildModel(rows);
    expect(model.includedRows).to.deep.equal([0]);
    const lines = scenario.resultsToCsv(rows, model).trim().split("\n");
    expect(lines[0]).to.equal(
      "name,committed_hop0,committed_hop1,committed_hop2,committed_total," +
        "accepted_hop0,accepted_hop1,accepted_hop2,accepted_total,arm,refund_usdc",
    );
    // A lone $20k seed is far below MIN_SALE: refund mode, everything refunded.
    expect(lines.slice(1)).to.deep.equal(["Alice,20000,0,0,20000,0,0,0,0,0,20000"]);
  });

  // WHY: pro-rata floors produce sub-cent amounts; the export must show the exact on-chain values.
  it("exports pro-rated results at full 6-decimal precision", function () {
    const rows = Array.from({ length: 40 }, (_, i) => scenario.selfFill(row({ name: `P${i}` })));
    // Hop-0 demand becomes $595k against a $564k ceiling: 15000 * 564000 / 595000 = 14218.4873949...
    rows[0].commits = ["10000", "12000", "6000"];
    const lines = scenario.resultsToCsv(rows, scenario.buildModel(rows)).trim().split("\n");
    expect(lines[2]).to.equal("P1,15000,12000,6000,33000,14218.487394,11400,4500,30118.487394,30118.487394,2881.512606");
  });
});
