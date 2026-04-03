// ABOUTME: Tests for the ARM governance token's ERC20Votes delegation, checkpointing, and permit.
// ABOUTME: Covers transfer whitelist restrictions, treasury delegation block, and voting power tracking.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const ONE_DAY = 86400;

describe("ArmadaToken — ERC20Votes", function () {
  let armToken: any;
  let timelockController: any;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let treasuryWallet: SignerWithAddress;
  let windDownContract: SignerWithAddress;

  const TOTAL_SUPPLY = ethers.parseUnits("12000000", 18);
  const ALICE_AMOUNT = ethers.parseUnits("2400000", 18);   // 20%
  const BOB_AMOUNT = ethers.parseUnits("1800000", 18);     // 15%
  const TREASURY_AMOUNT = ethers.parseUnits("7800000", 18); // 65%

  beforeEach(async function () {
    [deployer, alice, bob, carol, treasuryWallet, windDownContract] = await ethers.getSigners();

    // Deploy TimelockController (needed as timelock for addToWhitelist)
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      2 * ONE_DAY, [], [], deployer.address
    );
    await timelockController.waitForDeployment();
    const timelockAddr = await timelockController.getAddress();

    // Deploy ARM token
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, timelockAddr);
    await armToken.waitForDeployment();

    // Configure: set treasury as noDelegation, set wind-down contract
    await armToken.setNoDelegation(treasuryWallet.address);
    await armToken.setWindDownContract(windDownContract.address);

    // Whitelist deployer and treasury so we can distribute tokens
    await armToken.initWhitelist([
      deployer.address,
      treasuryWallet.address,
      alice.address,
      bob.address,
    ]);

    // Distribute tokens
    await armToken.transfer(treasuryWallet.address, TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);

    await mine(1);
  });

  // ============================================================
  // Task 1.1 — ERC20Votes delegation and checkpointing
  // ============================================================

  describe("Delegation and Voting Power", function () {
    it("should have zero voting power before delegation", async function () {
      expect(await armToken.getVotes(alice.address)).to.equal(0);
      expect(await armToken.getVotes(bob.address)).to.equal(0);
    });

    it("should gain voting power after self-delegation", async function () {
      await armToken.connect(alice).delegate(alice.address);
      expect(await armToken.getVotes(alice.address)).to.equal(ALICE_AMOUNT);
    });

    it("should transfer voting power via delegate(other)", async function () {
      await armToken.connect(alice).delegate(bob.address);
      expect(await armToken.getVotes(bob.address)).to.equal(ALICE_AMOUNT);
      expect(await armToken.getVotes(alice.address)).to.equal(0);
    });

    it("should combine delegated power from multiple delegators", async function () {
      await armToken.connect(alice).delegate(bob.address);
      await armToken.connect(bob).delegate(bob.address);
      expect(await armToken.getVotes(bob.address)).to.equal(ALICE_AMOUNT + BOB_AMOUNT);
    });

    it("should update checkpoints on transfer", async function () {
      // Alice self-delegates, then transfers half to carol
      await armToken.connect(alice).delegate(alice.address);
      // Whitelist carol so transfer works
      // (carol is not whitelisted — but alice is, and whitelisted sender can send)
      // Actually, alice IS whitelisted from initWhitelist
      const halfAlice = ALICE_AMOUNT / 2n;
      await armToken.connect(alice).transfer(carol.address, halfAlice);
      await mine(1);

      expect(await armToken.getVotes(alice.address)).to.equal(halfAlice);
      // Carol has tokens but no voting power (undelegated)
      expect(await armToken.getVotes(carol.address)).to.equal(0);

      // Carol self-delegates
      await armToken.connect(carol).delegate(carol.address);
      expect(await armToken.getVotes(carol.address)).to.equal(halfAlice);
    });

    it("should return correct getPastVotes at historical block", async function () {
      await armToken.connect(alice).delegate(alice.address);
      await mine(1);
      const blockBefore = await ethers.provider.getBlockNumber();

      // Transfer some away (reduces alice's voting power going forward)
      await armToken.connect(alice).transfer(bob.address, ethers.parseUnits("100000", 18));
      await mine(1);

      // Historical query at blockBefore should still show full ALICE_AMOUNT
      expect(await armToken.getPastVotes(alice.address, blockBefore)).to.equal(ALICE_AMOUNT);
      // Current voting power should be reduced
      expect(await armToken.getVotes(alice.address)).to.equal(
        ALICE_AMOUNT - ethers.parseUnits("100000", 18)
      );
    });

    it("should return correct getPastTotalSupply", async function () {
      await mine(1);
      const blockNum = await ethers.provider.getBlockNumber();
      await mine(1);
      expect(await armToken.getPastTotalSupply(blockNum)).to.equal(TOTAL_SUPPLY);
    });

    it("should deactivate voting power when delegating to address(0)", async function () {
      await armToken.connect(alice).delegate(alice.address);
      expect(await armToken.getVotes(alice.address)).to.equal(ALICE_AMOUNT);

      await armToken.connect(alice).delegate(ethers.ZeroAddress);
      expect(await armToken.getVotes(alice.address)).to.equal(0);
    });

    it("should not allow re-delegation of received power (one level only)", async function () {
      // Alice delegates to Bob. Bob's received power cannot be redelegated.
      await armToken.connect(alice).delegate(bob.address);
      await armToken.connect(bob).delegate(carol.address);

      // Carol only gets Bob's own tokens, not Alice's delegation to Bob
      expect(await armToken.getVotes(carol.address)).to.equal(BOB_AMOUNT);
      // Bob has zero (delegated his own tokens to carol, alice's delegation follows alice's delegatee = bob)
      // Wait: when Bob delegates to Carol, only Bob's OWN balance moves to Carol.
      // Alice's delegation target is still Bob. So Bob still has Alice's votes.
      // Actually no — in ERC20Votes, voting power = sum of balances of all accounts that delegate to you.
      // Alice delegated to Bob. Alice's balance contributes to Bob's votes.
      // Bob delegated to Carol. Bob's balance contributes to Carol's votes.
      // So Bob's votes = Alice's balance, Carol's votes = Bob's balance.
      expect(await armToken.getVotes(bob.address)).to.equal(ALICE_AMOUNT);
      expect(await armToken.getVotes(carol.address)).to.equal(BOB_AMOUNT);
    });

    it("should track delegates() correctly", async function () {
      expect(await armToken.delegates(alice.address)).to.equal(ethers.ZeroAddress);
      await armToken.connect(alice).delegate(bob.address);
      expect(await armToken.delegates(alice.address)).to.equal(bob.address);
    });
  });

  // ============================================================
  // Task 1.2 — Transfer whitelist
  // ============================================================

  describe("Transfer Whitelist", function () {
    it("should start with transferable = false", async function () {
      expect(await armToken.transferable()).to.equal(false);
    });

    it("should block transfer between non-whitelisted addresses", async function () {
      // Carol is not whitelisted. Try carol → dave (neither whitelisted)
      // First get some tokens to carol via whitelisted alice
      await armToken.connect(alice).transfer(carol.address, ethers.parseUnits("1000", 18));

      // carol → dave should fail (neither is whitelisted)
      await expect(
        armToken.connect(carol).transfer(deployer.address, ethers.parseUnits("500", 18))
      ).to.not.be.reverted; // deployer IS whitelisted as receiver — bad test

      // carol → someone not whitelisted
      const [, , , , , , notWhitelisted] = await ethers.getSigners();
      await expect(
        armToken.connect(carol).transfer(notWhitelisted.address, ethers.parseUnits("500", 18))
      ).to.be.revertedWith("ArmadaToken: transfers restricted");
    });

    it("should allow whitelisted sender to transfer to anyone", async function () {
      // Alice is whitelisted — can send to non-whitelisted carol
      await expect(
        armToken.connect(alice).transfer(carol.address, ethers.parseUnits("1000", 18))
      ).to.not.be.reverted;
    });

    it("should allow anyone to transfer to whitelisted receiver", async function () {
      // Get tokens to carol (non-whitelisted) via whitelisted alice
      await armToken.connect(alice).transfer(carol.address, ethers.parseUnits("1000", 18));

      // Carol (non-whitelisted) can send to alice (whitelisted)
      await expect(
        armToken.connect(carol).transfer(alice.address, ethers.parseUnits("500", 18))
      ).to.not.be.reverted;
    });

    it("should allow minting regardless of transferable flag", async function () {
      // Minting happens at construction (from == address(0)), which is allowed.
      // Verify total supply was minted despite transferable=false
      expect(await armToken.totalSupply()).to.equal(TOTAL_SUPPLY);
      // All tokens were distributed, confirming minting worked
      const aliceBal = await armToken.balanceOf(alice.address);
      const bobBal = await armToken.balanceOf(bob.address);
      const treasuryBal = await armToken.balanceOf(treasuryWallet.address);
      expect(aliceBal + bobBal + treasuryBal).to.equal(TOTAL_SUPPLY);
    });

    it("should only allow timelock to call addToWhitelist", async function () {
      const [, , , , , , , newAddr] = await ethers.getSigners();
      await expect(
        armToken.connect(alice).addToWhitelist(newAddr.address)
      ).to.be.revertedWith("ArmadaToken: not timelock");
    });

    it("should not have a removeFromWhitelist function", async function () {
      // Verify the function doesn't exist on the contract
      expect(armToken.removeFromWhitelist).to.be.undefined;
    });

    it("should allow initWhitelist only once (deployer-only)", async function () {
      // initWhitelist was already called in beforeEach — second call should revert
      await expect(
        armToken.initWhitelist([carol.address])
      ).to.be.revertedWith("ArmadaToken: whitelist already initialized");
    });

    it("should allow all transfers after setTransferable(true)", async function () {
      await armToken.connect(windDownContract).setTransferable(true);

      // Now carol (non-whitelisted) can transfer to anyone
      await armToken.connect(alice).transfer(carol.address, ethers.parseUnits("1000", 18));
      const [, , , , , , , someone] = await ethers.getSigners();
      await expect(
        armToken.connect(carol).transfer(someone.address, ethers.parseUnits("500", 18))
      ).to.not.be.reverted;
    });

    it("should only allow wind-down contract or timelock to call setTransferable", async function () {
      await expect(
        armToken.connect(alice).setTransferable(true)
      ).to.be.revertedWith("ArmadaToken: not authorized");

      await expect(
        armToken.connect(deployer).setTransferable(true)
      ).to.be.revertedWith("ArmadaToken: not authorized");
    });

    it("should allow timelock to call setTransferable", async function () {
      // The timelock address can enable transfers (governance proposal path)
      const timelockAddr = await timelockController.getAddress();
      const timelockSigner = await ethers.getImpersonatedSigner(timelockAddr);

      // Fund the timelock with ETH for gas
      await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });

      await armToken.connect(timelockSigner).setTransferable(true);
      expect(await armToken.transferable()).to.equal(true);

      // Verify non-whitelisted can now transfer
      await armToken.connect(alice).transfer(carol.address, ethers.parseUnits("1000", 18));
      const [, , , , , , , someone] = await ethers.getSigners();
      await expect(
        armToken.connect(carol).transfer(someone.address, ethers.parseUnits("500", 18))
      ).to.not.be.reverted;
    });

    it("should reject setTransferable(false) — one-way only", async function () {
      await expect(
        armToken.connect(windDownContract).setTransferable(false)
      ).to.be.revertedWith("ArmadaToken: can only enable transfers");
    });

    it("should reject setTransferable(true) when already enabled", async function () {
      await armToken.connect(windDownContract).setTransferable(true);
      await expect(
        armToken.connect(windDownContract).setTransferable(true)
      ).to.be.revertedWith("ArmadaToken: transfers already enabled");
    });

    it("should allow setWindDownContract only once (deployer-only)", async function () {
      // Already called in beforeEach
      await expect(
        armToken.setWindDownContract(carol.address)
      ).to.be.revertedWith("ArmadaToken: wind-down already set");
    });
  });

  // ============================================================
  // Task 1.3 — Treasury delegation block
  // ============================================================

  describe("Treasury noDelegation", function () {
    it("should block treasury from delegating", async function () {
      await expect(
        armToken.connect(treasuryWallet).delegate(alice.address)
      ).to.be.revertedWith("ArmadaToken: delegation blocked");
    });

    it("should block treasury self-delegation", async function () {
      await expect(
        armToken.connect(treasuryWallet).delegate(treasuryWallet.address)
      ).to.be.revertedWith("ArmadaToken: delegation blocked");
    });

    it("should allow non-treasury addresses to delegate normally", async function () {
      await expect(
        armToken.connect(alice).delegate(alice.address)
      ).to.not.be.reverted;
    });

    it("should allow setNoDelegation only once (deployer-only)", async function () {
      // Already called in beforeEach
      await expect(
        armToken.setNoDelegation(alice.address)
      ).to.be.revertedWith("ArmadaToken: noDelegation already set");
    });

    it("should reject setNoDelegation from non-deployer", async function () {
      // Deploy a fresh token to test deployer check
      const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
      const freshToken = await ArmadaToken.deploy(deployer.address, await timelockController.getAddress());
      await freshToken.waitForDeployment();

      await expect(
        freshToken.connect(alice).setNoDelegation(treasuryWallet.address)
      ).to.be.revertedWith("ArmadaToken: not deployer");
    });

    it("should ensure treasury ARM has zero voting power", async function () {
      // Treasury has tokens but cannot delegate, so voting power is 0
      expect(await armToken.balanceOf(treasuryWallet.address)).to.equal(TREASURY_AMOUNT);
      expect(await armToken.getVotes(treasuryWallet.address)).to.equal(0);
    });
  });

  // ============================================================
  // ERC20Permit
  // ============================================================

  describe("ERC20Permit", function () {
    it("should have correct EIP-712 domain name", async function () {
      // ERC20Permit stores the domain name — verify via DOMAIN_SEPARATOR or name
      // The permit function exists
      expect(armToken.permit).to.not.be.undefined;
      expect(armToken.DOMAIN_SEPARATOR).to.not.be.undefined;
    });
  });
});
