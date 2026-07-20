// ABOUTME: Tests that every /relay-allowed selector has a matching advertised-fee mapping.
// ABOUTME: WHY: the allowlist and the fee-map are two lists that must cover the same selector set.

import { expect } from "chai";
import {
  ALLOWED_SELECTORS,
  advertisedFeeForSelector,
} from "../../modules/privacy-relay";

// A fully-populated fee schedule; values are arbitrary non-empty numeric strings — the test only
// checks that a fee is resolved without throwing, not the specific amount.
const FEES = {
  transfer: "1",
  unshield: "2",
  crossContract: "3",
  crossChainShield: "4",
  crossChainUnshield: "5",
  shield: "6",
  shieldXchain: "7",
};

describe("advertisedFeeForSelector — allowlist parity", function () {
  // WHY: atomicCrossChainUnshield's selector changed with #64 and again with #287. The allowlist
  // (constant-sourced) tracked the change but the fee-map (hardcoded literals) drifted, so a valid
  // cross-chain unshield passed the allowlist then hit the "unreachable" default and was rejected
  // INVALID_DATA. This pins the invariant that broke: every allowed selector must resolve to a fee.
  it("resolves a fee for every selector in ALLOWED_SELECTORS", function () {
    for (const selector of Object.keys(ALLOWED_SELECTORS)) {
      expect(
        () => advertisedFeeForSelector(selector, FEES),
        `selector ${selector} (${ALLOWED_SELECTORS[selector]}) has no advertised-fee mapping`,
      ).to.not.throw();
    }
  });

  it("throws for a selector that is not allow-listed", function () {
    // WHY: the default branch is the fail-closed guard for a genuinely unknown selector; it must
    // still reject rather than silently returning a fee.
    expect(() => advertisedFeeForSelector("0xdeadbeef", FEES)).to.throw(
      "No advertised-fee mapping",
    );
  });
});
