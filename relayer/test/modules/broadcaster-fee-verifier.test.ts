// ABOUTME: Unit tests for verifyBroadcasterFee — the security gate that rejects /relay requests
// ABOUTME: whose embedded SNARK proof doesn't pay the relayer at the advertised rate.

import { expect } from "chai";
import { ethers } from "ethers";
import { RailgunWallet } from "@railgun-community/engine";
import {
  verifyBroadcasterFee,
  type VerifierContext,
} from "../../modules/broadcaster-fee-verifier";
import { TRANSACT_ABI, WRAPPER_ABIS } from "../../lib/transact-shape";
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

/**
 * Build a stub that captures the `transactionRequest` it was called with — lets wrapper-decoding
 * tests assert that the request handed to the SDK was rewritten to a synthetic vanilla `transact`
 * (not the original wrapper calldata).
 */
function recordingStubWallet(returnMap: Record<string, bigint>): {
  wallet: RailgunWallet;
  lastRequest: () => { to?: string; data?: string } | null;
} {
  let captured: { to?: string; data?: string } | null = null;
  return {
    wallet: {
      extractFirstNoteERC20AmountMap: async (
        _txidVersion: unknown,
        _chain: unknown,
        transactionRequest: { to?: string; data?: string },
      ) => {
        captured = { to: transactionRequest.to, data: transactionRequest.data };
        return returnMap;
      },
    } as unknown as RailgunWallet,
    lastRequest: () => captured,
  };
}

/**
 * Minimal-but-ABI-valid Transaction struct. The verifier doesn't inspect any of these fields
 * (decryption is what extracts the broadcaster output — stubbed in unit tests); ethers' ABI
 * decoder just needs every named field present with the right primitive shape.
 */
function emptyTransaction(): unknown {
  return {
    proof: {
      a: { x: 0n, y: 0n },
      b: { x: [0n, 0n], y: [0n, 0n] },
      c: { x: 0n, y: 0n },
    },
    merkleRoot: "0x" + "00".repeat(32),
    nullifiers: [],
    commitments: [],
    boundParams: {
      treeNumber: 0,
      minGasPrice: 0n,
      unshield: 0,
      chainID: 31337n,
      adaptContract: ethers.ZeroAddress,
      adaptParams: "0x" + "00".repeat(32),
      commitmentCiphertext: [],
    },
    unshieldPreimage: {
      npk: "0x" + "00".repeat(32),
      token: { tokenType: 0, tokenAddress: ethers.ZeroAddress, tokenSubID: 0n },
      value: 0n,
    },
  };
}

/** ShieldCiphertext filler — three bytes32 + a key. Not inspected; ethers just needs the shape. */
function emptyShieldCiphertext(): unknown {
  return {
    encryptedBundle: ["0x" + "00".repeat(32), "0x" + "00".repeat(32), "0x" + "00".repeat(32)],
    shieldKey: "0x" + "00".repeat(32),
  };
}

