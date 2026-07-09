// ABOUTME: Mobile-only contract-write submit via wagmi's sendTransaction so MetaMask Mobile surfaces the request.
// ABOUTME: Returns an ethers-TransactionResponse-shaped object so the shared send/wait engine is unchanged.

import { sendTransaction, waitForTransactionReceipt } from 'wagmi/actions'
import type { Contract, TransactionResponse } from 'ethers'
import type { ReceiptLogLike } from '@armada/crowdfund-shared'
import { getHubChainId, getTxConfirmations } from '@/config/network'
import { TX_WAIT_TIMEOUT_MS } from './txWait'

/** viem raises a named `WaitForTransactionReceiptTimeoutError` on receipt timeout. */
function isReceiptTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return typeof name === 'string' && /timeout/i.test(name)
}

/**
 * Submit a contract write through wagmi's `sendTransaction` action rather than
 * the ethers signer transport. On mobile WalletConnect, wagmi's action triggers
 * the wallet-app redirect that surfaces the signing request; the raw ethers →
 * connector-transport path does not, so MetaMask opens without the request and
 * the send hangs forever. Used ONLY on the mobile branch — desktop keeps the
 * ethers `Contract.method(...)` call untouched.
 *
 * Returns an object shaped like the slice of ethers' `TransactionResponse` that
 * `sendAndWaitTx` consumes (`hash` + `wait(confirmations, timeout)` yielding a
 * receipt with `status` (0|1) and `logs`), so the shared send/wait engine and
 * its pending/timeout/receipt classification stay byte-for-byte the same.
 */
export async function submitTxViaWagmi(
  contract: Contract,
  method: string,
  args: readonly unknown[],
): Promise<TransactionResponse> {
  // Dynamic import: config/wagmi runs RainbowKit's getDefaultConfig at module
  // load (already evaluated by the app); deferring keeps this module importable
  // in unit tests without that side effect.
  const { wagmiConfig } = await import('@/config/wagmi')

  const to = contract.target as unknown as `0x${string}`
  const data = contract.interface.encodeFunctionData(method, args as unknown[]) as `0x${string}`

  const hash = await sendTransaction(wagmiConfig, { to, data, chainId: getHubChainId() })

  const response = {
    hash,
    wait: async (confirmations: number = getTxConfirmations(), timeoutMs: number = TX_WAIT_TIMEOUT_MS) => {
      try {
        const receipt = await waitForTransactionReceipt(wagmiConfig, {
          hash,
          confirmations,
          timeout: timeoutMs,
        })
        return {
          status: receipt.status === 'success' ? 1 : 0,
          logs: receipt.logs.map((log) => ({
            topics: log.topics,
            data: log.data,
            blockNumber: log.blockNumber != null ? Number(log.blockNumber) : undefined,
            transactionHash: log.transactionHash ?? undefined,
            logIndex: log.logIndex ?? undefined,
          })) as readonly ReceiptLogLike[],
        }
      } catch (err) {
        // Normalize viem's receipt-wait timeout to the ethers timeout shape
        // (code: 'TIMEOUT') so a stalled mobile tx surfaces as "pending" via
        // sendAndWaitTx, never as success or failure.
        if (isReceiptTimeout(err)) {
          throw Object.assign(new Error('Transaction receipt timeout'), { code: 'TIMEOUT' })
        }
        throw err
      }
    },
  }

  return response as unknown as TransactionResponse
}
