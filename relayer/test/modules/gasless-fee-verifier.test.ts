// ABOUTME: Unit tests for verifyGaslessFee — the gate that confirms the gasless shield fee note is
// ABOUTME: shielded to the relayer's own 0zk at the advertised amount before the relayer pays gas.

import { expect } from "chai";
import { ethers } from "ethers";
import { RailgunWallet, ShieldNote } from "@railgun-community/engine";
import {
  GASLESS_SHIELD_SELECTOR,
  GASLESS_CROSS_CHAIN_SHIELD_SELECTOR,
  verifyGaslessFee,
  type GaslessVerifierContext,
} from "../../modules/gasless-fee-verifier";
import { RelayError } from "../../types";

const HUB_CHAIN = 31337;
const CLIENT_CHAIN = 31338;

const HUB_WRAPPER = "0x" + "aa".repeat(20);
const CLIENT_WRAPPER = "0x" + "bb".repeat(20);
const ATTACKER_TARGET = "0x" + "cc".repeat(20);

const ADVERTISED = 50_000n; // 0.05 USDC raw

// Field-element master public key for the relayer, and a distinct one for an attacker.
const RELAYER_MPK = 1234567890123456789n;
const ATTACKER_MPK = 9876543210987654321n;
// 16-byte shield randoms (what createShieldRequest / generateRelayShieldRequests use).
const RANDOM_A = "ab".repeat(16);

const ZERO_BUNDLE = [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash];
const USER_NPK = "0x" + "14".repeat(32);
const TOKEN = "0x" + "15".repeat(20);
const INTENT_SIG = "0x" + "dd".repeat(65);

/** Wallet stub — verifyGaslessFee only reads masterPublicKey. */
function stubWallet(masterPublicKey: bigint): RailgunWallet {
  return { masterPublicKey } as unknown as RailgunWallet;
}
function ctx(mpk: bigint = RELAYER_MPK): GaslessVerifierContext {
  return {
    wrappersByChain: new Map([
      [HUB_CHAIN, HUB_WRAPPER],
      [CLIENT_CHAIN, CLIENT_WRAPPER],
    ]),
    wallet: stubWallet(mpk),
  };
}

/** The npk a fee note shielded to `mpk` with `random` would carry — mirrors the frontend. */
function noteKey(mpk: bigint, random: string): bigint {
  return ShieldNote.getNotePublicKey(mpk, random);
}

// New-shape ABIs, kept here separately so a divergence from the source surfaces as a test failure.
const HUB_IFACE = new ethers.Interface([
  "function gaslessShield((address user,uint256 deadline,uint256 nonce,address integrator,uint8 permitV,bytes32 permitR,bytes32 permitS) params, bytes intentSig, ((bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value) preimage,(bytes32[3] encryptedBundle,bytes32 shieldKey) ciphertext)[] shieldRequests)",
]);
const CLIENT_IFACE = new ethers.Interface([
  "function gaslessCrossChainShield((address user,uint256 deadline,uint256 nonce,uint256 maxFee,uint32 minFinalityThreshold,uint8 permitV,bytes32 permitR,bytes32 permitS) params, bytes intentSig, (bytes32 npk,uint120 value,bytes32[3] encryptedBundle,bytes32 shieldKey,address integrator) userNote, (bytes32 npk,uint120 value,bytes32[3] encryptedBundle,bytes32 shieldKey,address integrator) feeNote)",
]);

const HUB_PARAMS = [
  "0x" + "11".repeat(20), // user
  9_999_999_999n, // deadline
  0n, // nonce
  ethers.ZeroAddress, // integrator
  27, // permitV
  "0x" + "12".repeat(32), // permitR
  "0x" + "13".repeat(32), // permitS
];
const CLIENT_PARAMS = [
  "0x" + "21".repeat(20), // user
  9_999_999_999n, // deadline
  0n, // nonce
  1_000n, // maxFee
  1_000, // minFinalityThreshold
  27, // permitV
  "0x" + "22".repeat(32), // permitR
  "0x" + "23".repeat(32), // permitS
];

