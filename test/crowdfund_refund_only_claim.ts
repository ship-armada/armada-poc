// ABOUTME: Integration test for the committer's first-sale refund module (lib/refundOnlyClaim) against a real crowdfund.
// ABOUTME: Commit, Security Council cancel, then read and claim through the module's own ABI; USDC must come back.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type * as RefundOnlyClaimModule from "../crowdfund-ui/packages/committer/src/lib/refundOnlyClaim";
import type { RefundOnlyReader } from "../crowdfund-ui/packages/committer/src/lib/refundOnlyClaim";

// The committer package is an ES module ("type": "module"), which Hardhat's CommonJS test runner
// can't require directly; tsx's CommonJS API loads the TypeScript source as-is, so the test runs
// the exact module the /refund page uses.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tsx = require("tsx/cjs/api") as { require: (id: string, from: string) => unknown };
const { readRefundOnlyClaim, refundOnlyContract } = tsx.require(
  "../crowdfund-ui/packages/committer/src/lib/refundOnlyClaim.ts",
  __filename,
) as typeof RefundOnlyClaimModule;

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

describe("Committer first-sale refund module (refundOnlyClaim)", function () {
  let crowdfund: any;
  let usdc: any;
  let cfAddr: string;
  let deployer: SignerWithAddress;
  let seed1: SignerWithAddress;
  let seed2: SignerWithAddress;
  let outsider: SignerWithAddress;

  const read = (wallet: string) =>
    readRefundOnlyClaim(refundOnlyContract(cfAddr, ethers.provider) as unknown as RefundOnlyReader, wallet);

  beforeEach(async function () {
    [deployer, seed1, seed2, outsider] = await ethers.getSigners();
    const treasury = (await ethers.getSigners())[9];

    usdc = await (await ethers.getContractFactory("MockUSDCV2")).deploy("Mock USDC", "USDC");
    const armToken = await (await ethers.getContractFactory("ArmadaToken")).deploy(deployer.address, deployer.address);
    await armToken.initWhitelist([deployer.address]);

    crowdfund = await (await ethers.getContractFactory("ArmadaCrowdfund")).deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasury.address,
      deployer.address, // launch team
      deployer.address, // security council
      (await time.latest()) + 300,
    );
    cfAddr = await crowdfund.getAddress();
    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);
    await armToken.transfer(cfAddr, ARM(1_800_000));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());

    await crowdfund.addSeeds([seed1.address, seed2.address]);
    for (const [s, amount] of [[seed1, USDC(1_000)], [seed2, USDC(500)]] as const) {
      await usdc.mint(s.address, amount);
      await usdc.connect(s).approve(cfAddr, amount);
      await crowdfund.connect(s).commit(0, amount);
    }
  });

  // WHY: claimRefund() reverts on an active sale; the module must never offer it there.
  it("reports unavailable while the sale is active", async function () {
    expect(await read(seed1.address)).to.deep.equal({ kind: "unavailable" });
  });

  // WHY: the end-to-end path the /refund page runs: the module reads the contract-authoritative
  // amount after a cancel, claimRefund() through the module's own ABI returns exactly that USDC,
  // and the wallet then reads as claimed.
  it("reads the refund after a cancel, claims it, then reads it as claimed", async function () {
    await crowdfund.connect(deployer).cancel();

    expect(await read(seed1.address)).to.deep.equal({ kind: "eligible", amount: USDC(1_000) });
    expect(await read(outsider.address)).to.deep.equal({ kind: "none" });

    const before = await usdc.balanceOf(seed1.address);
    await (await refundOnlyContract(cfAddr, seed1).claimRefund()).wait();
    expect((await usdc.balanceOf(seed1.address)) - before).to.equal(USDC(1_000));

    expect(await read(seed1.address)).to.deep.equal({ kind: "claimed", amount: USDC(1_000) });
    // Another wallet's refund is untouched.
    expect(await read(seed2.address)).to.deep.equal({ kind: "eligible", amount: USDC(500) });
  });
});
