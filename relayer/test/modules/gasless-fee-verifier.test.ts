// ABOUTME: Unit tests for verifyGaslessFee — the security gate that rejects /relay requests
// ABOUTME: whose gasless wrapper calldata pays the relayer less than the advertised fee.

import { expect } from "chai";
import { ethers } from "ethers";
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
const RELAYER_TARGET = "0x" + "dd".repeat(20);

const ADVERTISED = 50_000n; // 0.05 USDC raw

function ctx(): GaslessVerifierContext {
  return {
    wrappersByChain: new Map([
      [HUB_CHAIN, HUB_WRAPPER],
      [CLIENT_CHAIN, CLIENT_WRAPPER],
    ]),
  };
}

// Mirrors the production wrapper ABI shape — kept here separately so a divergence (someone
// editing GASLESS_SHIELD_ABI in the source) surfaces as a test failure rather than silent
// acceptance of the wrong shape.
const HUB_IFACE = new ethers.Interface([
  "function gaslessShield(address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s, ((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32)) shieldRequest, address integrator)",
]);

const CLIENT_IFACE = new ethers.Interface([
  "function gaslessCrossChainShield((address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permitInput, (uint256 maxFee, uint32 minFinalityThreshold, bytes32 npk, bytes32[3] encryptedBundle, bytes32 shieldKey, address integrator) dest)",
]);

function encodeHubShield(fee: bigint): string {
  return HUB_IFACE.encodeFunctionData("gaslessShield", [
    "0x" + "11".repeat(20), // user
    100_000n, // totalAmount
    fee, // fee
    9_999_999_999n, // deadline
    27, // v
    "0x" + "12".repeat(32), // r
    "0x" + "13".repeat(32), // s
    [
      // shieldRequest: (preimage, ciphertext)
      [
        // preimage: (npk, token, value)
        "0x" + "14".repeat(32), // npk
        [0, "0x" + "15".repeat(20), 0n], // token: ERC20, addr, subId
        99_950n, // value
      ],
      [
        // ciphertext: (encryptedBundle, shieldKey)
        ["0x" + "00".repeat(32), "0x" + "00".repeat(32), "0x" + "00".repeat(32)],
        "0x" + "00".repeat(32),
      ],
    ],
    "0x" + "16".repeat(20), // integrator
  ]);
}

function encodeClientShield(fee: bigint): string {
  return CLIENT_IFACE.encodeFunctionData("gaslessCrossChainShield", [
    [
      "0x" + "21".repeat(20), // user
      100_000n, // totalAmount
      fee, // fee
      9_999_999_999n, // deadline
      27, // v
      "0x" + "22".repeat(32), // r
      "0x" + "23".repeat(32), // s
    ],
    [
      1_000n, // maxFee
      1_000, // minFinalityThreshold
      "0x" + "24".repeat(32), // npk
      ["0x" + "00".repeat(32), "0x" + "00".repeat(32), "0x" + "00".repeat(32)], // encryptedBundle
      "0x" + "00".repeat(32), // shieldKey
      "0x" + "26".repeat(20), // integrator
    ],
  ]);
}

