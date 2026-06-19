// ABOUTME: Submit-time spendable-balance guard for fee-on-top actions (S-M5) — throws a clear error
// ABOUTME: when amount + the FRESH relayer fee exceeds the balance, before 20-30s of proof generation.

import { formatUsdc } from '@/lib/format'

export interface FeeOnTopCheck {
  /** The amount the user is sending/withdrawing/depositing. */
  amount: bigint
  /** The relayer fee frozen from the FRESH quote at submit (may exceed the input-time estimate). */
  fee: bigint
  /** Spendable balance the action draws from (shielded USDC for these kinds). */
  balance: bigint
}

/**
 * Throw a clear, actionable error when a fee-on-top action would draw `amount + fee` beyond the
 * available `balance`. The relayer fee is frozen from the fresh quote at submit and can be higher
 * than the estimate the input step reserved (gas spiked between input and Confirm), so the input's
 * fee-reduced max isn't a guarantee. Without this check the over-budget proof still gets built and
 * fails 20-30s later inside the SDK with an opaque throw. ShieldModal has the equivalent inline
 * guard; Send / Unshield / Earn route through here. (S-M5)
 *
 * Only for fee-on-top kinds (unshield-local, unshield-xchain, transfer-shielded, yield-deposit),
 * where the fee is drawn from the same shielded balance as the amount. Yield-withdraw takes its fee
 * from the redeemed output, so it does not call this.
 */
export function assertSpendableForFeeOnTop({ amount, fee, balance }: FeeOnTopCheck): void {
  if (amount + fee > balance) {
    throw new Error(
      `Insufficient balance: ${formatUsdc(amount)} USDC plus the ${formatUsdc(fee)} USDC relayer fee ` +
        `exceeds your ${formatUsdc(balance)} USDC balance. Lower the amount, or wait for the fee to drop.`,
    )
  }
}
