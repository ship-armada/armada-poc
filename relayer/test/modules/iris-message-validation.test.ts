// ABOUTME: Tests for the iris relay's Iris-response validation helpers — isPlausibleHexBytes and
// irisMessageMatches.
// ABOUTME: WHY: the relayer signs + broadcasts the bytes Iris returns. These guards stop a
// malformed/foreign Iris response from being forwarded blind (gas burned on a guaranteed revert)
// and let the client pick the right entry when one source tx yields multiple messages.

import { expect } from "chai";
import { isPlausibleHexBytes, irisMessageMatches } from "../../modules/iris-relay";

// MessageV2 envelope: nonce@12 (32B) and finalityThresholdExecuted@144 (4B) are the only fields
// Iris fills in; everything else must match the locally-observed bytes.
function buildMessage(opts: {
  nonce?: string; // 32-byte hex (no 0x)
  finalityExecuted?: number;
  fillByte?: string; // 1-byte hex for the stable body, default "aa"
  totalBytes?: number;
  maxFee?: string; // 32-byte hex at abs offset 280 (user-authorized ceiling — must match)
  feeExecuted?: string; // 32-byte hex at abs offset 312 (Circle fills on FAST — volatile)
  expirationBlock?: string; // 32-byte hex at abs offset 344 (Circle fills on FAST — volatile)
}): string {
  const total = opts.totalBytes ?? 376;
  const buf = Buffer.alloc(total, Buffer.from(opts.fillByte ?? "aa", "hex")[0]);
  if (opts.nonce) Buffer.from(opts.nonce, "hex").copy(buf, 12);
  else buf.fill(0, 12, 44); // zeroed nonce (the source-event state)
  buf.writeUInt32BE(opts.finalityExecuted ?? 0, 144);
  if (opts.maxFee) Buffer.from(opts.maxFee, "hex").copy(buf, 280);
  if (opts.feeExecuted) Buffer.from(opts.feeExecuted, "hex").copy(buf, 312);
  if (opts.expirationBlock) Buffer.from(opts.expirationBlock, "hex").copy(buf, 344);
  return "0x" + buf.toString("hex");
}

describe("isPlausibleHexBytes", function () {
  it("accepts 0x-prefixed hex at or above the minimum byte length", function () {
    expect(isPlausibleHexBytes("0x" + "ab".repeat(65), 65)).to.equal(true);
  });
  it("rejects non-string, missing 0x, odd length, non-hex, and too-short inputs", function () {
    // WHY: each is a way a malformed Iris field could slip through and get signed/broadcast.
    expect(isPlausibleHexBytes(undefined, 1)).to.equal(false);
    expect(isPlausibleHexBytes("ab", 1)).to.equal(false); // no 0x
    expect(isPlausibleHexBytes("0xabc", 1)).to.equal(false); // odd length
    expect(isPlausibleHexBytes("0xzz", 1)).to.equal(false); // non-hex
    expect(isPlausibleHexBytes("0x" + "ab".repeat(10), 65)).to.equal(false); // too short
  });
});

describe("irisMessageMatches", function () {
  it("matches when only the nonce and finalityThresholdExecuted differ", function () {
    // WHY: the source event has a zero nonce; Iris fills the real nonce + finality. Those two
    // fields differing must NOT count as a mismatch, or every legitimate relay would be rejected.
    const local = buildMessage({}); // zero nonce, finality 0
    const fromIris = buildMessage({ nonce: "11".repeat(32), finalityExecuted: 2000 });
    expect(irisMessageMatches(local, fromIris)).to.equal(true);
  });

  it("matches when a FAST transfer's feeExecuted + expirationBlock differ (Circle fills them post-burn)", function () {
    // WHY: On a FAST CCTP V2 transfer, Circle populates feeExecuted (the actual fee charged) and
    // expirationBlock (the fast-mint expiry) during attestation — both zero at burn. They legitimately
    // differ between the source-observed bytes and the Iris response. Regression: cross-chain unshields
    // (forced to FAST by the hub pool's finality default) were dead-lettered as "differs outside the
    // nonce/finality slots" because only nonce + finalityThresholdExecuted were whitelisted. Shields use
    // STANDARD (fee 0, no expiry) so they never exercised this.
    const local = buildMessage({}); // feeExecuted + expirationBlock at the source-event default
    const fromIris = buildMessage({
      nonce: "11".repeat(32),
      finalityExecuted: 1000,
      feeExecuted: "00".repeat(30) + "07d0", // actual fee = 2000, filled by Iris
      expirationBlock: "00".repeat(28) + "0aabbccd", // fast-mint expiry block
    });
    expect(irisMessageMatches(local, fromIris)).to.equal(true);
  });

  it("does NOT match when maxFee differs (the user-authorized ceiling must be verified)", function () {
    // WHY: maxFee is bound into the user's proof (encodeCctpBinding) — it is NOT a Circle-filled
    // volatile field, so a mismatch means the Iris message authorizes a different fee than the user
    // signed. It must stay outside the whitelist even though the adjacent feeExecuted slot is ignored.
    const local = buildMessage({ maxFee: "00".repeat(30) + "07d0" }); // 2000
    const tampered = buildMessage({ maxFee: "00".repeat(30) + "2710" }); // 10000
    expect(irisMessageMatches(local, tampered)).to.equal(false);
  });

  it("does NOT match when a stable field (e.g. the body) differs", function () {
    // WHY: this is the guard's whole purpose — a substituted/foreign message must be caught before
    // we sign it, even if it's the right length.
    const local = buildMessage({ fillByte: "aa" });
    const tampered = buildMessage({ fillByte: "bb" });
    expect(irisMessageMatches(local, tampered)).to.equal(false);
  });

  it("does not match messages of different lengths", function () {
    const local = buildMessage({ totalBytes: 376 });
    const longer = buildMessage({ totalBytes: 408 });
    expect(irisMessageMatches(local, longer)).to.equal(false);
  });

  it("is tolerant of 0x prefix presence/absence and case", function () {
    const local = buildMessage({});
    const noPrefix = local.slice(2).toUpperCase();
    expect(irisMessageMatches(local, noPrefix)).to.equal(true);
  });
});