describe("verifyGaslessFee", () => {
  it("pins the hub `gaslessShield` selector", () => {
    // WHY: the selector is hardcoded in privacy-relay's ALLOWED_SELECTORS table. A wrapper
    // signature refactor (e.g. arg reorder, struct rename) would change the selector and the
    // relayer would silently reject all gasless requests until ALLOWED_SELECTORS is updated.
    // Pin the value so the test fails loudly first.
    const expected = ethers
      .id(
        "gaslessShield(address,uint256,uint256,uint256,uint8,bytes32,bytes32,((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32)),address)",
      )
      .slice(0, 10);
    expect(GASLESS_SHIELD_SELECTOR).to.equal(expected);
  });

  it("pins the client `gaslessCrossChainShield` selector", () => {
    // WHY: same rationale as the hub-selector pin. Client wrapper has a different signature
    // (struct-grouped args), distinct selector — both have to stay in lock-step with the
    // ABLOWED_SELECTORS table.
    const expected = ethers
      .id(
        "gaslessCrossChainShield((address,uint256,uint256,uint256,uint8,bytes32,bytes32),(uint256,uint32,bytes32,bytes32[3],bytes32,address))",
      )
      .slice(0, 10);
    expect(GASLESS_CROSS_CHAIN_SHIELD_SELECTOR).to.equal(expected);
  });

  it("accepts a hub request that pays exactly the advertised fee", () => {
    // WHY: the load-bearing happy path. A regression that off-by-one'd the comparison (`>`
    // instead of `>=`) would reject all requests paying the exact quoted amount.
    const data = encodeHubShield(ADVERTISED);
    verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED);
  });

  it("accepts a hub request that overpays", () => {
    const data = encodeHubShield(ADVERTISED * 2n);
    verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED);
  });

  it("rejects a hub request that underpays with FEE_INSUFFICIENT", () => {
    // WHY: this IS the verifier's reason for existing. Without it, a malicious client crafts a
    // gasless request whose `transferFrom(user, relayer, fee)` step sends 0 USDC, and the
    // relayer eats the on-chain gas for no compensation. Pin the strict-equality check.
    const data = encodeHubShield(ADVERTISED - 1n);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED),
    ).to.throw(RelayError, /FEE_INSUFFICIENT|below advertised/);
  });

  it("rejects a hub request to a non-wrapper target with INVALID_TARGET", () => {
    // WHY: defense in depth. The privacy-relay's `allowedTargets` per-chain set already gates
    // by address, but if a future refactor accidentally widens it (e.g. adds a debugging
    // helper that allows any contract), the verifier should still pin the wrapper. Without it
    // an "approved" non-wrapper contract could emit a Transfer(fee, ATTACKER) that we'd
    // mistake for payment.
    const data = encodeHubShield(ADVERTISED);
    expect(() =>
      verifyGaslessFee(
        ctx(),
        { chainId: HUB_CHAIN, to: ATTACKER_TARGET, data },
        ADVERTISED,
      ),
    ).to.throw(RelayError, /INVALID_TARGET|does not match configured wrapper/);
  });

  it("rejects a request with an unconfigured chainId", () => {
    // WHY: defense in depth — privacy-relay's chain-id check runs first, but a misconfigured
    // boot (chain present in wallet-manager but absent from wrappersByChain) would otherwise
    // bypass fee verification entirely. Surface as a clear error rather than a default-fee
    // silent acceptance.
    const data = encodeHubShield(ADVERTISED);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: 999_999, to: HUB_WRAPPER, data }, ADVERTISED),
    ).to.throw(RelayError, /INVALID_CHAIN|No gasless wrapper configured/);
  });

  it("rejects a request whose target is a wrapper for the WRONG chain", () => {
    // WHY: per-chain pinning matters. Same EOA across chains means the same hub-wrapper
    // address could theoretically appear in a client-chain request body. The target check
    // looks up the wrapper for the REQUEST's chain, so a hub wrapper address sent to the
    // client wrapper's chain rejects.
    const data = encodeHubShield(ADVERTISED);
    expect(() =>
      verifyGaslessFee(
        ctx(),
        { chainId: CLIENT_CHAIN, to: HUB_WRAPPER, data }, // hub address, client chain
        ADVERTISED,
      ),
    ).to.throw(RelayError, /does not match configured wrapper/);
  });

  it("accepts a client cross-chain request that pays exactly the advertised fee", () => {
    const data = encodeClientShield(ADVERTISED);
    verifyGaslessFee(
      ctx(),
      { chainId: CLIENT_CHAIN, to: CLIENT_WRAPPER, data },
      ADVERTISED,
    );
  });

  it("rejects a client request that underpays with FEE_INSUFFICIENT", () => {
    const data = encodeClientShield(ADVERTISED - 1n);
    expect(() =>
      verifyGaslessFee(
        ctx(),
        { chainId: CLIENT_CHAIN, to: CLIENT_WRAPPER, data },
        ADVERTISED,
      ),
    ).to.throw(RelayError, /below advertised/);
  });

  it("rejects an unknown selector with INVALID_DATA", () => {
    // WHY: a calldata payload that lands at the verifier but isn't either gasless selector
    // shouldn't be silently treated as one — the privacy-relay's selector gate catches this
    // upstream, but the verifier asserts defensively too. A test ensures the defensive branch
    // doesn't bitrot into "passes silently."
    const data = "0xdeadbeef" + "00".repeat(64);
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED),
    ).to.throw(RelayError, /INVALID_DATA|not a supported gasless wrapper/);
  });

  it("rejects malformed gaslessShield calldata with INVALID_DATA", () => {
    // WHY: a request whose selector matches but body is truncated/garbled would crash the ABI
    // decoder with a runtime error. The verifier wraps that into a RelayError so the HTTP API
    // returns a clean 400 instead of a 500.
    const data = GASLESS_SHIELD_SELECTOR + "00".repeat(8); // selector + garbage
    expect(() =>
      verifyGaslessFee(ctx(), { chainId: HUB_CHAIN, to: HUB_WRAPPER, data }, ADVERTISED),
    ).to.throw(RelayError, /INVALID_DATA|Failed to decode/);
  });

  it("ignores the request `to` casing — addresses normalize to lowercase", () => {
    // WHY: ethers' encodeFunctionData returns mixed-case addresses (EIP-55 checksum). A naive
    // string compare against the lowercased wrapper would reject a checksummed address even
    // though it's the same wrapper. Pin the lowercase normalisation.
    const data = encodeHubShield(ADVERTISED);
    const mixedCaseWrapper = ethers.getAddress(HUB_WRAPPER); // checksummed
    verifyGaslessFee(
      ctx(),
      { chainId: HUB_CHAIN, to: mixedCaseWrapper, data },
      ADVERTISED,
    );
  });
});