/** Hub calldata: [userNote, feeNote]. feeNote carries feeNpk + feeValue. */
function encodeHubShield(feeNpk: bigint, feeValue: bigint): string {
  const userNote = [[USER_NPK, [0, TOKEN, 0n], 100_000n], [ZERO_BUNDLE, ethers.ZeroHash]];
  const feeNote = [[ethers.toBeHex(feeNpk, 32), [0, TOKEN, 0n], feeValue], [ZERO_BUNDLE, ethers.ZeroHash]];
  return HUB_IFACE.encodeFunctionData("gaslessShield", [HUB_PARAMS, INTENT_SIG, [userNote, feeNote]]);
}

/** Client calldata: userNote + feeNote args. */
function encodeClientShield(feeNpk: bigint, feeValue: bigint): string {
  const userNote = [USER_NPK, 100_000n, ZERO_BUNDLE, ethers.ZeroHash, ethers.ZeroAddress];
  const feeNote = [ethers.toBeHex(feeNpk, 32), feeValue, ZERO_BUNDLE, ethers.ZeroHash, ethers.ZeroAddress];
  return CLIENT_IFACE.encodeFunctionData("gaslessCrossChainShield", [
    CLIENT_PARAMS,
    INTENT_SIG,
    userNote,
    feeNote,
  ]);
}

