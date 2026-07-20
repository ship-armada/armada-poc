/**
 * Hardhat integration: GaslessShieldWrapper end-to-end (permissionless, shielded fee note).
 *
 * Validates the ethers-side signing path — an EIP-2612 permit AND an EIP-712 ShieldIntent — against
 * the wrapper's contract logic. The Foundry tests (test-foundry/gasless/) cover edge cases against
 * mocks using vm.sign; this test exercises the SAME wrapper via ethers.signTypedData so the
 * interface + relayer signing path has a contract-level reference for domain / typed-data parity.
 *
 * Uses MockShieldRecorder rather than the real PrivacyPool — full pool deployment requires
 * Poseidon + modules + verifier setup that adds no value beyond what Sepolia manual testing covers.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GaslessShieldWrapper — ethers permit + intent integration", function () {
  let usdc: any;
  let pool: any;
  let wrapper: any;

  let deployer: SignerWithAddress;
  let submitter: SignerWithAddress; // arbitrary caller — the path is permissionless
  let user: SignerWithAddress;
  let integrator: SignerWithAddress;

  const ONE_USDC = 1_000_000n;
  const SHIELD_AMOUNT = 9n * ONE_USDC + ONE_USDC / 2n;
  const FEE = ONE_USDC / 2n;
  const TOTAL_AMOUNT = SHIELD_AMOUNT + FEE;

  const USER_NPK = "0x" + "BE".repeat(32);
  const RELAYER_NPK = "0x" + "F3".repeat(32);

  // EIP-2612 permit typed-data set. Matches OZ's ERC20Permit.
  const PERMIT_TYPES = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  // EIP-712 ShieldIntent typed-data set. Must match SHIELD_INTENT_TYPEHASH in the wrapper.
  const INTENT_TYPES = {
    ShieldIntent: [
      { name: "user", type: "address" },
      { name: "requestsHash", type: "bytes32" },
      { name: "integrator", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  // Solidity type of ShieldRequest[] for keccak256(abi.encode(shieldRequests)) parity.
  const SHIELD_REQUEST_ARRAY_TYPE =
    "tuple(" +
    "tuple(bytes32 npk,tuple(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value) preimage," +
    "tuple(bytes32[3] encryptedBundle,bytes32 shieldKey) ciphertext" +
    ")[]";

  beforeEach(async function () {
    [deployer, submitter, user, integrator] = await ethers.getSigners();

    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("USD Coin", "USDC");
    await usdc.waitForDeployment();

    const MockShieldRecorder = await ethers.getContractFactory("MockShieldRecorder");
    pool = await MockShieldRecorder.deploy(await usdc.getAddress());
    await pool.waitForDeployment();

    const GaslessShieldWrapper = await ethers.getContractFactory("GaslessShieldWrapper");
    wrapper = await GaslessShieldWrapper.deploy(await usdc.getAddress(), await pool.getAddress());
    await wrapper.waitForDeployment();

    await usdc.mint(user.address, 100n * ONE_USDC);
  });

  function note(npk: string, value: bigint) {
    return {
      preimage: {
        npk,
        token: { tokenType: 0, tokenAddress: usdc.target, tokenSubID: 0 },
        value,
      },
      ciphertext: {
        encryptedBundle: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
        shieldKey: ethers.ZeroHash,
      },
    };
  }

  // Canonical two-note array: user's own note + a fee note to the relayer's npk.
  function twoNotes(shieldAmount: bigint, fee: bigint) {
    return [note(USER_NPK, shieldAmount), note(RELAYER_NPK, fee)];
  }

  function requestsHashOf(requests: any[]) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode([SHIELD_REQUEST_ARRAY_TYPE], [requests]),
    );
  }

  async function signPermit(spender: string, value: bigint, deadline: bigint) {
    const { chainId } = await ethers.provider.getNetwork();
    const domain = { name: await usdc.name(), version: "1", chainId, verifyingContract: await usdc.getAddress() };
    const nonce = await usdc.nonces(user.address);
    const sig = await user.signTypedData(domain, PERMIT_TYPES, {
      owner: user.address,
      spender,
      value,
      nonce,
      deadline,
    });
    return ethers.Signature.from(sig);
  }

  async function signIntent(requestsHash: string, integratorAddr: string, deadline: bigint, nonce: bigint) {
    const { chainId } = await ethers.provider.getNetwork();
    const domain = {
      name: "ArmadaGaslessShield",
      version: "1",
      chainId,
      verifyingContract: await wrapper.getAddress(),
    };
    return user.signTypedData(domain, INTENT_TYPES, {
      user: user.address,
      requestsHash,
      integrator: integratorAddr,
      deadline,
      nonce,
    });
  }

  function params(deadline: bigint, nonce: bigint, integratorAddr: string, sig: ethers.Signature) {
    return {
      user: user.address,
      deadline,
      nonce,
      integrator: integratorAddr,
      permitV: sig.v,
      permitR: sig.r,
      permitS: sig.s,
    };
  }

  // WHY: pin the full round-trip — ethers' signTypedData produces a permit AND an intent signature
  // that the wrapper accepts, and a two-note shield delivers both the user note and the relayer fee
  // note to the pool with no dust. A regression in the TS signing path (wrong domain, wrong
  // requestsHash encoding, swapped fields) surfaces here before any real deployment.
  it("any submitter can broadcast a user-signed permit+intent; pool receives both notes", async function () {
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + 3600n;
    const reqs = twoNotes(SHIELD_AMOUNT, FEE);
    const rHash = requestsHashOf(reqs);

    const permitSig = await signPermit(await wrapper.getAddress(), TOTAL_AMOUNT, deadline);
    const intentSig = await signIntent(rHash, integrator.address, deadline, 0n);

    const userBefore = await usdc.balanceOf(user.address);

    // Submitted by an arbitrary account (not a privileged relayer) — permissionless.
    await wrapper
      .connect(submitter)
      .gaslessShield(params(deadline, 0n, integrator.address, permitSig), intentSig, reqs);

    expect(await usdc.balanceOf(await pool.getAddress())).to.equal(TOTAL_AMOUNT);
    expect(await usdc.balanceOf(user.address)).to.equal(userBefore - TOTAL_AMOUNT);
    expect(await usdc.balanceOf(await wrapper.getAddress())).to.equal(0n);
    expect(await pool.shieldCallCount()).to.equal(1n);
    expect(await pool.lastNoteCount()).to.equal(2n);
    expect(await pool.noteValues(0)).to.equal(SHIELD_AMOUNT);
    expect(await pool.noteValues(1)).to.equal(FEE);
    expect(await pool.noteNpks(1)).to.equal(RELAYER_NPK.toLowerCase());
    expect(await pool.lastIntegrator()).to.equal(integrator.address);
    expect(await wrapper.nonces(user.address)).to.equal(1n);
  });

  // WHY: the load-bearing security property. A front-runner who mutates the signed array (here,
  // swapping the user note's npk for their own) must be rejected because the intent binds
  // keccak256(abi.encode(shieldRequests)). This also pins that the TS requestsHash encoding matches
  // the contract's abi.encode — a drift would make honest calls fail and this test would catch it.
  it("rejects a submitted array that differs from the signed intent", async function () {
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + 3600n;
    const signedReqs = twoNotes(SHIELD_AMOUNT, FEE);
    const rHash = requestsHashOf(signedReqs);

    const permitSig = await signPermit(await wrapper.getAddress(), TOTAL_AMOUNT, deadline);
    const intentSig = await signIntent(rHash, integrator.address, deadline, 0n);

    // Attacker redirects the user note to their own npk while reusing the signatures.
    const tampered = twoNotes(SHIELD_AMOUNT, FEE);
    tampered[0].preimage.npk = "0x" + "AC".repeat(32);

    await expect(
      wrapper
        .connect(submitter)
        .gaslessShield(params(deadline, 0n, integrator.address, permitSig), intentSig, tampered),
    ).to.be.revertedWith("GaslessShieldWrapper: bad intent sig");
  });
});
