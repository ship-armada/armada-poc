/**
 * Hardhat integration: GaslessShieldWrapper end-to-end.
 *
 * Validates the ethers-side EIP-2612 permit signing path against the wrapper's contract logic.
 * The Foundry tests (test-foundry/gasless/) already cover wrapper edge cases against mocks
 * using vm.sign; this test exercises the SAME wrapper against ethers.signTypedData so the
 * relayer's signing path (Phase B3) has a contract-level reference for permit shape parity.
 *
 * Uses MockShieldRecorder rather than the real PrivacyPool — full pool deployment requires
 * Poseidon + modules + verifier setup that adds no value beyond what Sepolia manual testing
 * covers in B2/B3.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GaslessShieldWrapper — ethers permit integration", function () {
  let usdc: any;
  let pool: any;
  let wrapper: any;

  let deployer: SignerWithAddress;
  let relayer: SignerWithAddress;
  let user: SignerWithAddress;
  let integrator: SignerWithAddress;

  const ONE_USDC = 1_000_000n;
  const TOTAL_AMOUNT = 10n * ONE_USDC;
  const FEE = ONE_USDC / 2n;
  const SHIELD_AMOUNT = TOTAL_AMOUNT - FEE;

  // EIP-2612 permit typed-data type set. Matches OZ's ERC20Permit implementation.
  const PERMIT_TYPES = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  beforeEach(async function () {
    [deployer, relayer, user, integrator] = await ethers.getSigners();

    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("USD Coin", "USDC");
    await usdc.waitForDeployment();

    const MockShieldRecorder = await ethers.getContractFactory("MockShieldRecorder");
    pool = await MockShieldRecorder.deploy(await usdc.getAddress());
    await pool.waitForDeployment();

    const GaslessShieldWrapper = await ethers.getContractFactory("GaslessShieldWrapper");
    wrapper = await GaslessShieldWrapper.deploy(
      await usdc.getAddress(),
      await pool.getAddress(),
      relayer.address,
    );
    await wrapper.waitForDeployment();

    // Fund the user; the deployer is the mock's default minter.
    await usdc.mint(user.address, 100n * ONE_USDC);
  });

  async function signPermit(
    signer: SignerWithAddress,
    spender: string,
    value: bigint,
    deadline: bigint,
  ) {
    // Domain matches what ERC20Permit derives internally (name from constructor + chainId).
    const { chainId } = await ethers.provider.getNetwork();
    const domain = {
      name: await usdc.name(),
      version: "1",
      chainId,
      verifyingContract: await usdc.getAddress(),
    };
    const nonce = await usdc.nonces(signer.address);
    const message = {
      owner: signer.address,
      spender,
      value,
      nonce,
      deadline,
    };
    const sig = await signer.signTypedData(domain, PERMIT_TYPES, message);
    return ethers.Signature.from(sig);
  }

  function shieldRequest(value: bigint) {
    return {
      preimage: {
        npk: "0x" + "BE".repeat(32),
        token: {
          tokenType: 0, // ERC20
          tokenAddress: usdc.target,
          tokenSubID: 0,
        },
        value,
      },
      ciphertext: {
        encryptedBundle: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
        shieldKey: ethers.ZeroHash,
      },
    };
  }

  // WHY: pin the round-trip — ethers' signTypedData produces a signature that the wrapper's
  // permit call accepts. A regression in the relayer's TS signing path (e.g. wrong domain
  // separator, missing chainId, swapped owner/spender) would surface here as ECDSA failure
  // before the wrapper even sees the call.
  it("relayer broadcasts a user-signed permit; pool receives the shield amount, relayer gets the fee", async function () {
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + 3600n;
    const sig = await signPermit(user, await wrapper.getAddress(), TOTAL_AMOUNT, deadline);

    const userBefore = await usdc.balanceOf(user.address);

    await wrapper
      .connect(relayer)
      .gaslessShield(
        user.address,
        TOTAL_AMOUNT,
        FEE,
        deadline,
        sig.v,
        sig.r,
        sig.s,
        shieldRequest(SHIELD_AMOUNT),
        integrator.address,
      );

    expect(await usdc.balanceOf(relayer.address)).to.equal(FEE);
    expect(await usdc.balanceOf(await pool.getAddress())).to.equal(SHIELD_AMOUNT);
    expect(await usdc.balanceOf(user.address)).to.equal(userBefore - TOTAL_AMOUNT);
    expect(await pool.shieldCallCount()).to.equal(1n);
    expect(await pool.lastValue()).to.equal(SHIELD_AMOUNT);
    expect(await pool.lastIntegrator()).to.equal(integrator.address);
  });

  // WHY: a wallet that mis-derives the domain (wrong contract name, wrong chainId) would
  // produce a signature ECDSA-recovers to a different address; the wrapper's permit call
  // rejects with the OZ ERC20Permit invalid-signer message. Pinning this prevents a silent
  // signing-domain drift across deployments (Sepolia vs local Anvil) from going unnoticed.
  it("rejects a permit signed against the wrong domain", async function () {
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + 3600n;
    const { chainId } = await ethers.provider.getNetwork();
    const wrongDomain = {
      name: "DIFFERENT TOKEN",
      version: "1",
      chainId,
      verifyingContract: await usdc.getAddress(),
    };
    const nonce = await usdc.nonces(user.address);
    const sig = ethers.Signature.from(
      await user.signTypedData(wrongDomain, PERMIT_TYPES, {
        owner: user.address,
        spender: await wrapper.getAddress(),
        value: TOTAL_AMOUNT,
        nonce,
        deadline,
      }),
    );

    await expect(
      wrapper
        .connect(relayer)
        .gaslessShield(
          user.address,
          TOTAL_AMOUNT,
          FEE,
          deadline,
          sig.v,
          sig.r,
          sig.s,
          shieldRequest(SHIELD_AMOUNT),
          integrator.address,
        ),
    ).to.be.reverted;
  });
});