describe("verifyGaslessFee", () => {
  it("pins the hub `gaslessShield` selector", () => {
    // WHY: the selector is hardcoded in privacy-relay's ALLOWED_SELECTORS table AND in the frontend
    // calldata builder. A wrapper-signature refactor would change it and silently break gasless
    // relaying until all three are updated. Pin the value so the test fails loudly first.
    const expected = ethers
      .id(
        "gaslessShield((address,uint256,uint256,address,uint8,bytes32,bytes32),bytes,((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32))[])",
      )
      .slice(0, 10);
    expect(GASLESS_SHIELD_SELECTOR).to.equal(expected);
    expect(GASLESS_SHIELD_SELECTOR).to.equal("0x6e53fbcb");
  });

  it("pins the client `gaslessCrossChainShield` selector", () => {
    const expected = ethers
      .id(
        "gaslessCrossChainShield((address,uint256,uint256,uint256,uint32,uint8,bytes32,bytes32),bytes,(bytes32,uint120,bytes32[3],bytes32,address),(bytes32,uint120,bytes32[3],bytes32,address))",
      )
      .slice(0, 10);
    expect(GASLESS_CROSS_CHAIN_SHIELD_SELECTOR).to.equal(expected);
    expect(GASLESS_CROSS_CHAIN_SHIELD_SELECTOR).to.equal("0xd34e1968");
  });

  it("accepts a hub request whose fee note is shielded to the relayer at the advertised amount", () => {
    // WHY: the load-bearing happy path — the frontend built the fee note to the relayer's own 0zk
    // with RANDOM_A and passes RANDOM_A; the recomputed npk must match, proving the relayer is paid.
    const data = encodeHubShield(noteKey(RELAYER_MPK, RANDOM_A), ADVERTISED);
    verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED, RANDOM_A);
  });

  it("accepts a hub request that overpays", () => {
    const data = encodeHubShield(noteKey(RELAYER_MPK, RANDOM_A), ADVERTISED * 2n);
    verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED, RANDOM_A);
  });

  it("rejects a hub request whose fee note underpays with FEE_INSUFFICIENT", () => {
    // WHY: THE reason the verifier exists — a client crafts a fee note below the quote and the
    // relayer would eat gas for less compensation than advertised. Pin the >= check.
    const data = encodeHubShield(noteKey(RELAYER_MPK, RANDOM_A), ADVERTISED - 1n);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED, RANDOM_A),
    ).to.throw(RelayError, /FEE_INSUFFICIENT|below advertised/);
  });

  it("rejects a hub request whose fee note is addressed to someone else", () => {
    // WHY: the core theft-resistance for the relayer's economics. A submitter builds a valid call
    // whose fee note pays THEIR 0zk (not ours). We reconstruct npk from our own master key + the
    // supplied random and find no matching note → refuse rather than pay gas for nothing.
    const data = encodeHubShield(noteKey(ATTACKER_MPK, RANDOM_A), ADVERTISED);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED, RANDOM_A),
    ).to.throw(RelayError, /FEE_INSUFFICIENT|no fee note addressed to the relayer/);
  });

  it("rejects when feeShieldRandom is missing", () => {
    // WHY: without the random we cannot prove the fee is ours — must refuse, not submit blind.
    const data = encodeHubShield(noteKey(RELAYER_MPK, RANDOM_A), ADVERTISED);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED, undefined),
    ).to.throw(RelayError, /INVALID_DATA|requires feeShieldRandom/);
  });

  it("rejects a hub request to a non-wrapper target with INVALID_TARGET", () => {
    const data = encodeHubShield(noteKey(RELAYER_MPK, RANDOM_A), ADVERTISED);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: ATTACKER_TARGET, data }, ADVERTISED, RANDOM_A),
    ).to.throw(RelayError, /INVALID_TARGET|does not match configured wrapper/);
  });

  it("rejects a request with an unconfigured chainId", () => {
    const data = encodeHubShield(noteKey(RELAYER_MPK, RANDOM_A), ADVERTISED);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: 999_999, to: HUB_WRAPPER, data }, ADVERTISED, RANDOM_A),
    ).to.throw(RelayError, /INVALID_CHAIN|No gasless wrapper configured/);
  });

  it("rejects a request whose target is a wrapper for the WRONG chain", () => {
    const data = encodeHubShield(noteKey(RELAYER_MPK, RANDOM_A), ADVERTISED);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: CLIENT_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED, RANDOM_A),
    ).to.throw(RelayError, /does not match configured wrapper/);
  });

  it("accepts a client cross-chain request whose fee note is shielded to the relayer", () => {
    const data = encodeClientShield(noteKey(RELAYER_MPK, RANDOM_A), ADVERTISED);
    verifyGaslessFee(ctx(), { chainId: CLIENT_CHAIN, to: CLIENT_WRAPPER, data }, ADVERTISED, RANDOM_A);
  });

  it("rejects a client request that underpays with FEE_INSUFFICIENT", () => {
    const data = encodeClientShield(noteKey(RELAYER_MPK, RANDOM_A), ADVERTISED - 1n);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: CLIENT_CHAIN, to: CLIENT_WRAPPER, data }, ADVERTISED, RANDOM_A),
    ).to.throw(RelayError, /below advertised/);
  });

  it("rejects a client request whose fee note is addressed to someone else", () => {
    const data = encodeClientShield(noteKey(ATTACKER_MPK, RANDOM_A), ADVERTISED);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: CLIENT_CHAIN, to: CLIENT_WRAPPER, data }, ADVERTISED, RANDOM_A),
    ).to.throw(RelayError, /no fee note addressed to the relayer/);
  });

  it("rejects an unknown selector with INVALID_DATA", () => {
    const data = "0xdeadbeef" + "00".repeat(64);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED, RANDOM_A),
    ).to.throw(RelayError, /INVALID_DATA|not a supported gasless wrapper/);
  });

  it("rejects malformed gaslessShield calldata with INVALID_DATA", () => {
    const data = GASLESS_SHIELD_SELECTOR + "00".repeat(8); // selector + garbage
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED, RANDOM_A),
    ).to.throw(RelayError, /INVALID_DATA|Failed to decode/);
  });

  it("ignores the request `to` casing — addresses normalize to lowercase", () => {
    const data = encodeHubShield(noteKey(RELAYER_MPK, RANDOM_A), ADVERTISED);
    const mixedCaseWrapper = ethers.getAddress(HUB_WRAPPER); // checksummed
    verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: mixedCaseWrapper, data }, ADVERTISED, RANDOM_A);
  });
});
