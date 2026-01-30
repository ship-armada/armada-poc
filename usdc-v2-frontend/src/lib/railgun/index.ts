/**
 * Railgun SDK Integration - Public API
 *
 * Re-exports the public functions from the railgun module.
 */

export {
  initRailgun,
  isRailgunInitialized,
  getRailgunInitError,
  resetRailgunInit,
} from './init'

export {
  loadHubNetwork,
  getHubChainConfig,
  isHubNetworkLoaded,
} from './network'

export {
  loadTestArtifacts,
  checkTestArtifactsAvailable,
  getLoadedCircuits,
  isCircuitLoaded,
  artifactCache,
} from './test-artifacts'

export {
  SHIELD_SIGNATURE_MESSAGE,
  deriveShieldPrivateKey,
  createShieldRequest,
  formatNpkForContract,
  formatBytes32ForContract,
  type ShieldRequestData,
} from './shield'

export {
  initializeProver,
  isProverReady,
  resetProver,
} from './prover'
