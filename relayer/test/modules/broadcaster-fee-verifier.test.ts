// ABOUTME: Unit tests for verifyBroadcasterFee — the security gate that rejects /relay requests
// ABOUTME: whose embedded SNARK proof doesn't pay the relayer at the advertised rate.

import { expect } from "chai";
import { RailgunWallet, getTokenDataHashERC20 } from "@railgun-community/engine";
import {
  verifyBroadcasterFee,
  type VerifierContext,
} from "../../modules/broadcaster-fee-verifier";
import { RelayError } from "../../types";

// Fixed test addresses — no on-chain deployment, just shapes the verifier accepts.
const USDC_ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_TOKEN_ADDRESS = "0x2222222222222222222222222222222222222222";
const PRIVACY_POOL_ADDRESS = "0x3333333333333333333333333333333333333333";
const HUB_CHAIN_ID = 31337;

// Realistic-shaped calldata — the verifier never decodes it itself, but it gets handed verbatim
// to the (stubbed) SDK helper.  A `0xd8ae136a` selector + filler bytes is enough for the
// privacy-relay caller's gate to be plausible.
const FAKE_TRANSACT_DATA = "0xd8ae136a" + "00".repeat(32);

const ADVERTISED_FEE = 50_000n; // 0.05 USDC raw

/**
 * Build a stub RailgunWallet whose only loaded method is the one verify() actually calls.
 * `as unknown as RailgunWallet` is the deliberate cast — we want the stub to satisfy the
 * structural type that the verifier consumes, not the full SDK surface.
 */
function stubWallet(returnMap: Record<string, bigint>): RailgunWallet {
  return {
    extractFirstNoteERC20AmountMap: async () => returnMap,
  } as unknown as RailgunWallet;
}

function stubWalletThrowing(err: Error): RailgunWallet {
  return {
    extractFirstNoteERC20AmountMap: async () => {
      throw err;
    },
  } as unknown as RailgunWallet;
}

function ctxFor(wallet: RailgunWallet): VerifierContext {
  return {
    wallet,
    privacyPoolAddress: PRIVACY_POOL_ADDRESS,
    hubChainId: HUB_CHAIN_ID,
    usdcAddress: USDC_ADDRESS,
  };
}

