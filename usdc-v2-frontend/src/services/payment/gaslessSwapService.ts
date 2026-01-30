/**
 * Gasless Swap Service
 * 
 * NOTE: Gasless swaps are not yet implemented in v2-frontend.
 * This file is a placeholder for future gasless swap integration.
 * 
 * When gasless swaps are implemented, this service should:
 * 1. Report 'gasless_quote_pending' when quote is requested
 * 2. Report 'gasless_swap_completed' when swap transaction is confirmed
 * 3. Report 'gasless_swap_failed' on error
 * 
 * Integration with clientStageReporter:
 * ```typescript
 * import { clientStageReporter } from '@/services/flow/clientStageReporter'
 * 
 * // When requesting quote
 * await clientStageReporter.reportGaslessStage(flowId, 'gasless_quote_pending')
 * 
 * // When swap completes
 * await clientStageReporter.reportGaslessStage(flowId, 'gasless_swap_completed', txHash, 'confirmed')
 * 
 * // On error
 * await clientStageReporter.reportGaslessStage(flowId, 'gasless_swap_failed', undefined, 'failed')
 * ```
 */

export {}

