/**
 * Relayer Configuration
 *
 * Controls whether transactions are submitted via the Armada Relayer
 * or directly via MetaMask.
 */

export const RELAYER_CONFIG = {
  /** Whether to use the relayer for privacy transactions */
  enabled: true,
  /** Relayer HTTP API URL */
  url: 'http://localhost:3001',
  /** Relayer's Ethereum address (Anvil account 0 — for display, gas payment) */
  relayerAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  /**
   * Relayer's Railgun address (0zk...) for receiving broadcaster fees.
   * Required for broadcasterFeeRecipient — SDK expects Railgun address, not Ethereum.
   * If unset, broadcaster fee is omitted from proof (relayer won't receive fee from shielded output).
   * POC: Derived from Anvil deployer mnemonic via scripts/derive_relayer_railgun_address.ts
   */
  relayerRailgunAddress:
    '0zk1qyk9nn28x0u3rwn5pknglda68wrn7gw6anjw8gg94mcj6eq5u48tlrv7j6fe3z53lama02nutwtcqc979wnce0qwly4y7w4rls5cq040g7z8eagshxrw5ajy990',
  /** Polling interval for transaction status (ms) */
  statusPollIntervalMs: 2000,
  /** Timeout for waiting for transaction confirmation (ms) */
  confirmationTimeoutMs: 120_000,
}
