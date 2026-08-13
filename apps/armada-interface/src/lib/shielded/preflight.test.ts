// ABOUTME: Tests for assertSpendPreflight — passes through an ok result, and throws the ArmadaError that
// ABOUTME: matches the first failed finding so the tx-error classifier renders the right typed failure.

import { describe, it, expect } from 'vitest'
import {
  ArmadaError,
  FeeQuoteExpiredError,
  InsufficientBalanceError,
  InvalidRequestError,
  NoteAlreadySpentError,
  RootMismatchError,
  type Plan,
  type PreflightFinding,
  type PreflightResult,
} from '@armada/sdk'
import { assertSpendPreflight } from './preflight'

/** A wallet stub whose preflight returns a canned result — the plan value is irrelevant to the gate. */
function walletReturning(result: PreflightResult) {
  return { preflight: async (_plan: Plan): Promise<PreflightResult> => result }
}
const PLAN = {} as Plan
const finding = (check: PreflightFinding['check'], ok: boolean, detail?: string): PreflightFinding => ({
  check,
  ok,
  ...(detail !== undefined ? { detail } : {}),
})

describe('assertSpendPreflight', () => {
  it('resolves without throwing when the preflight passed', async () => {
    const wallet = walletReturning({ ok: true, findings: [finding('root-freshness', true)] })
    await expect(assertSpendPreflight(wallet, PLAN)).resolves.toBeUndefined()
  })

  it('throws RootMismatchError (ROOT_MISMATCH) when root-freshness failed', async () => {
    const wallet = walletReturning({ ok: false, findings: [finding('root-freshness', false, 'root 0xabc evicted')] })
    await expect(assertSpendPreflight(wallet, PLAN)).rejects.toBeInstanceOf(RootMismatchError)
  })

  it('throws NoteAlreadySpentError when a nullifier was already spent', async () => {
    const wallet = walletReturning({ ok: false, findings: [finding('nullifier-unspent', false)] })
    await expect(assertSpendPreflight(wallet, PLAN)).rejects.toBeInstanceOf(NoteAlreadySpentError)
  })

  it('throws FeeQuoteExpiredError for a stale fee quote', async () => {
    const wallet = walletReturning({ ok: false, findings: [finding('fee-quote-expiry', false)] })
    await expect(assertSpendPreflight(wallet, PLAN)).rejects.toBeInstanceOf(FeeQuoteExpiredError)
  })

  it('throws InsufficientBalanceError for balance-sufficiency', async () => {
    const wallet = walletReturning({ ok: false, findings: [finding('balance-sufficiency', false)] })
    await expect(assertSpendPreflight(wallet, PLAN)).rejects.toBeInstanceOf(InsufficientBalanceError)
  })

  it('maps cctp-liveness / other checks to InvalidRequestError (PRE_FLIGHT_REVERT downstream)', async () => {
    const wallet = walletReturning({ ok: false, findings: [finding('cctp-liveness', false)] })
    await expect(assertSpendPreflight(wallet, PLAN)).rejects.toBeInstanceOf(InvalidRequestError)
  })

  it('throws on the FIRST failed finding when several failed, and carries its detail as the message', async () => {
    const wallet = walletReturning({
      ok: false,
      findings: [finding('root-freshness', true), finding('nullifier-unspent', false, 'nf 0x1 spent'), finding('fee-quote-expiry', false)],
    })
    await expect(assertSpendPreflight(wallet, PLAN)).rejects.toMatchObject({
      code: 'NOTE_ALREADY_SPENT',
      message: 'nf 0x1 spent',
    })
  })

  it('every thrown error is an ArmadaError (so classifyHandlerError catches it)', async () => {
    const wallet = walletReturning({ ok: false, findings: [finding('root-freshness', false)] })
    await expect(assertSpendPreflight(wallet, PLAN)).rejects.toBeInstanceOf(ArmadaError)
  })
})
