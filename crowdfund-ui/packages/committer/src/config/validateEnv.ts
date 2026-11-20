// ABOUTME: Startup environment validation for the committer.
// ABOUTME: Hard-fails production builds that are missing critical VITE_* config.

import { isValidPrelaunchOpensAt } from './prelaunch'
import { CROWDFUND_PROFILES, isCrowdfundProfile, type CrowdfundProfile } from '@armada/crowdfund-shared'

/** Profiles whose constants describe a mainnet sale. */
const MAINNET_PROFILES: readonly CrowdfundProfile[] = ['mainnet', 'relaunch']

/** The subset of the Vite env we validate. All fields optional so the pure
 *  function can be exercised with plain records in tests. */
export interface EnvRecord {
  PROD?: boolean
  VITE_NETWORK?: string
  VITE_WALLETCONNECT_PROJECT_ID?: string
  VITE_CROWDFUND_INDEXER_URL?: string
  VITE_CROWDFUND_PROFILE?: string
  VITE_DEPLOYMENT_INSTANCE?: string
  VITE_EXPECTED_CROWDFUND_ADDRESS?: string
  VITE_PRELAUNCH_OPENS_AT?: string
}

export type EnvValidationResult = { ok: true } | { ok: false; errors: string[] }

function missing(value?: string): boolean {
  return value === undefined || value.trim() === ''
}

/**
 * Validates the runtime environment for a production deploy.
 *
 * Enforces for any non-local PROD build (sepolia, mainnet, or an unset network —
 * unset is itself a misconfiguration we want to surface loudly rather than let
 * silently fall back to a local/localhost config). Dev builds always pass: they
 * default to local and tolerate absent vars.
 *
 * Pre-launch mode (VITE_PRELAUNCH_OPENS_AT set) renders only a countdown and
 * reads no chain data, so it drops the indexer and expected-crowdfund-address
 * requirements; everything else still applies. A malformed opening time fails
 * in every build, dev included, so a typo surfaces before it is deployed.
 */
export function validateEnv(env: EnvRecord): EnvValidationResult {
  const isProd = env.PROD === true
  const network = env.VITE_NETWORK?.trim()
  const prelaunch = !missing(env.VITE_PRELAUNCH_OPENS_AT)

  if (prelaunch && !isValidPrelaunchOpensAt(env.VITE_PRELAUNCH_OPENS_AT!)) {
    return {
      ok: false,
      errors: [
        `VITE_PRELAUNCH_OPENS_AT is "${env.VITE_PRELAUNCH_OPENS_AT!.trim()}" — expected the ` +
          'sale opening as ISO 8601 UTC with whole seconds, e.g. 2026-10-08T17:00:00Z ' +
          '(the same value as CROWDFUND_OPEN_TIME in the deploy config).',
      ],
    }
  }

  if (!isProd || network === 'local') {
    return { ok: true }
  }

  const errors: string[] = []

  if (missing(network)) {
    errors.push('VITE_NETWORK is not set (expected "sepolia" or "mainnet" for production).')
  }
  if (missing(env.VITE_WALLETCONNECT_PROJECT_ID)) {
    errors.push(
      'VITE_WALLETCONNECT_PROJECT_ID is not set — wallet connection will not work.',
    )
  }
  if (!prelaunch && missing(env.VITE_CROWDFUND_INDEXER_URL)) {
    errors.push(
      'VITE_CROWDFUND_INDEXER_URL is not set — no event indexer is configured.',
    )
  }
  if (!missing(env.VITE_DEPLOYMENT_INSTANCE) && missing(env.VITE_CROWDFUND_PROFILE)) {
    errors.push(
      'VITE_CROWDFUND_PROFILE is not set while VITE_DEPLOYMENT_INSTANCE is — ' +
        'the UI would apply mainnet sale constants to the deployed instance.',
    )
  }
  // An unknown profile name silently falls back to the mainnet (Launch 1) constants,
  // so a typo would render the wrong sale. Refuse it on any production build.
  const profile = env.VITE_CROWDFUND_PROFILE?.trim()
  if (!missing(profile) && !isCrowdfundProfile(profile!)) {
    errors.push(
      `VITE_CROWDFUND_PROFILE "${profile}" is not a known profile ` +
        `(expected one of: ${CROWDFUND_PROFILES.join(', ')}).`,
    )
  }
  // A testnet profile (e.g. medi/Sepolia) on a mainnet build would render $1k-scale
  // sale numbers over a real mainnet sale. Mainnet builds use the Launch 1 profile
  // ("mainnet") or the relaunch profile. Unset is allowed — it defaults to mainnet.
  if (
    network === 'mainnet' &&
    !missing(profile) &&
    isCrowdfundProfile(profile!) &&
    !MAINNET_PROFILES.includes(profile!)
  ) {
    errors.push(
      `VITE_CROWDFUND_PROFILE is "${profile}" on a mainnet build — ` +
        'mainnet must use the "mainnet" or "relaunch" profile (or leave it unset, which defaults to mainnet).',
    )
  }
  // The crowdfund address is the USDC approve/commit target. On mainnet it must be
  // pinned to a trusted out-of-band value so the app can reject a compromised/wrong
  // manifest fetched from armada-deployments; refuse to build without the anchor.
  // A pre-launch build fetches no manifest, so there is nothing to verify.
  if (!prelaunch && network === 'mainnet' && missing(env.VITE_EXPECTED_CROWDFUND_ADDRESS)) {
    errors.push(
      'VITE_EXPECTED_CROWDFUND_ADDRESS is not set on a mainnet build — the committer cannot ' +
        'verify the fetched crowdfund (USDC approve target) address against a trusted value.',
    )
  }
  // If an expected address is supplied (any network), it must be a well-formed
  // 20-byte hex address. Catch a typo here at startup rather than deferring to the
  // manifest-load-time getAddress() in assertExpectedAddress. Format-only (no EIP-55
  // checksum) so a lowercase-entered value is accepted.
  if (
    !missing(env.VITE_EXPECTED_CROWDFUND_ADDRESS) &&
    !/^0x[0-9a-fA-F]{40}$/.test(env.VITE_EXPECTED_CROWDFUND_ADDRESS!.trim())
  ) {
    errors.push(
      'VITE_EXPECTED_CROWDFUND_ADDRESS is not a valid Ethereum address (expected 0x + 40 hex chars).',
    )
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
