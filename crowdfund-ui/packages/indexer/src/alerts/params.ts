// ABOUTME: Reads the alert evaluator's crowdfund parameters (timing + treasury/USDC addresses)
// ABOUTME: from the deployed contract, so they cannot be mistyped or left blank in the env.

import type { CrowdfundParams } from './types.js'

/** Minimal ABI for the immutables the alert rules need. */
export const CROWDFUND_ALERT_PARAMS_ABI = [
  'function windowStart() view returns (uint256)',
  'function launchTeamInviteEnd() view returns (uint256)',
  'function windowEnd() view returns (uint256)',
  'function treasury() view returns (address)',
  'function usdc() view returns (address)',
] as const

export interface CrowdfundAlertParamsReadable {
  windowStart(): Promise<bigint>
  launchTeamInviteEnd(): Promise<bigint>
  windowEnd(): Promise<bigint>
  treasury(): Promise<string>
  usdc(): Promise<string>
}

/**
 * Read open / launch-team-invite / commitment-deadline timestamps and the treasury + USDC addresses
 * from the crowdfund. The launch-team invite deadline (`week1Deadline`, a name that predates the
 * 14-day window) is launchTeamInviteEnd and the commitment deadline is
 * windowEnd (both fixed in the constructor). A failed read propagates.
 */
export async function readCrowdfundAlertParams(
  crowdfund: CrowdfundAlertParamsReadable,
  chainId: number,
  contractAddress: string,
): Promise<{ params: CrowdfundParams; usdcAddress: string }> {
  const [windowStart, week1Deadline, windowEnd, treasuryAddress, usdcAddress] = await Promise.all([
    crowdfund.windowStart(),
    crowdfund.launchTeamInviteEnd(),
    crowdfund.windowEnd(),
    crowdfund.treasury(),
    crowdfund.usdc(),
  ])
  return {
    params: {
      chainId,
      contractAddress,
      treasuryAddress,
      openTimestamp: Number(windowStart),
      week1Deadline: Number(week1Deadline),
      commitmentDeadline: Number(windowEnd),
    },
    usdcAddress,
  }
}
