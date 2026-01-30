/**
 * Railgun SDK Integration
 *
 * Re-exports from the various Railgun modules.
 */

export {
  initRailgun,
  isRailgunInitialized,
  getRailgunInitError,
  resetRailgunInit,
} from './init';

export {
  createShieldRequest,
  deriveShieldPrivateKey,
  formatNpkForContract,
  formatBytes32ForContract,
  SHIELD_SIGNATURE_MESSAGE,
  type ShieldRequestData,
} from './shield';

export {
  initializeProver,
  isProverReady,
  resetProver,
} from './prover';
