// ABOUTME: Unit tests for verifyBroadcasterFee — the security gate that rejects /relay requests
// ABOUTME: whose embedded SNARK proof doesn't pay the relayer at the advertised rate.

import { expect } from "chai";
import { ethers } from "ethers";
import { RailgunWallet } from "@railgun-community/engine";
import {
  verifyBroadcasterFee,
  deriveBroadcasterIdentity,
  type VerifierContext,
  type ArmadaBroadcasterIdentity,
} from "../../modules/broadcaster-fee-verifier";
import { TRANSACT_ABI, WRAPPER_ABIS } from "../../lib/transact-shape";
import { RelayError } from "../../types";
// All from @armada/sdk's root entry — the SDK explicitly re-exports the note-crypto/keyset/token
// helpers so node10 (classic moduleResolution) consumers like this suite import them straight from the
// package root, no subpath or facade needed.
import {
  buildTransactCalldata,
  deriveKeyset,
  createTransferNote,
  encryptNoteToReceiver,
  getTokenDataERC20,
  initPoseidonPromise,
} from "@armada/sdk";
import type { Groth16Proof, TransactionData } from "@armada/sdk";

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

function encodeWrapperCalldata(
  fnName: "lendAndShield" | "atomicCrossChainUnshield",
): string {
  const iface = new ethers.Interface(WRAPPER_ABIS);
  if (fnName === "atomicCrossChainUnshield") {
    // A5 wrapper carries different surrounding args than the yield wrappers — Transaction in
    // arg 0 stays the same shape (which is the only thing the verifier cares about), but the
    // ABI encoder needs the trailing args present to round-trip.
    return iface.encodeFunctionData(fnName, [
      emptyTransaction(),
      0, // destinationDomain (uint32)
      ethers.ZeroAddress, // finalRecipient
      0n, // maxFee (uint256)
      "0x" + "00".repeat(32), // uniqueNonce (bytes32)
    ]);
  }
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

    // NOTE: redeemAndShield is intentionally NOT verified here — its fee is contract-side (#312),
    // covered by redeem-fee-verifier.test.ts. It was removed from WRAPPER_ABIS/WRAPPER_SELECTORS.

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

    it("decodes atomicCrossChainUnshield (A5) by lifting the embedded Transaction the same way", async () => {
      // WHY: A5 cross-chain unshield reuses the wrapper pattern — Transaction in arg 0, CCTP
      // routing args trailing. The fee-verification surface MUST remain identical to the yield
      // wrappers: same selector-set membership, same synthetic-transact rewrite, same fee floor.
      // A regression that special-cased the yield wrappers without including the xchain wrapper
      // would silently let cross-chain unshields skip fee verification entirely (FEE_INSUFFICIENT
      // wouldn't fire because the selector would fall through to the unknown branch — INVALID_DATA
      // — but privacy-relay's allowlist would have already gated this from the live path, leaving
      // a confusing two-layer rejection rather than a clean "low fee" signal in tests).
      const rec = recordingStubWallet({ [USDC_ADDRESS.toLowerCase()]: ADVERTISED_FEE * 3n });
      const wrapperCalldata = encodeWrapperCalldata("atomicCrossChainUnshield");

      const paid = await verifyBroadcasterFee(
        ctxFor(rec.wallet),
        // The `to` for this wrapper IS the PrivacyPool (unlike the yield wrappers which target
        // the adapter); the normaliser must still rewrite to the PrivacyPool address regardless.
        { to: PRIVACY_POOL_ADDRESS, data: wrapperCalldata },
        ADVERTISED_FEE,
      );

      expect(paid).to.equal(ADVERTISED_FEE * 3n);
      const captured = rec.lastRequest();
      expect(captured, "wallet helper must have been called").to.not.be.null;
      expect(captured!.to).to.equal(PRIVACY_POOL_ADDRESS);
      expect(captured!.data?.slice(0, 10)).to.equal("0xd8ae136a");
      const decoded = new ethers.Interface(TRANSACT_ABI).decodeFunctionData(
        "transact",
        captured!.data!,
      );
      expect(decoded[0].length).to.equal(1);
    });

    it("rejects atomicCrossChainUnshield with insufficient broadcaster fee", async () => {
      // WHY: symmetric to the lendAndShield insufficient-fee test — A5's xchain path must
      // enforce the same lower bound, otherwise cross-chain unshields become a free relay
      // tier while every other kind keeps paying.
      const rec = recordingStubWallet({ [USDC_ADDRESS.toLowerCase()]: ADVERTISED_FEE - 1n });
      const wrapperCalldata = encodeWrapperCalldata("atomicCrossChainUnshield");
      await expectRejectedAs(
        verifyBroadcasterFee(
          ctxFor(rec.wallet),
          { to: PRIVACY_POOL_ADDRESS, data: wrapperCalldata },
          ADVERTISED_FEE,
        ),
        "FEE_INSUFFICIENT",
        new RegExp(`paid ${ADVERTISED_FEE - 1n} USDC raw, advertised ${ADVERTISED_FEE}`),
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

/**
 * The armada backend routes fee extraction through @armada/sdk's native decode API (decodeTransact +
 * extractFeeOutput) instead of the stock engine helper. Unlike the stubbed-wallet tests above, these
 * build a REAL fee-bearing transact calldata with the SDK's own note-encryption + serializer, so the
 * full path runs: ABI decode, ECIES trial-decrypt under the broadcaster viewing key, AND the
 * commitment-binding check. Routing switches on `ctx.armadaBroadcaster` presence, so no SDK_BACKEND
 * env juggling is needed. The stock wallet in these contexts THROWS if called — proving the armada
 * path never silently falls back to the engine.
 */
describe("verifyBroadcasterFee — armada backend (SDK decode API)", () => {
  // Anvil/Hardhat default BIP39 mnemonic — the relayer derives its 0zk from a mnemonic the same way.
  const RELAYER_MNEMONIC =
    "test test test test test test test test test test test junk";
  // Plausible real ERC20 addresses (getTokenDataERC20 hashes the checksummed address).
  const SDK_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const SDK_OTHER_TOKEN = "0xdac17f958d2ee523a2206206994597c13d831ec7";
  const SDK_POOL = "0x00000000000000000000000000000000000000dd";
  const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

  // Decode-path fixture: the pool never verifies this proof (the decoder only ABI-decodes it), so a
  // zero proof is enough to exercise fee extraction + binding.
  const ZERO_PROOF: Groth16Proof = {
    a: ["0", "0"],
    b: [
      ["0", "0"],
      ["0", "0"],
    ],
    c: ["0", "0"],
  };

  let broadcaster: ArmadaBroadcasterIdentity;

  before(async function () {
    this.timeout(30_000);
    await initPoseidonPromise; // note.hash + extractFeeOutput binding both need poseidon ready
    broadcaster = await deriveBroadcasterIdentity(RELAYER_MNEMONIC);
  });

  // A wallet whose stock helper THROWS — asserts the armada path never falls through to the engine.
  const stockMustNotRun = stubWalletThrowing(
    new Error(
      "stock extractFirstNoteERC20AmountMap must not run under the armada backend",
    ),
  );

  function armadaCtx(): VerifierContext {
    return {
      wallet: stockMustNotRun,
      privacyPoolAddress: SDK_POOL,
      hubChainId: HUB_CHAIN_ID,
      usdcAddress: SDK_USDC,
      armadaBroadcaster: broadcaster,
    };
  }

  /**
   * Build a real `transact(Transaction[])` calldata carrying one fee note encrypted to `receiver`.
   * `bindCommitment: false` omits the note hash from the transaction's `commitments[]`, simulating a
   * sender who attaches a fee ciphertext with no matching on-chain commitment (the binding attack).
   */
  async function transactWithFeeNote(params: {
    receiver: ArmadaBroadcasterIdentity;
    feeAmount: bigint;
    tokenAddress?: string;
    bindCommitment?: boolean;
  }): Promise<`0x${string}`> {
    const sender = await deriveKeyset(seed(0x77));
    const tokenData = getTokenDataERC20(params.tokenAddress ?? SDK_USDC);
    const feeNote = createTransferNote({
      receiverAddressData: params.receiver.addressData,
      senderAddressData: {
        masterPublicKey: sender.masterPublicKey,
        viewingPublicKey: sender.viewingPublicKey,
      },
      value: params.feeAmount,
      tokenData,
    });
    const feeCiphertext = await encryptNoteToReceiver(
      feeNote,
      {
        masterPublicKey: sender.masterPublicKey,
        viewingPublicKey: sender.viewingPublicKey,
        viewingPrivateKey: sender.viewingPrivateKey,
      },
      params.receiver.addressData.viewingPublicKey,
    );
    const commitments = params.bindCommitment === false ? [] : [feeNote.hash];
    const tx: TransactionData = {
      proof: ZERO_PROOF,
      merkleRoot: 1n,
      nullifiers: [2n],
      commitments,
      boundParams: {
        treeNumber: 0,
        minGasPrice: 0n,
        unshield: 0,
        chainID: BigInt(HUB_CHAIN_ID),
        adaptContract: ethers.ZeroAddress as `0x${string}`,
        adaptParams: ("0x" + "00".repeat(32)) as `0x${string}`,
        commitmentCiphertext: [feeCiphertext],
      },
    };
    return buildTransactCalldata([tx], SDK_POOL).data;
  }

  it("accepts a transact whose fee note pays exactly the advertised USDC", async () => {
    // WHY: the happy path — a real ECIES-encrypted fee note to the broadcaster, bound to an on-chain
    // commitment, must decode + extract to its exact value. This is the whole point of the backend.
    const data = await transactWithFeeNote({
      receiver: broadcaster,
      feeAmount: ADVERTISED_FEE,
    });
    const paid = await verifyBroadcasterFee(
      armadaCtx(),
      { to: SDK_POOL, data },
      ADVERTISED_FEE,
    );
    expect(paid).to.equal(ADVERTISED_FEE);
  });

  it("accepts an overpaying fee note and reports the true amount", async () => {
    // WHY: the verifier returns the actual paid amount (not the advertised floor); a regression that
    // clamped to the floor would hide broadcaster over-collection.
    const data = await transactWithFeeNote({
      receiver: broadcaster,
      feeAmount: ADVERTISED_FEE * 3n,
    });
    const paid = await verifyBroadcasterFee(
      armadaCtx(),
      { to: SDK_POOL, data },
      ADVERTISED_FEE,
    );
    expect(paid).to.equal(ADVERTISED_FEE * 3n);
  });

  it("rejects when the fee note pays less than advertised", async () => {
    // WHY: the fee floor must hold on the SDK path exactly as on the stock path.
    const data = await transactWithFeeNote({
      receiver: broadcaster,
      feeAmount: ADVERTISED_FEE - 1n,
    });
    await expectRejectedAs(
      verifyBroadcasterFee(armadaCtx(), { to: SDK_POOL, data }, ADVERTISED_FEE),
      "FEE_INSUFFICIENT",
      new RegExp(`paid ${ADVERTISED_FEE - 1n} USDC raw, advertised ${ADVERTISED_FEE}`),
    );
  });

  it("rejects when the only fee note is addressed to a different 0zk", async () => {
    // WHY: an output the broadcaster can't decrypt must not count. A note to a stranger's viewing key
    // fails ECDH/AES-GCM, never enters the amount map → no USDC → FEE_INSUFFICIENT.
    const stranger = await deriveBroadcasterIdentity(
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
    );
    const data = await transactWithFeeNote({
      receiver: stranger,
      feeAmount: ADVERTISED_FEE,
    });
    await expectRejectedAs(
      verifyBroadcasterFee(armadaCtx(), { to: SDK_POOL, data }, ADVERTISED_FEE),
      "FEE_INSUFFICIENT",
      /Broadcaster fee too low: paid 0 USDC raw/,
    );
  });

  it("rejects a fee ciphertext with no matching on-chain commitment (binding attack)", async () => {
    // WHY: THE core security property of extractFeeOutput. A malicious sender attaches a ciphertext
    // that decrypts to a large fee under our key, but the transaction's commitments[] contains no
    // note with that hash — nothing was actually paid on-chain. The binding check (decrypted
    // note.hash ∈ commitments) must reject it; without it the relayer would eat gas for free.
    const data = await transactWithFeeNote({
      receiver: broadcaster,
      feeAmount: ADVERTISED_FEE * 10n,
      bindCommitment: false,
    });
    await expectRejectedAs(
      verifyBroadcasterFee(armadaCtx(), { to: SDK_POOL, data }, ADVERTISED_FEE),
      "FEE_INSUFFICIENT",
      /Broadcaster fee too low: paid 0 USDC raw/,
    );
  });

  it("ignores a fee note paid in a non-USDC token (unresolvable → skipped)", async () => {
    // WHY: single-token (USDC) policy must hold on the SDK path. A fee note in some other ERC20 fails
    // token-hash resolution in the getter, is swallowed as not-ours, and contributes nothing — the
    // same outcome as the stock path ignoring non-USDC outputs.
    const data = await transactWithFeeNote({
      receiver: broadcaster,
      feeAmount: ADVERTISED_FEE * 5n,
      tokenAddress: SDK_OTHER_TOKEN,
    });
    await expectRejectedAs(
      verifyBroadcasterFee(armadaCtx(), { to: SDK_POOL, data }, ADVERTISED_FEE),
      "FEE_INSUFFICIENT",
      /Broadcaster fee too low: paid 0 USDC raw/,
    );
  });
});
