/**
 * Privacy Pool Event Poller
 *
 * Polls EVM chains for Privacy Pool events to track transaction status.
 * Supports both Hub and Client chain events.
 */

import { ethers } from 'ethers'
import { getEvmProvider } from '@/services/evm/evmNetworkService'

// ============ Event Signatures ============

/**
 * Privacy Pool event topic hashes
 */
export const PRIVACY_POOL_EVENTS = {
  // Shield event: Shield(uint256 treeNumber, uint256 startPosition, bytes32[] commitments, tuple[] shieldCiphertext, uint120[] fees)
  Shield: ethers.id('Shield(uint256,uint256,bytes32[],(bytes32[4],bytes32,bytes32,bytes,bytes)[],uint120[])'),

  // Transact event: Transact(uint256 treeNumber, uint256 startPosition, bytes32[] commitmentHashes, tuple[] ciphertext)
  Transact: ethers.id('Transact(uint256,uint256,bytes32[],(bytes32[4],bytes32,bytes32,bytes,bytes)[])'),

  // Nullified event: Nullified(uint16 treeNumber, bytes32[] nullifiers)
  Nullified: ethers.id('Nullified(uint16,bytes32[])'),

  // Unshield event: Unshield(address recipient, tuple token, uint120 amount, uint120 fee)
  Unshield: ethers.id('Unshield(address,(uint8,address,uint256),uint120,uint120)'),

  // CrossChainUnshieldInitiated event
  CrossChainUnshieldInitiated: ethers.id('CrossChainUnshieldInitiated(uint32,address,uint120,uint64)'),
}

/**
 * Privacy Pool Client event topic hashes
 */
export const PRIVACY_POOL_CLIENT_EVENTS = {
  // CrossChainShieldInitiated event
  CrossChainShieldInitiated: ethers.id('CrossChainShieldInitiated(address,uint256,bytes32,uint64)'),

  // UnshieldReceived event
  UnshieldReceived: ethers.id('UnshieldReceived(address,uint256)'),
}

/**
 * CCTP event topic hashes
 */
export const CCTP_EVENTS = {
  // MessageSent from TokenMessenger
  MessageSent: ethers.id('MessageSent(bytes)'),
}

// ============ Types ============

export interface EventMatch {
  eventName: string
  txHash: string
  blockNumber: number
  logIndex: number
  timestamp?: number
  data: Record<string, unknown>
}

export interface PollOptions {
  /** Contract address to poll */
  contractAddress: string
  /** Event topic to look for */
  eventTopic: string
  /** Starting block number */
  fromBlock: number | 'latest'
  /** Ending block number */
  toBlock: number | 'latest'
  /** Additional topic filters */
  topics?: (string | null)[]
  /** Chain key (e.g., 'hub', 'client-a') */
  chainKey: string
}

export interface PollResult {
  found: boolean
  events: EventMatch[]
  latestBlock: number
  error?: string
}

// ============ Polling Functions ============

/**
 * Poll for events on an EVM chain
 */
