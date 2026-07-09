/**
 * Yield Adapt Proof Module
 *
 * Trustless proof generation for ArmadaYieldAdapter lend/redeem flows.
 * Uses adaptContract/adaptParams pattern - adapter cannot deviate from user's committed shield destination.
 */

export { encodeYieldAdaptParams } from './yieldAdaptParams'
export {
  generateYieldAdaptLendProof,
  type YieldAdaptLendProofResult,
  type GenerateYieldAdaptLendProofParams,
} from './generateYieldAdaptLendProof'
export {
  generateYieldAdaptRedeemProof,
  type YieldAdaptRedeemProofResult,
  type GenerateYieldAdaptRedeemProofParams,
} from './generateYieldAdaptRedeemProof'
