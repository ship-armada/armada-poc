// ABOUTME: Unit tests for the Counters module — the in-process metric primitive surfaced via /health.
// ABOUTME: Pinning the increment-on-missing-key + snapshot copy semantics so /health consumers can rely on them.

import { expect } from "chai";
import { Counters } from "../../modules/counters";

describe("Counters", () => {
  it("creates a key at 1 the first time it's incremented", () => {
    // WHY: callers always inc unconditionally — they don't pre-register keys. A regression that
    // required init-before-inc would silently swallow the first failure of each new kind, which
    // is the most interesting moment for operators triaging a new client behaviour.
    const c = new Counters();
    c.inc("submitSuccess.transact");
    expect(c.snapshot()).to.deep.equal({ "submitSuccess.transact": 1 });
  });

  it("increments existing keys monotonically", () => {
    // WHY: pin the +1 semantic. A regression that overwrote instead of accumulated would make the
    // operator-facing counter useless ("did we get 1 or 1000 FEE_INSUFFICIENT this hour?").
    const c = new Counters();
    c.inc("feeVerifierRejects.FEE_INSUFFICIENT");
    c.inc("feeVerifierRejects.FEE_INSUFFICIENT");
    c.inc("feeVerifierRejects.FEE_INSUFFICIENT");
    expect(c.snapshot()["feeVerifierRejects.FEE_INSUFFICIENT"]).to.equal(3);
  });

  it("keeps independent keys independent (no shared bucket leakage)", () => {
    // WHY: defensive against a regression where two distinct error codes get bucketed into the
    // same map key (e.g., key truncation or normalisation). Would make /health misleading without
    // a test failure to catch it.
    const c = new Counters();
    c.inc("submitSuccess.transact");
    c.inc("submitSuccess.lendAndShield");
    c.inc("submitFail.transact.SUBMISSION_FAILED");
    expect(c.snapshot()).to.deep.equal({
      "submitSuccess.transact": 1,
      "submitSuccess.lendAndShield": 1,
      "submitFail.transact.SUBMISSION_FAILED": 1,
    });
  });

  it("returns a copy from snapshot — mutating the returned object doesn't affect later snapshots", () => {
    // WHY: /health serializes the snapshot as JSON in the response. If snapshot() returned the
    // backing Map's view, a caller mutating the result (or an /health middleware adding fields)
    // could corrupt state. The copy semantics keep the source of truth immutable from outside.
    const c = new Counters();
    c.inc("a");
    const s1 = c.snapshot();
    s1["a"] = 999;
    s1["b"] = 1;
    const s2 = c.snapshot();
    expect(s2).to.deep.equal({ a: 1 });
  });
});
