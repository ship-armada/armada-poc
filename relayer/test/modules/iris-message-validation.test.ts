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
}): string {
  const total = opts.totalBytes ?? 376;
  const buf = Buffer.alloc(total, Buffer.from(opts.fillByte ?? "aa", "hex")[0]);
  if (opts.nonce) Buffer.from(opts.nonce, "hex").copy(buf, 12);
  else buf.fill(0, 12, 44); // zeroed nonce (the source-event state)
  buf.writeUInt32BE(opts.finalityExecuted ?? 0, 144);
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
