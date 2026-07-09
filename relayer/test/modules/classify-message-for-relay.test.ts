// ABOUTME: Tests for classifyMessageForRelay — the iris relay's fail-closed decision on whether a
// scanned CCTP message is a genuine BurnMessageV2 addressed to one of our pools.
// ABOUTME: WHY: the destination MessageTransmitter is shared + permissionless, and the relayer pays
// gas for whatever it relays. A crafted short/foreign message slipping through is an unmetered
// gas-drain — these tests pin that the filter rejects everything it can't positively identify.

import { expect } from "chai";
import { ethers } from "ethers";
import { classifyMessageForRelay } from "../../modules/iris-relay";

// MessageV2 envelope offsets (bytes): destinationCaller@108, body@148; BurnMessageV2 body:
// version@0 (abs 148), mintRecipient@36 (abs 184). Min total length 376 bytes.
const POOL = ethers.zeroPadValue("0x" + "11".repeat(20), 32).toLowerCase();
const HOOK_ROUTER = "0x" + "22".repeat(20);
const HOOK_ROUTER_BYTES32 = ethers.zeroPadValue(HOOK_ROUTER, 32).toLowerCase();

/** Build a MessageV2 hex with the fields the classifier inspects; everything else zero-filled. */
function buildMessage(opts: {
  bodyVersion?: number;
  mintRecipient?: string; // bytes32 hex
  destinationCaller?: string; // bytes32 hex
  totalBytes?: number;
}): string {
  const total = opts.totalBytes ?? 376;
  const buf = Buffer.alloc(total);
  if (total >= 152) buf.writeUInt32BE(opts.bodyVersion ?? 1, 148); // body version (abs offset 148)
  if (opts.mintRecipient && total >= 216) {
    Buffer.from(opts.mintRecipient.replace(/^0x/, ""), "hex").copy(buf, 184);
  }
  if (opts.destinationCaller && total >= 140) {
    Buffer.from(opts.destinationCaller.replace(/^0x/, ""), "hex").copy(buf, 108);
  }
  return "0x" + buf.toString("hex");
}

const KNOWN = new Set([POOL]);

describe("classifyMessageForRelay", function () {
  it("relays a genuine BurnMessageV2 to a known recipient with zero destinationCaller", function () {
    // WHY: the happy path — Armada burn paths legitimately leave destinationCaller zero, so this
    // MUST relay. This is the case the previous fail-open filter also accepted.
    const msg = buildMessage({ mintRecipient: POOL });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).to.equal(true);
    if (result.relay) expect(result.mintRecipient).to.equal(POOL);
  });

  it("rejects a too-short message (the gas-drain vector) instead of failing open", function () {
    // WHY: this is the core fix. A short body made parseMessageFields return mintRecipient="" and
    // the old filter relayed it. Now anything below the BurnMessageV2 minimum is rejected.
    const msg = buildMessage({ mintRecipient: POOL, totalBytes: 200 });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).to.equal(false);
    if (!result.relay) expect(result.reason).to.contain("minimum");
  });

  it("rejects a message whose body version is not the BurnMessageV2 version", function () {
    // WHY: a generic (non-burn) CCTP message could place our pool at the mintRecipient offset to
    // pass the recipient check — the version field is what distinguishes a real burn body.
    const msg = buildMessage({ mintRecipient: POOL, bodyVersion: 99 });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).to.equal(false);
    if (!result.relay) expect(result.reason).to.contain("version");
  });

  it("rejects a mintRecipient that is not in knownRecipients", function () {
    const stranger = ethers.zeroPadValue("0x" + "99".repeat(20), 32).toLowerCase();
    const msg = buildMessage({ mintRecipient: stranger });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).to.equal(false);
    if (!result.relay) expect(result.reason).to.contain("not in knownRecipients");
  });

  it("rejects everything when knownRecipients is empty (misconfiguration ⇒ fail closed)", function () {
    // WHY: an empty allowlist used to bypass the filter entirely (fail open). Now it means "we
    // can't identify any message as ours" → relay nothing, loudly.
    const msg = buildMessage({ mintRecipient: POOL });
    const result = classifyMessageForRelay(msg, new Set(), HOOK_ROUTER);
    expect(result.relay).to.equal(false);
    if (!result.relay) expect(result.reason).to.contain("no known recipients");
  });

  it("relays when destinationCaller is set and equals our hookRouter", function () {
    const msg = buildMessage({ mintRecipient: POOL, destinationCaller: HOOK_ROUTER_BYTES32 });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).to.equal(true);
  });

  it("rejects when destinationCaller is set but does not equal our hookRouter", function () {
    // WHY: a non-zero destinationCaller binds receiveMessage to a specific caller; if it's not us,
    // our relay would revert (and we'd pay gas), so skip it.
    const otherCaller = ethers.zeroPadValue("0x" + "ab".repeat(20), 32).toLowerCase();
    const msg = buildMessage({ mintRecipient: POOL, destinationCaller: otherCaller });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).to.equal(false);
    if (!result.relay) expect(result.reason).to.contain("hookRouter");
  });
});
