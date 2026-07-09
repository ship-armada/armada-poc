/**
 * Orchestrator Registry
 * 
 * Tracks active FlowOrchestrator instances for lifecycle management.
 */

import type { FlowOrchestrator } from './flowOrchestrator'
import { logger } from '@/utils/logger'

/**
 * Registry of active orchestrators
 */
const orchestratorRegistry = new Map<string, FlowOrchestrator>()

/**
 * Register an orchestrator
 */
export function registerOrchestrator(txId: string, orchestrator: FlowOrchestrator): void {
  orchestratorRegistry.set(txId, orchestrator)
  logger.debug('[OrchestratorRegistry] Registered orchestrator', {
    txId,
    totalCount: orchestratorRegistry.size,
  })
}

/**
 * Unregister an orchestrator
 */
export function unregisterOrchestrator(txId: string): void {
  const removed = orchestratorRegistry.delete(txId)
  if (removed) {
    logger.debug('[OrchestratorRegistry] Unregistered orchestrator', {
      txId,
      remainingCount: orchestratorRegistry.size,
    })
  }
}

/**
 * Get an orchestrator by transaction ID
 */
export function getOrchestrator(txId: string): FlowOrchestrator | undefined {
  return orchestratorRegistry.get(txId)
}

/**
 * Get all active orchestrators
 */
export function getAllOrchestrators(): FlowOrchestrator[] {
  return Array.from(orchestratorRegistry.values())
}

/**
 * Clear all orchestrators (cleanup)
 */
export function clearAllOrchestrators(): void {
  const count = orchestratorRegistry.size
  orchestratorRegistry.clear()
  logger.debug('[OrchestratorRegistry] Cleared all orchestrators', {
    count,
  })
}

