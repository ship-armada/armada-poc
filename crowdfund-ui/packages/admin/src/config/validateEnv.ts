// ABOUTME: Startup environment validation for the admin app.
// ABOUTME: Hard-fails production builds that are missing critical VITE_* config.

/** The subset of the Vite env we validate. All fields optional so the pure
 *  function can be exercised with plain records in tests. */
export interface EnvRecord {
  PROD?: boolean
  VITE_NETWORK?: string
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
 * Enforces for any non-local PROD build (sepolia, mainnet, or an unset network —
 * unset is itself a misconfiguration we want to surface loudly rather than let
 * silently fall back). Dev builds always pass: they default to local and tolerate
 * absent vars.
 *
 * The admin app uses a plain `window.ethereum` wallet (no WalletConnect) and reads
 * events over RPC (no indexer), so — unlike the committer — it requires neither
 * VITE_WALLETCONNECT_PROJECT_ID nor VITE_CROWDFUND_INDEXER_URL. It does consume the
 * profile-driven CROWDFUND_CONSTANTS, so the instance/profile pairing still matters.
 */
export function validateEnv(env: EnvRecord): EnvValidationResult {
  const isProd = env.PROD === true
  const network = env.VITE_NETWORK?.trim()

  if (!isProd || network === 'local') {
    return { ok: true }
  }

  const errors: string[] = []

  if (missing(network)) {
    errors.push('VITE_NETWORK is not set (expected "sepolia" or "mainnet" for production).')
  }
  if (!missing(env.VITE_DEPLOYMENT_INSTANCE) && missing(env.VITE_CROWDFUND_PROFILE)) {
    errors.push(
      'VITE_CROWDFUND_PROFILE is not set while VITE_DEPLOYMENT_INSTANCE is — ' +
        'the UI would apply mainnet sale constants to the deployed instance.',
    )
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
