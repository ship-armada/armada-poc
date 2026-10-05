// ABOUTME: Deploy-time initial Treasury Steward election and USDC steward budget (#221, #222).
// ABOUTME: Pre-flight role checks, timelock-executed seeding with read-back, and verify checks.
import { ethers } from "hardhat";
import { USDC_DECIMALS, type InitialStewardConfig } from "../config/networks";
import { rejectAnvilAddresses, retryReadOnLag } from "./deploy-utils";
import { assertTwoOfThreeMultisig } from "./revenue-reserve";

/** Runs one call as the timelock. deploy_crowdfund passes timelockCall (bootstrap roles). */
export type TimelockExecutor = (target: string, calldata: string, description: string) => Promise<unknown>;

export interface StewardContracts {
  /** TreasurySteward */
  steward: string;
  /** ArmadaTreasuryGov */
  treasury: string;
  /** Hub USDC */
  usdc: string;
}

export interface StewardCheck {
  check: string;
  status: "PASS" | "FAIL";
  detail: string;
}

/** The configured whole-USD budget in USDC's smallest unit. */
export function stewardBudgetLimit(steward: InitialStewardConfig): bigint {
  return BigInt(steward.budgetUsdc) * 10n ** BigInt(USDC_DECIMALS);
}

/**
 * Refuse a steward that has a bad EIP-55 checksum, shares an address with another launch role,
 * is an Anvil default account off-local, or (when requireMultisig) is not a 2-of-3 Safe. Runs
 * before the first transaction of each deploy stage. Unset roles (empty strings) are skipped.
 */
export async function assertInitialStewardPreflight(
  steward: InitialStewardConfig,
  otherRoles: { label: string; address: string }[],
  requireMultisig: boolean,
): Promise<void> {
  // getAddress validates a mixed-case checksum (the election call would reject it later, after
  // one-shot setters are spent); all-lowercase input carries no checksum and is accepted.
  const address = ethers.getAddress(steward.address);
  rejectAnvilAddresses([address], "Initial steward");
  for (const role of otherRoles) {
    if (role.address && ethers.getAddress(role.address.toLowerCase()) === address) {
      throw new Error(`Initial steward must differ from the ${role.label} (${address})`);
    }
  }
  if (requireMultisig) await assertTwoOfThreeMultisig(address, "Initial steward");
}

/** The budget is scaled by USDC_DECIMALS; refuse a hub USDC that reports anything else. */
export async function assertUsdcDecimals(usdc: string): Promise<void> {
  const token = new ethers.Contract(usdc, ["function decimals() view returns (uint8)"], ethers.provider);
  const decimals = Number(await token.decimals());
  if (decimals !== USDC_DECIMALS) {
    throw new Error(
      `Steward budget is scaled by ${USDC_DECIMALS} decimals, but the hub USDC (${usdc}) reports ` +
      `${decimals} decimals; refusing to authorize a mis-scaled budget`
    );
  }
}

/**
 * Compare the on-chain steward and USDC budget with the config. One row each for the elected
 * address, the active term, and the budget (limit, window, authorized).
 */
export async function initialStewardChecks(
  steward: InitialStewardConfig,
  contracts: StewardContracts,
): Promise<StewardCheck[]> {
  const stewardContract = await ethers.getContractAt("TreasurySteward", contracts.steward);
  const treasury = await ethers.getContractAt("ArmadaTreasuryGov", contracts.treasury);
  const expectedLimit = stewardBudgetLimit(steward);

  const current = await stewardContract.currentSteward();
  const active = await stewardContract.isStewardActive();
  const budget = await treasury.stewardBudgets(contracts.usdc);
  const budgetMatches = budget.authorized && budget.limit === expectedLimit &&
    budget.window === BigInt(steward.budgetWindow);
  return [
    {
      check: `Initial steward = ${steward.address}`,
      status: current.toLowerCase() === steward.address.toLowerCase() ? "PASS" : "FAIL",
      detail: `on-chain currentSteward ${current}`,
    },
    {
      check: "Initial steward term active",
      status: active ? "PASS" : "FAIL",
      detail: `isStewardActive() = ${active}`,
    },
    {
      check: `USDC steward budget = $${steward.budgetUsdc} per ${steward.budgetWindow}s`,
      status: budgetMatches ? "PASS" : "FAIL",
      detail: `on-chain authorized=${budget.authorized} limit=${budget.limit} window=${budget.window}`,
    },
  ];
}

/**
 * Elect the steward and authorize its USDC budget through the timelock, then read both back.
 * Throws if the read-back does not match, so the deploy stops while it still holds the
 * bootstrap roles that could correct it. Returns the end of the 180-day term.
 */
export async function seedInitialSteward(
  steward: InitialStewardConfig,
  contracts: StewardContracts,
  asTimelock: TimelockExecutor,
): Promise<{ termEnd: bigint }> {
  const stewardContract = await ethers.getContractAt("TreasurySteward", contracts.steward);
  const treasury = await ethers.getContractAt("ArmadaTreasuryGov", contracts.treasury);

  await asTimelock(contracts.steward,
    stewardContract.interface.encodeFunctionData("electSteward", [steward.address]),
    `steward.electSteward(${steward.address})`);
  await asTimelock(contracts.treasury,
    treasury.interface.encodeFunctionData("addStewardBudgetToken",
      [contracts.usdc, stewardBudgetLimit(steward), steward.budgetWindow]),
    "treasury.addStewardBudgetToken(USDC)");

  await retryReadOnLag("Initial steward read-back", async () => {
    const failed = (await initialStewardChecks(steward, contracts)).filter(check => check.status === "FAIL");
    if (failed.length) {
      throw new Error(`Initial steward read-back failed: ${failed.map(f => `${f.check} (${f.detail})`).join("; ")}`);
    }
  });
  return { termEnd: await stewardContract.termEnd() };
}
