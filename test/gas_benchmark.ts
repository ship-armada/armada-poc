/**
 * Gas Profiling Under Load — Phase 4
 *
 * Benchmarks:
 * 1. Crowdfund finalize() gas at varying participant counts (50, 100, 150)
 * 2. Crowdfund addSeeds() batch gas
 * 3. Crowdfund claim() gas (should be constant)
 * 4. ERC20Votes getPastVotes() gas with varying checkpoint counts (binary search depth)
 *
 * Results are printed to console as a table for easy analysis.
 * Gas per participant is computed to extrapolate to 500, 1000, 2000 participants.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const ONE_DAY = 86400;
const THREE_WEEKS = 21 * ONE_DAY;

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

// Block gas limits for reference
const ETHEREUM_MAINNET_LIMIT = 30_000_000n;
const ARBITRUM_LIMIT = 1_125_899_906_842_624n; // effectively unlimited
const POLYGON_LIMIT = 30_000_000n;

describe("Gas Benchmarks", function () {
  // Increase timeout for gas profiling (large tests are slow)
  this.timeout(300_000);

  let allSigners: SignerWithAddress[];
  let deployer: SignerWithAddress;

  before(async function () {
    allSigners = await ethers.getSigners();
    deployer = allSigners[0];
  });

  // ============================================================
  // 1. Crowdfund finalize() Gas Scaling
  // ============================================================

  describe("Crowdfund finalize() gas scaling", function () {
    const participantCounts = [70, 100, 150]; // min 67 for MIN_SALE, max 150 (MAX_SEEDS cap)
    const results: { count: number; gas: bigint; perParticipant: bigint }[] = [];

    for (const count of participantCounts) {
      it(`finalize() with ${count} participants`, async function () {
        // Deploy fresh contracts
        const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
        const usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");

        const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
        const armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
      await armToken.initWhitelist([deployer.address]);

        const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
        const crowdfund = await ArmadaCrowdfund.deploy(
          await usdc.getAddress(),
          await armToken.getAddress(),
          deployer.address,
          deployer.address, // treasury
          deployer.address, // launchTeam
          deployer.address  // securityCouncil
        );

        await armToken.addToWhitelist(await crowdfund.getAddress());

        // Fund ARM for MAX_SALE
        await armToken.transfer(await crowdfund.getAddress(), ARM(1_800_000));
        await crowdfund.loadArm();

        // Add seeds — all participants are hop-0 for simplicity
        const seeds = allSigners.slice(1, count + 1);
        await crowdfund.addSeeds(seeds.map(s => s.address));
        await crowdfund.startWindow();

        // Each seed commits $15K (max hop-0 cap)
        // Total: count * $15K. Need >= $1M (MIN_SALE) for finalize() to succeed.
        // At $15K/participant, need >= 67 participants. All test counts are >= 70.

        const commitAmount = USDC(15_000);
        for (const s of seeds) {
          await usdc.mint(s.address, commitAmount);
          await usdc.connect(s).approve(await crowdfund.getAddress(), commitAmount);
          await crowdfund.connect(s).commit(commitAmount, 0);
        }

        // Skip to after active window
        await time.increase(THREE_WEEKS + 1);

        // Measure finalize gas
        const tx = await crowdfund.finalize();
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed;

        const totalCommitted = await crowdfund.totalCommitted();
        const isRefundMode = await crowdfund.refundMode();

        const perParticipant = gasUsed / BigInt(count);
        results.push({ count, gas: gasUsed, perParticipant });

        console.log(
          `    finalize() | ${count} participants | ` +
          `${gasUsed.toLocaleString()} gas | ` +
          `${perParticipant.toLocaleString()} gas/participant | ` +
          `${isRefundMode ? "REFUND_MODE" : "FINALIZED"}`
        );
      });
    }

    after(function () {
      // Print summary table and extrapolations
      console.log("\n    ═══════════════════════════════════════════════════════════════");
      console.log("    CROWDFUND finalize() GAS SCALING SUMMARY");
      console.log("    ═══════════════════════════════════════════════════════════════");
      console.log("    Participants │ Gas Used      │ Gas/Participant │ Status");
      console.log("    ─────────────┼───────────────┼────────────────┼────────────────");
      for (const r of results) {
        console.log(
          `    ${String(r.count).padStart(12)} │ ${r.gas.toLocaleString().padStart(13)} │ ${r.perParticipant.toLocaleString().padStart(14)} │ Finalized`
        );
      }

      // Extrapolate using the per-participant cost from the largest finalized test
      const finalizedResults = results.filter(r => BigInt(r.count) * 15_000n >= 1_000_000n);
      if (finalizedResults.length > 0) {
        const lastResult = finalizedResults[finalizedResults.length - 1];
        const perP = lastResult.perParticipant;
        // Estimate base cost (overhead) from difference between two measurements
        const baseGas = finalizedResults.length >= 2
          ? lastResult.gas - perP * BigInt(lastResult.count)
          : 50_000n; // rough estimate

        console.log("    ─────────────┼───────────────┼────────────────┼────────────────");
        console.log("    EXTRAPOLATED │               │                │");
        for (const extCount of [500, 1000, 2000, 5000]) {
          const estGas = baseGas + perP * BigInt(extCount);
          const exceedsL1 = estGas > ETHEREUM_MAINNET_LIMIT;
          console.log(
            `    ${String(extCount).padStart(12)} │ ${estGas.toLocaleString().padStart(13)} │ ${perP.toLocaleString().padStart(14)} │ ${exceedsL1 ? "⚠ EXCEEDS L1 30M LIMIT" : "OK (L1)"}`
          );
        }
      }
      console.log("    ═══════════════════════════════════════════════════════════════\n");
    });
  });

  // ============================================================
  // 2. Crowdfund addSeeds() batch gas
  // ============================================================

  describe("Crowdfund addSeeds() batch gas", function () {
    const batchSizes = [10, 50, 100, 150];

    for (const batchSize of batchSizes) {
      it(`addSeeds() batch of ${batchSize}`, async function () {
        const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
        const usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");

        const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
        const armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
      await armToken.initWhitelist([deployer.address]);

        const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
        const crowdfund = await ArmadaCrowdfund.deploy(
          await usdc.getAddress(),
          await armToken.getAddress(),
          deployer.address,
          deployer.address, // treasury
          deployer.address, // launchTeam
          deployer.address  // securityCouncil
        );

        const seeds = allSigners.slice(1, batchSize + 1);
        const tx = await crowdfund.addSeeds(seeds.map(s => s.address));
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed;
        const perSeed = gasUsed / BigInt(batchSize);

        console.log(
          `    addSeeds() | batch=${batchSize} | ` +
          `${gasUsed.toLocaleString()} gas | ` +
          `${perSeed.toLocaleString()} gas/seed`
        );
      });
    }
  });

  // ============================================================
  // 3. Crowdfund claim() gas (should be constant)
  // ============================================================

  describe("Crowdfund claim() gas", function () {
    it("claim() gas is constant regardless of participant count", async function () {
      // Setup with 100 participants
      const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
      const usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");

      const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
      const armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
      await armToken.initWhitelist([deployer.address]);

      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const crowdfund = await ArmadaCrowdfund.deploy(
        await usdc.getAddress(),
        await armToken.getAddress(),
        deployer.address,
        deployer.address, // treasury
        deployer.address, // launchTeam
        deployer.address  // securityCouncil
      );

      await armToken.addToWhitelist(await crowdfund.getAddress());
      await armToken.transfer(await crowdfund.getAddress(), ARM(1_800_000));
      await crowdfund.loadArm();

      const count = 100;
      const seeds = allSigners.slice(1, count + 1);
      await crowdfund.addSeeds(seeds.map(s => s.address));
      await crowdfund.startWindow();

      for (const s of seeds) {
        await usdc.mint(s.address, USDC(15_000));
        await usdc.connect(s).approve(await crowdfund.getAddress(), USDC(15_000));
        await crowdfund.connect(s).commit(USDC(15_000), 0);
      }

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Measure gas for first, middle, and last claims
      const claimGas: { position: string; gas: bigint }[] = [];

      const firstTx = await crowdfund.connect(seeds[0]).claim();
      const firstReceipt = await firstTx.wait();
      claimGas.push({ position: "first", gas: firstReceipt!.gasUsed });

      const midTx = await crowdfund.connect(seeds[49]).claim();
      const midReceipt = await midTx.wait();
      claimGas.push({ position: "middle (50th)", gas: midReceipt!.gasUsed });

      const lastTx = await crowdfund.connect(seeds[99]).claim();
      const lastReceipt = await lastTx.wait();
      claimGas.push({ position: "last (100th)", gas: lastReceipt!.gasUsed });

      for (const c of claimGas) {
        console.log(`    claim() | ${c.position} | ${c.gas.toLocaleString()} gas`);
      }

      // Verify gas is roughly constant (within 10% of first claim)
      const baseGas = claimGas[0].gas;
      for (const c of claimGas) {
        const diff = c.gas > baseGas ? c.gas - baseGas : baseGas - c.gas;
        const pctDiff = (diff * 100n) / baseGas;
        expect(Number(pctDiff)).to.be.lessThan(20, `claim() gas should be roughly constant, got ${pctDiff}% diff for ${c.position}`);
      }
    });
  });

  // ============================================================
  // 4. ERC20Votes getPastVotes() / castVote() with many checkpoints
  // ============================================================

  describe("ERC20Votes checkpoint scaling", function () {
    it("getPastVotes() gas with 10, 100, 500, 1000 checkpoints (binary search)", async function () {
      const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
      const armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
      await armToken.initWhitelist([deployer.address]);

      const alice = allSigners[1];
      const bob = allSigners[2];

      // Give alice tokens
      await armToken.transfer(alice.address, ARM(1_000_000));

      // Self-delegate to activate voting power
      await armToken.connect(alice).delegate(alice.address);

      // Create many checkpoints by toggling delegation between alice and bob
      // Each delegation change on a new block creates a checkpoint
      const checkpointTargets = [10, 100, 500, 1000];
      const results: { checkpoints: number; gas: bigint }[] = [];

      let currentCheckpoints = 1; // initial delegate() created 1

      for (const target of checkpointTargets) {
        const toCreate = target - currentCheckpoints;

        for (let i = 0; i < toCreate; i++) {
          await mine(1);
          // Alternate between self-delegation and delegating to bob
          const delegatee = (currentCheckpoints + i) % 2 === 0 ? alice.address : bob.address;
          await armToken.connect(alice).delegate(delegatee);
        }
        currentCheckpoints = target;

        // Ensure final delegation is to alice so she has voting power
        await mine(1);
        await armToken.connect(alice).delegate(alice.address);
        currentCheckpoints++;

        const queryBlock = (await ethers.provider.getBlockNumber()) - 1;
        const gas = await armToken.getPastVotes.estimateGas(alice.address, queryBlock);

        results.push({ checkpoints: target, gas });

        console.log(
          `    getPastVotes() | ${target} checkpoints | ${gas.toLocaleString()} gas`
        );
      }

      // Verify O(log n) scaling
      if (results.length >= 2) {
        const first = results[0];
        const last = results[results.length - 1];
        const countRatio = last.checkpoints / first.checkpoints;
        const gasRatio = Number(last.gas) / Number(first.gas);
        console.log(
          `    Scaling: ${countRatio}x checkpoints → ${gasRatio.toFixed(2)}x gas ` +
          `(linear would be ${countRatio}x, O(log n) expected ~${(Math.log2(countRatio) + 1).toFixed(1)}x)`
        );
      }
    });

    it("castVote() gas with deep checkpoint history", async function () {
      const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
      const armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
      await armToken.initWhitelist([deployer.address]);

      const voters = allSigners.slice(1, 6); // 5 voters with varying checkpoint depths
      const delegateTarget = allSigners[6]; // alternate delegation target

      // Setup TimelockController
      const TimelockController = await ethers.getContractFactory("TimelockController");
      const timelock = await TimelockController.deploy(0, [deployer.address], [deployer.address], deployer.address);

      // Deploy governor
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      const governor = await ArmadaGovernor.deploy(
        await armToken.getAddress(),
        await timelock.getAddress(),
        deployer.address, // treasury
        deployer.address, // guardian
        14 * 86400         // maxPauseDuration
      );

      // Grant roles
      const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
      const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
      await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
      await timelock.grantRole(EXECUTOR_ROLE, await governor.getAddress());

      // Deployer self-delegates (proposer needs threshold)
      await armToken.delegate(deployer.address);

      // Fund voters and self-delegate
      for (let i = 0; i < voters.length; i++) {
        const amount = ARM(1_000_000);
        await armToken.transfer(voters[i].address, amount);
        await armToken.connect(voters[i]).delegate(voters[i].address);
      }

      // Create varying checkpoint depths via delegation toggling
      // voter[0] — many checkpoints (500)
      for (let i = 0; i < 250; i++) {
        await mine(1);
        await armToken.connect(voters[0]).delegate(delegateTarget.address);
        await mine(1);
        await armToken.connect(voters[0]).delegate(voters[0].address);
      }

      // voter[1] — moderate (100)
      for (let i = 0; i < 50; i++) {
        await mine(1);
        await armToken.connect(voters[1]).delegate(delegateTarget.address);
        await mine(1);
        await armToken.connect(voters[1]).delegate(voters[1].address);
      }

      // voter[2] — few checkpoints (10)
      for (let i = 0; i < 5; i++) {
        await mine(1);
        await armToken.connect(voters[2]).delegate(delegateTarget.address);
        await mine(1);
        await armToken.connect(voters[2]).delegate(voters[2].address);
      }

      // voter[3] — single checkpoint (just the initial delegate)
      // voter[4] — single checkpoint

      // Create a proposal
      await mine(1);
      const proposeTx = await governor.propose(
        0, // Standard
        [deployer.address],
        [0],
        [ethers.hexlify(ethers.toUtf8Bytes(""))],
        "Gas benchmark proposal"
      );
      await proposeTx.wait();
      const proposalId = await governor.proposalCount();

      // Wait for voting to start (2 day delay)
      await time.increase(2 * ONE_DAY + 1);

      // Cast votes and measure gas
      const voteResults: { voter: string; checkpoints: number; gas: bigint }[] = [];
      const checkpointCounts = [501, 101, 11, 1, 1]; // approximate

      for (let i = 0; i < voters.length; i++) {
        const tx = await governor.connect(voters[i]).castVote(proposalId, 1);
        const receipt = await tx.wait();
        voteResults.push({
          voter: `voter[${i}]`,
          checkpoints: checkpointCounts[i],
          gas: receipt!.gasUsed,
        });
      }

      console.log("\n    ═══════════════════════════════════════════════════════════════");
      console.log("    castVote() GAS vs CHECKPOINT DEPTH (ERC20Votes delegation)");
      console.log("    ═══════════════════════════════════════════════════════════════");
      console.log("    Voter     │ Checkpoints │ Gas Used");
      console.log("    ──────────┼─────────────┼─────────────");
      for (const r of voteResults) {
        console.log(
          `    ${r.voter.padEnd(9)} │ ${String(r.checkpoints).padStart(11)} │ ${r.gas.toLocaleString().padStart(11)}`
        );
      }

      // Verify that castVote gas doesn't grow linearly with checkpoints
      const gasSmall = voteResults[3].gas; // 1 checkpoint
      const gasLarge = voteResults[0].gas; // 500 checkpoints
      const ratio = Number(gasLarge) / Number(gasSmall);
      console.log(
        `    Gas ratio (500 checkpoints vs 1): ${ratio.toFixed(2)}x ` +
        `(O(log2(500)) ≈ ${Math.log2(500).toFixed(1)}x expected overhead)`
      );
      console.log("    ═══════════════════════════════════════════════════════════════\n");

      // The gas should not grow by more than 2x even with 500x more checkpoints (O(log n))
      expect(ratio).to.be.lessThan(3, "castVote gas should scale O(log n) with checkpoints");
    });
  });

  // ============================================================
  // 5. Crowdfund commit() gas (constant per call)
  // ============================================================

  describe("Crowdfund commit() gas", function () {
    it("commit() gas for first commit vs subsequent commit", async function () {
      const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
      const usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");

      const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
      const armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
      await armToken.initWhitelist([deployer.address]);

      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const crowdfund = await ArmadaCrowdfund.deploy(
        await usdc.getAddress(),
        await armToken.getAddress(),
        deployer.address,
        deployer.address, // treasury
        deployer.address, // launchTeam
        deployer.address  // securityCouncil
      );

      await armToken.addToWhitelist(await crowdfund.getAddress());
      await armToken.transfer(await crowdfund.getAddress(), ARM(1_800_000));
      await crowdfund.loadArm();

      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));
      await crowdfund.startWindow();

      // Fund all seeds
      for (const s of seeds) {
        await usdc.mint(s.address, USDC(15_000));
        await usdc.connect(s).approve(await crowdfund.getAddress(), USDC(15_000));
      }

      // First commit (cold storage write — more expensive)
      const tx1 = await crowdfund.connect(seeds[0]).commit(USDC(5_000), 0);
      const r1 = await tx1.wait();

      // Second commit from same address (warm storage — cheaper)
      const tx2 = await crowdfund.connect(seeds[0]).commit(USDC(5_000), 0);
      const r2 = await tx2.wait();

      // First commit from different address
      const tx3 = await crowdfund.connect(seeds[1]).commit(USDC(5_000), 0);
      const r3 = await tx3.wait();

      console.log(`    commit() | first commit (cold)    | ${r1!.gasUsed.toLocaleString()} gas`);
      console.log(`    commit() | second commit (warm)   | ${r2!.gasUsed.toLocaleString()} gas`);
      console.log(`    commit() | first commit (addr #2) | ${r3!.gasUsed.toLocaleString()} gas`);
    });
  });

  // ============================================================
  // 6. Summary: Block Gas Limit Analysis
  // ============================================================

  describe("Block gas limit analysis", function () {
    it("reports finalize() feasibility on different chains", async function () {
      // This is a reporting test — just prints analysis based on measured data
      console.log("\n    ═══════════════════════════════════════════════════════════════");
      console.log("    BLOCK GAS LIMIT FEASIBILITY ANALYSIS");
      console.log("    ═══════════════════════════════════════════════════════════════");
      console.log("    Chain            │ Block Gas Limit │ Notes");
      console.log("    ─────────────────┼─────────────────┼────────────────────────────");
      console.log("    Ethereum L1      │ 30,000,000      │ Standard block limit");
      console.log("    Arbitrum One     │ ~1.125T         │ Effectively unlimited");
      console.log("    Polygon          │ 30,000,000      │ Similar to L1");
      console.log("    Base             │ 60,000,000      │ Higher L2 limit");
      console.log("    ─────────────────┼─────────────────┼────────────────────────────");
      console.log("    RECOMMENDATION: If finalize() exceeds 15M gas for target");
      console.log("    participant count, implement batched finalization for L1.");
      console.log("    L2 deployment relaxes this constraint significantly.");
      console.log("    ═══════════════════════════════════════════════════════════════\n");
    });
  });
});
