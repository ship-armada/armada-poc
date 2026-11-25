// ABOUTME: /refund page — lets a wallet claim back its USDC from the cancelled first-sale (Sale 1) crowdfund.
// ABOUTME: Served in both pre-launch and live builds; reads the refund from the contract and sends claimRefund().

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Signer } from 'ethers'
import { ArmadaLogo, Button } from '@armada/ui'
import { formatUsdc } from '@armada/crowdfund-shared'
import { useWallet } from '@/hooks/useWallet'
import { useRefundOnlyClaim } from '@/hooks/useRefundOnlyClaim'
import { refundOnlyContract } from '@/lib/refundOnlyClaim'
import { sendAndWaitTx } from '@/lib/sendAndWaitTx'
import { submitWrite } from '@/lib/submitWrite'
import { describeSignerError, resolveSigner } from '@/lib/resolveSigner'
import { removePendingTx, savePendingTx } from '@/lib/pendingTx'
import { getExplorerUrl, getHubChainId, getHubNetworkLabel } from '@/config/network'
import styles from './RefundPage.module.css'

/** Label for the header tx chip (pending-tx watcher) while the claim is in flight. */
const TX_LABEL = 'Claim first-sale refund'

type TxState =
  | { status: 'idle' }
  | { status: 'confirm' }
  | { status: 'submitting'; hash: string }
  | { status: 'done'; hash?: string }
  | { status: 'error'; message: string; hash?: string }

function TxLink({ hash }: { hash?: string }) {
  const explorer = getExplorerUrl()
  if (!hash || !explorer) return null
  return (
    <a className={styles.txLink} href={`${explorer}/tx/${hash}`} target="_blank" rel="noopener noreferrer">
      View transaction
    </a>
  )
}

export function RefundPage() {
  const navigate = useNavigate()
  const wallet = useWallet()
  const { crowdfundAddress, provider, state, loading, refetch } = useRefundOnlyClaim(wallet.address)
  const [tx, setTx] = useState<TxState>({ status: 'idle' })

  // A switched account starts fresh; the previous wallet's claim outcome must not carry over.
  useEffect(() => {
    setTx({ status: 'idle' })
  }, [wallet.address])

  const busy = tx.status === 'confirm' || tx.status === 'submitting'

  const handleClaim = async () => {
    if (busy || !crowdfundAddress || !wallet.address) return
    const startAddress = wallet.address
    setTx({ status: 'confirm' })

    // Prefer the hook-derived signer; useWalletClient can stay empty for a whole session after a
    // fresh connect (wagmi #2784 / #3825), so fall back to asking the connector at click time.
    let signer = wallet.signer as Signer | null
    if (!signer) {
      try {
        signer = await resolveSigner()
      } catch (err) {
        setTx({ status: 'error', message: describeSignerError(err) })
        return
      }
    }
    const activeSigner = signer

    const result = await sendAndWaitTx(
      () => submitWrite(refundOnlyContract(crowdfundAddress, activeSigner), 'claimRefund', [], activeSigner),
      (hash) => {
        // Recorded for the header tx chip so the live app can surface it after a navigation. The
        // receipt is deliberately NOT fed into the live sale's event store: it is another contract.
        savePendingTx({ chainId: getHubChainId(), address: startAddress, txHash: hash, label: TX_LABEL, sentAt: Date.now() })
        setTx({ status: 'submitting', hash })
      },
      provider,
    )
    // A timed-out tx may still confirm, so it stays recorded for the pending-tx watcher.
    if (result.hash && result.outcome !== 'timeout') removePendingTx(result.hash)

    if (result.outcome === 'success') {
      setTx({ status: 'done', hash: result.hash })
      void refetch()
    } else if (result.outcome === 'rejected') {
      setTx({ status: 'idle' })
    } else {
      setTx({ status: 'error', message: result.errorMessage ?? 'The claim failed.', hash: result.hash })
    }
  }

  let body
  if (!crowdfundAddress) {
    body = <p className={styles.body}>There are no first-sale refunds on this network.</p>
  } else if (!wallet.address) {
    body = (
      <>
        <p className={styles.body}>Connect the wallet you committed from to see your refund.</p>
        <Button variant="primary" size="lg" label="Connect wallet" showIcon={false} onClick={wallet.connect} />
      </>
    )
  } else if (tx.status === 'done') {
    body = (
      <>
        <p className={styles.success}>Refund claimed. Your USDC is back in this wallet.</p>
        <TxLink hash={tx.hash} />
      </>
    )
  } else if (loading || !state) {
    body = (
      <p className={styles.body} role="status">
        Checking your refund…
      </p>
    )
  } else if (state.kind === 'error') {
    body = (
      <>
        <p className={styles.body}>Couldn't load your refund. Check your connection and try again.</p>
        <Button variant="secondary" size="lg" label="Try again" showIcon={false} onClick={() => void refetch()} />
      </>
    )
  } else if (state.kind === 'none') {
    body = (
      <p className={styles.body}>
        This wallet didn't commit to the first sale, so it has no refund. If you committed from another
        wallet, switch to it in your wallet app.
      </p>
    )
  } else if (state.kind === 'unavailable') {
    body = <p className={styles.body}>Refunds from the first sale aren't available.</p>
  } else if (state.kind === 'claimed') {
    body = <p className={styles.body}>This wallet has already claimed its refund of {formatUsdc(state.amount)}.</p>
  } else {
    body = (
      <>
        <div className={styles.amountBlock}>
          <span className={styles.amountLabel}>Your refund</span>
          <span className={styles.amount}>{formatUsdc(state.amount)}</span>
          <span className={styles.amountUnit}>USDC</span>
        </div>
        {wallet.isWrongNetwork ? (
          <>
            <p className={styles.body}>Switch to {getHubNetworkLabel()} to claim.</p>
            <Button variant="primary" size="lg" label="Switch network" showIcon={false} onClick={wallet.switchNetwork} />
          </>
        ) : (
          <>
            {tx.status === 'error' && (
              <p className={styles.error} role="alert">
                {tx.message}
              </p>
            )}
            <Button
              variant="primary"
              size="lg"
              showIcon={false}
              disabled={busy}
              loading={busy}
              label={
                tx.status === 'confirm'
                  ? 'Confirm in your wallet…'
                  : tx.status === 'submitting'
                    ? 'Submitting…'
                    : tx.status === 'error'
                      ? 'Try again'
                      : 'Claim refund'
              }
              onClick={() => void handleClaim()}
            />
            {(tx.status === 'submitting' || tx.status === 'error') && <TxLink hash={tx.hash} />}
          </>
        )}
      </>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.logo}>
        <ArmadaLogo />
      </div>
      <div className={styles.card}>
        <h1 className={styles.title}>Claim your first-sale refund</h1>
        <p className={styles.intro}>
          The first Armada crowdfund was cancelled, so everyone who committed USDC to it can claim back
          the full amount. Refunds never expire.
        </p>
        {body}
      </div>
      <div className={styles.footer}>
        <Button
          variant="secondary"
          size="lg"
          label="Back to the crowdfund"
          showIcon={false}
          onClick={() => navigate('/')}
        />
      </div>
    </div>
  )
}
