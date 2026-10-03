// ABOUTME: Decides when an open Claim modal should close itself because claim isn't available.
// ABOUTME: Waits for the contract state to load so a ?view=claim deep link isn't closed on first render; asks before closing mid-claim.

import { confirmParticipateClose } from '@armada/crowdfund-shared'

export interface ClaimModalGate {
  /** The Claim modal is open (button press or `?view=claim`). */
  open: boolean
  /** Claim is available for the connected wallet. */
  ready: boolean
  /** Contract state hasn't completed its first load (availability unknown). */
  stateLoading: boolean
}

/** True when the open modal should close: availability is known and claim isn't ready. */
export function shouldDismissClaimModal({ open, ready, stateLoading }: ClaimModalGate): boolean {
  return open && !ready && !stateLoading
}

export const CLAIM_CLOSE_CONFIRM_MESSAGE =
  "Your claim is still in progress. Closing won't cancel a transaction you've already approved in your wallet — reopen Claim to see the result. Close anyway?"

/** Whether the claim flow may close. While a claim is in flight, asks the user first. */
export function confirmClaimClose(running: boolean): boolean {
  return confirmParticipateClose(running, CLAIM_CLOSE_CONFIRM_MESSAGE)
}