function encodeWrapperCalldata(fnName: "lendAndShield" | "redeemAndShield"): string {
  const iface = new ethers.Interface(WRAPPER_ABIS);
  return iface.encodeFunctionData(fnName, [
    emptyTransaction(),
    "0x" + "00".repeat(32),
    emptyShieldCiphertext(),
  ]);
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
  // The SDK keys its extracted-amount map by the lowercased token CONTRACT ADDRESS — that's the
  // shape the wallet's `extractFirstNoteERC20AmountMap` returns and the shape the verifier
  // looks up. A regression that switched the map key to a token-hash would silently make every
  // verification return 0n; these constants pin "what the SDK actually returns" so the test
  // shape mirrors production decryption.
  const USDC_KEY = USDC_ADDRESS.toLowerCase();
  const OTHER_TOKEN_KEY = OTHER_TOKEN_ADDRESS.toLowerCase();

  describe("accept path", () => {
    it("returns the paid amount when USDC entry is present and >= advertised", async () => {
      // WHY: the happy path is the most common branch — proves the verifier doesn't
      // throw spuriously when the SDK returns a properly-formed map. Also pins the return
      // value (the actual paid amount) so loggers/metrics can record it.
      const wallet = stubWallet({ [USDC_KEY]: ADVERTISED_FEE * 2n });
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
      const wallet = stubWallet({ [USDC_KEY]: ADVERTISED_FEE });
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
      const wallet = stubWallet({ [OTHER_TOKEN_KEY]: ADVERTISED_FEE * 10n });
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
      const wallet = stubWallet({ [USDC_KEY]: ADVERTISED_FEE - 1n });
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

  describe("wrapper-function normalisation (A4 — lendAndShield / redeemAndShield)", () => {
    it("decodes lendAndShield, extracts the embedded Transaction, and hands a synthetic transact to the SDK", async () => {
      // WHY: A4 unblocks yield-deposit by accepting the wrapper selector that A2 had off-list.
      // This test pins the load-bearing contract: the wallet helper receives calldata addressed
      // to the PrivacyPool with the vanilla `transact` shape, NOT the original wrapper calldata.
      // A regression that routed wrapper calldata straight to the SDK would surface as
      // "Contract method lendAndShield invalid: expected transact" — the failure mode A2
      // documented as the reason for the verifier's selector-narrowing decision.
      const rec = recordingStubWallet({ [USDC_ADDRESS.toLowerCase()]: ADVERTISED_FEE * 2n });
      const wrapperCalldata = encodeWrapperCalldata("lendAndShield");

      const paid = await verifyBroadcasterFee(
        ctxFor(rec.wallet),
        // `to` here would normally be ArmadaYieldAdapter's address, NOT the PrivacyPool. The
        // normaliser must rewrite the synthetic request's `to` to the PrivacyPool regardless.
        { to: "0x4444444444444444444444444444444444444444", data: wrapperCalldata },
        ADVERTISED_FEE,
      );

      expect(paid).to.equal(ADVERTISED_FEE * 2n);
      const captured = rec.lastRequest();
      expect(captured, "wallet helper must have been called").to.not.be.null;
      expect(captured!.to).to.equal(PRIVACY_POOL_ADDRESS);
      // Selector of the synthetic call MUST be vanilla transact, not the wrapper's selector.
      expect(captured!.data?.slice(0, 10)).to.equal("0xd8ae136a");
      // And the synthetic calldata must round-trip as a single-element transact[] (the embedded
      // Transaction we lifted out of the wrapper).
      const decoded = new ethers.Interface(TRANSACT_ABI).decodeFunctionData(
        "transact",
        captured!.data!,
      );
      expect(decoded[0].length).to.equal(1);
    });

    it("decodes redeemAndShield the same way", async () => {
      // WHY: same selector category, symmetric path. Asserting both wrappers traverse the
      // normaliser independently — a copy-paste bug that hard-coded one selector in the route
      // would silently break the other.
      const rec = recordingStubWallet({ [USDC_ADDRESS.toLowerCase()]: ADVERTISED_FEE });
      const wrapperCalldata = encodeWrapperCalldata("redeemAndShield");

      const paid = await verifyBroadcasterFee(
        ctxFor(rec.wallet),
        { to: "0x4444444444444444444444444444444444444444", data: wrapperCalldata },
        ADVERTISED_FEE,
      );

      expect(paid).to.equal(ADVERTISED_FEE);
      expect(rec.lastRequest()?.data?.slice(0, 10)).to.equal("0xd8ae136a");
    });

    it("rejects unknown selectors with INVALID_DATA (not FEE_INSUFFICIENT)", async () => {
      // WHY: keep the security framing honest. FEE_INSUFFICIENT means "we tried to verify and
      // came up short"; INVALID_DATA means "we won't even try." A selector we don't recognise
      // is the latter — surfacing it as a fee problem would mislead operators tracking
      // verifier rejections.
      const wallet = stubWallet({});
      const bogusSelector = "0xdeadbeef" + "00".repeat(32);
      await expectRejectedAs(
        verifyBroadcasterFee(
          ctxFor(wallet),
          { to: PRIVACY_POOL_ADDRESS, data: bogusSelector },
          ADVERTISED_FEE,
        ),
        "INVALID_DATA",
        /unsupported selector/i,
      );
    });

    it("rejects wrapper calldata whose decoded broadcaster output is below advertised", async () => {
      // WHY: the wrapper path must still enforce the same fee floor as vanilla — extracting
      // the Transaction is normalisation, not exemption. A regression that bypassed the
      // amount check on the wrapper branch would let yield ops pay $0 in broadcaster fees
      // while transact() kept enforcing.
      const rec = recordingStubWallet({ [USDC_ADDRESS.toLowerCase()]: ADVERTISED_FEE - 1n });
      const wrapperCalldata = encodeWrapperCalldata("lendAndShield");
      await expectRejectedAs(
        verifyBroadcasterFee(
          ctxFor(rec.wallet),
          { to: "0x4444444444444444444444444444444444444444", data: wrapperCalldata },
          ADVERTISED_FEE,
        ),
        "FEE_INSUFFICIENT",
        new RegExp(`paid ${ADVERTISED_FEE - 1n} USDC raw, advertised ${ADVERTISED_FEE}`),
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
