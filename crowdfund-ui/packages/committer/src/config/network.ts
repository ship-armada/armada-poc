// ABOUTME: Committer network config — re-exports the shared resolvers so the
// ABOUTME: logic (local/sepolia/mainnet) lives once in @armada/crowdfund-shared.

export {
  getNetworkMode,
  isLocalMode,
  getHubChainId,
  getHubNetworkLabel,
  getHubRpcUrl,
  getHubRpcUrls,
  getIndexerUrl,
  getDeploymentFileName,
  getPollIntervalMs,
  getMaxBlockRange,
  getTxConfirmations,
  getExplorerUrl,
  assertDeploymentChainId,
} from '@armada/crowdfund-shared'
export type { NetworkMode } from '@armada/crowdfund-shared'
