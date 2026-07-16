/**
 * Relayer Configuration
 *
 * Controls whether transactions are submitted via the Armada Relayer
 * or directly via MetaMask. Values are network-dependent (local vs Sepolia).
 */

import {
  getRelayerUrl,
  getRelayerAddress,
  getRelayerRailgunAddress,
} from './networkConfig'

export const RELAYER_CONFIG = {
  /** Whether to use the relayer for privacy transactions */
  enabled: true,
  /** Relayer HTTP API URL */
  get url() {
    return getRelayerUrl()
  },
  /** Relayer's Ethereum address (for display, gas payment) */
  get relayerAddress() {
    return getRelayerAddress()
  },
  /**
   * Relayer's Railgun address (0zk...) for receiving broadcaster fees.
   * Required for broadcasterFeeRecipient — SDK expects Railgun address, not Ethereum.
   * If unset, broadcaster fee is omitted from proof (relayer won't receive fee from shielded output).
   */
  get relayerRailgunAddress() {
    return getRelayerRailgunAddress()
  },
  /** Polling interval for transaction status (ms) */
  statusPollIntervalMs: 2000,
  /** Timeout for waiting for transaction confirmation (ms) */
  confirmationTimeoutMs: 120_000,
}