describe("verifyBroadcasterFee", () => {
  // Token hashes are derived once and pinned at the suite level so every test agrees on which
  // map keys mean USDC vs other tokens — a regression that swapped the hash function would
  // surface as cross-test divergence rather than per-test failures.
  const USDC_TOKEN_HASH = getTokenDataHashERC20(USDC_ADDRESS).toLowerCase();
  const OTHER_TOKEN_HASH = getTokenDataHashERC20(OTHER_TOKEN_ADDRESS).toLowerCase();

  describe("accept path", () => {
    it("returns the paid amount when USDC entry is present and >= advertised", async () => {
      // WHY: the happy path is the most common branch — proves the verifier doesn't
      // throw spuriously when the SDK returns a properly-formed map. Also pins the return
      // value (the actual paid amount) so loggers/metrics can record it.
      const wallet = stubWallet({ [USDC_TOKEN_HASH]: ADVERTISED_FEE * 2n });
      const paid = await verifyBroadcasterFee(
        ctxFor(wallet),
        { to: PRIVACY_POOL_ADDRESS, data: FAKE_TRANSACT_DATA },
        ADVERTISED_FEE,
      );
      expect(paid).to.equal(ADVERTISED_FEE * 2n);
    });

    it("accepts at the exact advertised-amount boundary (paid == advertised)", async () => {
      // WHY: pin the comparator. A regression that flipped `<` to `<=` would silently reject
      // every request that paid the EXACTLY-advertised amount — the most common path once
      // clients optimize their broadcaster fees to the displayed minimum.
      const wallet = stubWallet({ [USDC_TOKEN_HASH]: ADVERTISED_FEE });
      const paid = await verifyBroadcasterFee(
        ctxFor(wallet),
        { to: PRIVACY_POOL_ADDRESS, data: FAKE_TRANSACT_DATA },
        ADVERTISED_FEE,
      );
      expect(paid).to.equal(ADVERTISED_FEE);
    });
  });

  describe("reject path — FEE_INSUFFICIENT", () => {
    it("rejects when the returned map has no USDC entry (only other tokens)", async () => {
      // WHY: a malicious or buggy client could put a broadcaster output for an unrelated token
      // (say, ETH) into their proof — the SDK would decrypt it (we own the recipient key) but
      // it doesn't pay our gas reimbursement. Must reject. Defends against the "pay me in
      // shitcoins" exploit class.
      const wallet = stubWallet({ [OTHER_TOKEN_HASH]: ADVERTISED_FEE * 10n });
      await expectRejectedAs(
        verifyBroadcasterFee(
          ctxFor(wallet),
          { to: PRIVACY_POOL_ADDRESS, data: FAKE_TRANSACT_DATA },
          ADVERTISED_FEE,
        ),
        "FEE_INSUFFICIENT",
        /paid 0 USDC raw/,
      );
    });

    it("rejects when the returned map is empty (no decryptable outputs to relayer)", async () => {
      // WHY: catches the "no broadcaster output at all" attack — a tampered proof where the
      // adversary stripped the broadcaster output before submission, hoping the relayer
      // would forward the tx without checking.
      const wallet = stubWallet({});
      await expectRejectedAs(
        verifyBroadcasterFee(
          ctxFor(wallet),
          { to: PRIVACY_POOL_ADDRESS, data: FAKE_TRANSACT_DATA },
          ADVERTISED_FEE,
        ),
        "FEE_INSUFFICIENT",
        /paid 0 USDC raw/,
      );
    });

    it("rejects when the USDC amount is less than advertised (off-by-one below)", async () => {
      // WHY: pin the lower-bound comparator. A client that quoted a fee 30 minutes ago and
      // built a proof against that quote would see the relayer's advertised fee drift upward.
      // The verifier MUST catch the shortfall; otherwise drift = free relays.
      const wallet = stubWallet({ [USDC_TOKEN_HASH]: ADVERTISED_FEE - 1n });
      await expectRejectedAs(
        verifyBroadcasterFee(
          ctxFor(wallet),
          { to: PRIVACY_POOL_ADDRESS, data: FAKE_TRANSACT_DATA },
          ADVERTISED_FEE,
        ),
        "FEE_INSUFFICIENT",
        new RegExp(`paid ${ADVERTISED_FEE - 1n} USDC raw, advertised ${ADVERTISED_FEE}`),
      );
    });

    it("rejects with FEE_INSUFFICIENT when the SDK helper throws (e.g. malformed calldata)", async () => {
      // WHY: the SDK throws on `to`/contract address mismatch, function-name mismatch (a
      // wrapper-function calldata fed in), or unparseable Transaction encoding. All three are
      // attack-shaped — a benign client never produces them. Mapping them to FEE_INSUFFICIENT
      // (vs INVALID_DATA) keeps the security framing: "we couldn't verify the fee, so we
      // don't relay" — regardless of whether the failure was at the decoder or the value
      // check.
      const wallet = stubWalletThrowing(
        new Error("Contract method atomicCrossChainUnshield invalid: expected transact"),
      );
      await expectRejectedAs(
        verifyBroadcasterFee(
          ctxFor(wallet),
          { to: PRIVACY_POOL_ADDRESS, data: FAKE_TRANSACT_DATA },
          ADVERTISED_FEE,
        ),
        "FEE_INSUFFICIENT",
        /could not decode proof outputs|invalid: expected transact/,
      );
    });
  });
});

/**
 * Helper: assert a promise rejects with a RelayError of a specific code + matching message.
 * Using a single helper keeps the assertion shape consistent across tests — if a future
 * refactor changes how RelayError surfaces (e.g. nested cause), there's one place to update.
 */
async function expectRejectedAs(
  promise: Promise<unknown>,
  expectedCode: string,
  messagePattern: RegExp,
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught, "expected promise to reject").to.be.instanceOf(RelayError);
  const err = caught as RelayError;
  expect(err.code).to.equal(expectedCode);
  expect(err.message).to.match(messagePattern);
}
