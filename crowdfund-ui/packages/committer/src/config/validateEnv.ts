// ABOUTME: Startup environment validation for the committer.
// ABOUTME: Hard-fails production builds that are missing critical VITE_* config.

/** The subset of the Vite env we validate. All fields optional so the pure
 *  function can be exercised with plain records in tests. */
export interface EnvRecord {
  PROD?: boolean
  VITE_NETWORK?: string
  VITE_WALLETCONNECT_PROJECT_ID?: string
  VITE_CROWDFUND_INDEXER_URL?: string
  VITE_CROWDFUND_PROFILE?: string
  VITE_DEPLOYMENT_INSTANCE?: string
}

export type EnvValidationResult = { ok: true } | { ok: false; errors: string[] }

function missing(value?: string): boolean {
  return value === undefined || value.trim() === ''
}

/**
 * Validates the runtime environment for a production deploy.
 *
 * Only enforces for PROD builds that target Sepolia — or PROD builds where
 * VITE_NETWORK is unset, which is itself a misconfiguration we want to surface
 * loudly rather than let silently fall back to a local/localhost config. Dev
 * builds always pass: they default to local and tolerate absent vars.
 */
export function validateEnv(env: EnvRecord): EnvValidationResult {
  const isProd = env.PROD === true
  const network = env.VITE_NETWORK?.trim()
  const isSepoliaOrUnset = network === 'sepolia' || missing(network)

  if (!isProd || !isSepoliaOrUnset) {
    return { ok: true }
  }

  const errors: string[] = []

  if (missing(network)) {
    errors.push('VITE_NETWORK is not set (expected "sepolia" for production).')
  }
  if (missing(env.VITE_WALLETCONNECT_PROJECT_ID)) {
    errors.push(
      'VITE_WALLETCONNECT_PROJECT_ID is not set — wallet connection will not work.',
    )
  }
  if (missing(env.VITE_CROWDFUND_INDEXER_URL)) {
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

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
