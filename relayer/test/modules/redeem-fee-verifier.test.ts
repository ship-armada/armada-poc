// ABOUTME: Unit tests for verifyRedeemFee — the gate that confirms a redeemAndShield fee note is
// ABOUTME: shielded to the relayer at the advertised amount before the relayer pays gas.

import { expect } from "chai";
import { ethers } from "ethers";
import { RailgunWallet, ShieldNote } from "@railgun-community/engine";
import { verifyRedeemFee, type RedeemFeeVerifierContext } from "../../modules/redeem-fee-verifier";
import { REDEEM_AND_SHIELD_ABI } from "../../lib/transact-shape";
import { RelayError } from "../../types";

const REDEEM_IFACE = new ethers.Interface(REDEEM_AND_SHIELD_ABI);
const ADVERTISED_FEE = 50_000n; // 0.05 USDC raw

// A field-element master public key for the relayer's own wallet, and a distinct one for an attacker.
const RELAYER_MPK = 1234567890123456789n;
const ATTACKER_MPK = 9876543210987654321n;
// 16-byte shield randoms (what generateRelayShieldRequests uses).
const RANDOM_A = "0x" + "ab".repeat(16);
const RANDOM_B = "0x" + "cd".repeat(16);

/** Wallet stub — verifyRedeemFee only reads masterPublicKey. */
function stubWallet(masterPublicKey: bigint): RailgunWallet {
  return { masterPublicKey } as unknown as RailgunWallet;
}
function ctxFor(mpk: bigint): RedeemFeeVerifierContext {
  return { wallet: stubWallet(mpk) };
}

const ZERO_CIPHERTEXT = {
  encryptedBundle: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
  shieldKey: ethers.ZeroHash,
};

// Minimal zeroed Transaction struct — the verifier never inspects arg 0, only the fee fields.
const DUMMY_TRANSACTION = {
  proof: { a: { x: 0n, y: 0n }, b: { x: [0n, 0n], y: [0n, 0n] }, c: { x: 0n, y: 0n } },
  merkleRoot: ethers.ZeroHash,
  nullifiers: [],
  commitments: [],
  boundParams: {
    treeNumber: 0,
    minGasPrice: 0n,
    unshield: 1,
    chainID: 0n,
    adaptContract: ethers.ZeroAddress,
    adaptParams: ethers.ZeroHash,
    commitmentCiphertext: [],
  },
  unshieldPreimage: {
    npk: ethers.ZeroHash,
    token: { tokenType: 0, tokenAddress: ethers.ZeroAddress, tokenSubID: 0n },
    value: 0n,
  },
};

/** Build redeemAndShield calldata with the given fee-note key + amount. */
function encodeRedeemCalldata(feeNpk: bigint, feeAmount: bigint): string {
  return REDEEM_IFACE.encodeFunctionData("redeemAndShield", [
    DUMMY_TRANSACTION,
    ethers.ZeroHash, // _npk (user's re-shield destination — not inspected)
    ZERO_CIPHERTEXT, // _shieldCiphertext
    ethers.toBeHex(feeNpk, 32), // _feeNpk
    ZERO_CIPHERTEXT, // _feeShieldCiphertext
    feeAmount, // _feeAmount
  ]);
}

/** The npk a fee note shielded to `mpk` with `random` would carry — mirrors the frontend. */
function noteKey(mpk: bigint, random: string): bigint {
  return ShieldNote.getNotePublicKey(mpk, random);
}

describe("verifyRedeemFee", () => {
  it("accepts a fee note shielded to the relayer at the advertised amount", () => {
    // WHY: the happy path — frontend shields the fee to the relayer's own 0zk with RANDOM_A and
    // passes RANDOM_A; the recomputed npk must match, proving the relayer is the payee.
    const feeNpk = noteKey(RELAYER_MPK, RANDOM_A);
    const data = encodeRedeemCalldata(feeNpk, ADVERTISED_FEE);
    const paid = verifyRedeemFee(ctxFor(RELAYER_MPK), { data }, ADVERTISED_FEE, RANDOM_A);
    expect(paid).to.equal(ADVERTISED_FEE);
  });

  it("accepts when the fee exceeds the advertised amount", () => {
    // WHY: overpayment is fine — the relayer only requires AT LEAST the advertised fee.
    const feeNpk = noteKey(RELAYER_MPK, RANDOM_A);
    const data = encodeRedeemCalldata(feeNpk, ADVERTISED_FEE * 2n);
    expect(verifyRedeemFee(ctxFor(RELAYER_MPK), { data }, ADVERTISED_FEE, RANDOM_A)).to.equal(
      ADVERTISED_FEE * 2n,
    );
  });

  it("rejects a fee note addressed to someone else (attacker steals the fee)", () => {
    // WHY: the core security property. A submitter builds a valid proof whose fee note is the
    // ATTACKER's address; the relayer would pay gas for a fee it never receives. Even though the
    // attacker supplies a random, the npk recomputed under the RELAYER's key can't match a note
    // committed to the attacker's key — so we reject.
    const feeNpk = noteKey(ATTACKER_MPK, RANDOM_A); // shielded to attacker
    const data = encodeRedeemCalldata(feeNpk, ADVERTISED_FEE);
    expect(() => verifyRedeemFee(ctxFor(RELAYER_MPK), { data }, ADVERTISED_FEE, RANDOM_A))
      .to.throw(RelayError)
      .with.property("code", "FEE_INSUFFICIENT");
  });

  it("rejects when the supplied random doesn't match the on-chain fee note", () => {
    // WHY: a mismatched random (even to our own key) means we can't prove this note is ours —
    // fail closed rather than submit on an unverifiable claim.
    const feeNpk = noteKey(RELAYER_MPK, RANDOM_A);
    const data = encodeRedeemCalldata(feeNpk, ADVERTISED_FEE);
    expect(() => verifyRedeemFee(ctxFor(RELAYER_MPK), { data }, ADVERTISED_FEE, RANDOM_B))
      .to.throw(RelayError)
      .with.property("code", "FEE_INSUFFICIENT");
  });

  it("rejects when the fee is below the advertised amount", () => {
    // WHY: a correctly-addressed but underpaid fee still doesn't cover the relayer's gas.
    const feeNpk = noteKey(RELAYER_MPK, RANDOM_A);
    const data = encodeRedeemCalldata(feeNpk, ADVERTISED_FEE - 1n);
    expect(() => verifyRedeemFee(ctxFor(RELAYER_MPK), { data }, ADVERTISED_FEE, RANDOM_A))
      .to.throw(RelayError)
      .with.property("code", "FEE_INSUFFICIENT");
  });

  it("rejects when feeShieldRandom is missing", () => {
    // WHY: without the random we cannot verify the destination at all — refuse rather than relay blind.
    const feeNpk = noteKey(RELAYER_MPK, RANDOM_A);
    const data = encodeRedeemCalldata(feeNpk, ADVERTISED_FEE);
    expect(() => verifyRedeemFee(ctxFor(RELAYER_MPK), { data }, ADVERTISED_FEE, undefined))
      .to.throw(RelayError)
      .with.property("code", "INVALID_DATA");
  });

  it("rejects calldata that isn't a redeemAndShield call", () => {
    // WHY: defensive decode guard — a wrong/garbled selector must fail loudly, not silently pass.
    expect(() => verifyRedeemFee(ctxFor(RELAYER_MPK), { data: "0xdeadbeef" }, ADVERTISED_FEE, RANDOM_A))
      .to.throw(RelayError)
      .with.property("code", "INVALID_DATA");
  });
});