export async function pollForEvents(options: PollOptions): Promise<PollResult> {
  const { contractAddress, eventTopic, fromBlock, toBlock, topics, chainKey } = options

  try {
    const provider = await getEvmProvider(chainKey)

    // Build filter
    const filter = {
      address: contractAddress,
      topics: [eventTopic, ...(topics || [])],
      fromBlock,
      toBlock,
    }

    // Get logs
    const logs = await provider.getLogs(filter)

    // Get latest block for progress tracking
    const latestBlock = await provider.getBlockNumber()

    // Parse events
    const events: EventMatch[] = logs.map((log) => ({
      eventName: getEventName(log.topics[0]),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.index,
      data: parseEventData(log),
    }))

    return {
      found: events.length > 0,
      events,
      latestBlock,
    }
  } catch (error) {
    console.error('[event-poller] Error polling for events:', error)
    return {
      found: false,
      events: [],
      latestBlock: typeof fromBlock === 'number' ? fromBlock : 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Poll for a specific transaction's receipt and events
 */
export async function pollTransactionReceipt(
  txHash: string,
  chainKey: string,
): Promise<{
  confirmed: boolean
  blockNumber?: number
  events: EventMatch[]
  error?: string
}> {
  try {
    const provider = await getEvmProvider(chainKey)
    const receipt = await provider.getTransactionReceipt(txHash)

    if (!receipt) {
      return { confirmed: false, events: [] }
    }

    // Check if transaction succeeded
    if (receipt.status === 0) {
      return {
        confirmed: true,
        blockNumber: receipt.blockNumber,
        events: [],
        error: 'Transaction reverted',
      }
    }

    // Parse events from receipt
    const events: EventMatch[] = receipt.logs.map((log) => ({
      eventName: getEventName(log.topics[0]),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.index,
      data: parseEventData(log),
    }))

    return {
      confirmed: true,
      blockNumber: receipt.blockNumber,
      events,
    }
  } catch (error) {
    console.error('[event-poller] Error getting transaction receipt:', error)
    return {
      confirmed: false,
      events: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Wait for a transaction to be confirmed with a timeout
 */
export async function waitForTransaction(
  txHash: string,
  chainKey: string,
  timeoutMs: number = 60000,
  pollIntervalMs: number = 2000,
): Promise<{
  confirmed: boolean
  blockNumber?: number
  events: EventMatch[]
  error?: string
}> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    const result = await pollTransactionReceipt(txHash, chainKey)

    if (result.confirmed) {
      return result
    }

    if (result.error) {
      return result
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  return {
    confirmed: false,
    events: [],
    error: 'Transaction confirmation timeout',
  }
}

// ============ Event-Specific Polling ============

/**
 * Poll for Shield event
 */
export async function pollForShieldEvent(
  contractAddress: string,
  chainKey: string,
  fromBlock: number,
  toBlock: number | 'latest' = 'latest',
): Promise<PollResult> {
  return pollForEvents({
    contractAddress,
    eventTopic: PRIVACY_POOL_EVENTS.Shield,
    fromBlock,
    toBlock,
    chainKey,
  })
}

/**
 * Poll for Unshield event
 */
export async function pollForUnshieldEvent(
  contractAddress: string,
  chainKey: string,
  fromBlock: number,
  recipientAddress?: string,
): Promise<PollResult> {
  // Recipient is indexed, so we can filter by it
  const topics = recipientAddress
    ? [ethers.zeroPadValue(recipientAddress, 32)]
    : []

  return pollForEvents({
    contractAddress,
    eventTopic: PRIVACY_POOL_EVENTS.Unshield,
    fromBlock,
    toBlock: 'latest',
    topics,
    chainKey,
  })
}

/**
 * Poll for CrossChainUnshieldInitiated event
 */
export async function pollForCrossChainUnshieldEvent(
  contractAddress: string,
  chainKey: string,
  fromBlock: number,
): Promise<PollResult> {
  return pollForEvents({
    contractAddress,
    eventTopic: PRIVACY_POOL_EVENTS.CrossChainUnshieldInitiated,
    fromBlock,
    toBlock: 'latest',
    chainKey,
  })
}

/**
 * Poll for UnshieldReceived event on client chain
 */
export async function pollForUnshieldReceivedEvent(
  contractAddress: string,
  chainKey: string,
  fromBlock: number,
  recipientAddress?: string,
): Promise<PollResult> {
  const topics = recipientAddress
    ? [ethers.zeroPadValue(recipientAddress, 32)]
    : []

  return pollForEvents({
    contractAddress,
    eventTopic: PRIVACY_POOL_CLIENT_EVENTS.UnshieldReceived,
    fromBlock,
    toBlock: 'latest',
    topics,
    chainKey,
  })
}

// ============ Helper Functions ============

/**
 * Get event name from topic hash
 */
function getEventName(topicHash: string): string {
  const allEvents = {
    ...PRIVACY_POOL_EVENTS,
    ...PRIVACY_POOL_CLIENT_EVENTS,
    ...CCTP_EVENTS,
  }

  for (const [name, hash] of Object.entries(allEvents)) {
    if (hash === topicHash) {
      return name
    }
  }

  return 'Unknown'
}

/**
 * Parse event data from log
 * Note: This is a simplified parser. For production, use proper ABI decoding.
 */
function parseEventData(log: ethers.Log): Record<string, unknown> {
  const topicHash = log.topics[0]

  // Basic parsing based on event type
  // In production, use ethers.Interface to decode properly

  if (topicHash === PRIVACY_POOL_EVENTS.Unshield) {
    // Unshield(address recipient, tuple token, uint120 amount, uint120 fee)
    // recipient is indexed (topics[1])
    const recipient = log.topics[1]
      ? ethers.getAddress('0x' + log.topics[1].slice(-40))
      : undefined

    return { recipient }
  }

  if (topicHash === PRIVACY_POOL_EVENTS.CrossChainUnshieldInitiated) {
    // CrossChainUnshieldInitiated(uint32 destinationDomain, address finalRecipient, uint120 amount, uint64 nonce)
    // Try to decode from data
    try {
      const abiCoder = ethers.AbiCoder.defaultAbiCoder()
      const decoded = abiCoder.decode(
        ['uint32', 'address', 'uint120', 'uint64'],
        log.data,
      )
      return {
        destinationDomain: Number(decoded[0]),
        finalRecipient: decoded[1],
        amount: decoded[2].toString(),
        nonce: Number(decoded[3]),
      }
    } catch {
      return {}
    }
  }

  if (topicHash === PRIVACY_POOL_CLIENT_EVENTS.UnshieldReceived) {
    // UnshieldReceived(address recipient, uint256 amount)
    const recipient = log.topics[1]
      ? ethers.getAddress('0x' + log.topics[1].slice(-40))
      : undefined

    try {
      const abiCoder = ethers.AbiCoder.defaultAbiCoder()
      const decoded = abiCoder.decode(['uint256'], log.data)
      return {
        recipient,
        amount: decoded[0].toString(),
      }
    } catch {
      return { recipient }
    }
  }

  // Return raw data for other events
  return {
    topics: log.topics,
    data: log.data,
  }
}

/**
 * Get current block number for a chain
 */
export async function getCurrentBlockNumber(chainKey: string): Promise<number> {
  const provider = await getEvmProvider(chainKey)
  return provider.getBlockNumber()
}
