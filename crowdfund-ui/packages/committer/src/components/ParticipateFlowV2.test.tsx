// ABOUTME: Tests for ParticipateFlowV2's approve+commit pipeline lifecycle guards.
// ABOUTME: An unmounted (orphaned) pipeline must not fire a wallet prompt for the next tx.
// @vitest-environment jsdom

import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getDefaultStore } from 'jotai'
import { ParticipateFlowV2, type ParticipateFlowV2Props } from './ParticipateFlowV2'
import { clearAllPipelines, pipelinesAtom, getPipelineState } from '@/hooks/useTxPipeline'
import type { HopPosition } from '@/hooks/useEligibility'
import type { CrowdfundInviteSlotSection } from '@armada/crowdfund-shared'

// The wallet step renders RainbowKit's ConnectButton.Custom — stub the wallet
// libs so the flow (which starts connected and auto-advances past that step)
// renders without a Wagmi/RainbowKit provider tree.
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: () => null },
  useConnectModal: () => ({ openConnectModal: vi.fn() }),
}))
vi.mock('wagmi', () => ({
  useDisconnect: () => ({ disconnect: vi.fn() }),
}))
// Local/test network mode has no block explorer; pin one so explorer links render.
const EXPLORER = 'https://explorer.test'
vi.mock('@/config/network', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/network')>()),
  getExplorerUrl: () => EXPLORER,
}))

// Drive the approve/commit contract calls via the mocked ethers Contract.
const approveSpy = vi.fn()
const commitSpy = vi.fn()
let approveImpl: () => Promise<unknown>
let commitImpl: () => Promise<unknown>

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: vi.fn(function () {
      return {
        approve: (...args: unknown[]) => {
          approveSpy(...args)
          return approveImpl()
        },
        commit: (...args: unknown[]) => {
          commitSpy(...args)
          return commitImpl()
        },
      }
    }),
  }
})

const ADDR = '0x' + 'a'.repeat(40)
const USDC = '0x' + 'd'.repeat(40)
const CROWDFUND = '0x' + 'c'.repeat(40)
const USDC_UNIT = 1_000_000n

const position: HopPosition = {
  hop: 0,
  invitesReceived: 1,
  committed: 0n,
  effectiveCap: 4000n * USDC_UNIT,
  remaining: 4000n * USDC_UNIT,
  invitesUsed: 0,
  invitesAvailable: 0,
  invitedBy: [],
}

/** Hop-0 invite section; `emptySlots` controls whether any invite slot is still free. */
function makeInviteSection(emptySlots: number): CrowdfundInviteSlotSection {
  const slots = [1, 2, 3].map((id) => ({
    id,
    status: id <= 3 - emptySlots ? ('redeemed' as const) : ('empty' as const),
  }))
  return {
    hop: 0,
    hopLabel: 'HOP-0',
    hopColor: '#ffffff',
    totalSlots: 3,
    config: {
      slots,
      copiedId: null,
      loadingId: null,
      onGenerateLink: vi.fn().mockResolvedValue(undefined),
      onCopy: vi.fn(),
      onRevoke: vi.fn(),
      onInviteOnchain: vi.fn().mockResolvedValue(false),
    },
  }
}

let refreshAllowance: ReturnType<typeof vi.fn>
let onRunningChange: ReturnType<typeof vi.fn>

function makeProps(): ParticipateFlowV2Props {
  refreshAllowance = vi.fn().mockResolvedValue(undefined)
  onRunningChange = vi.fn()
  return {
    walletConnected: true,
    walletAddress: ADDR,
    signer: {} as never,
    positions: [position],
    balance: 10_000n * USDC_UNIT,
    needsApproval: () => true, // force the approve tx so the pipeline is 2 txs
    refreshAllowance: refreshAllowance as unknown as () => Promise<void>,
    crowdfundAddress: CROWDFUND,
    usdcAddress: USDC,
    hopStats: [
      { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
      { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
      { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
    ],
    saleSize: 1_000_000n * USDC_UNIT,
    cappedDemand: 0n,
    windowOpen: true,
    onGoToMyPosition: vi.fn(),
    onGoToNetwork: vi.fn(),
    onReceiptLogs: vi.fn(),
    onRunningChange: onRunningChange as unknown as (running: boolean) => void,
    inviteSlotSections: [makeInviteSection(3)],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The pipeline store is module-global — clear engine records and the atom so
  // a pipeline from a prior test doesn't bleed into the next render.
  clearAllPipelines()
  getDefaultStore().set(pipelinesAtom, {})
})

describe('ParticipateFlowV2 pipeline detach/resume', () => {
  it('pauses (no commit prompt) when the flow detaches mid-pipeline, and resumes on remount', async () => {
    // approve's receipt is deferred so we can detach while it is "in flight".
    let resolveApproveWait: ((r: unknown) => void) | undefined
    const approveTx = {
      hash: '0xapprove',
      wait: () =>
        new Promise((res) => {
          resolveApproveWait = res
        }),
    }
    approveImpl = () => Promise.resolve(approveTx)
    commitImpl = () =>
      Promise.resolve({ hash: '0xcommit', wait: () => Promise.resolve({ status: 1, logs: [] }) })

    const { unmount } = render(<ParticipateFlowV2 {...makeProps()} />)
    const firstRefresh = refreshAllowance

    // First-timer: wallet → splash → Before you start. Step past both, then
    // enter an amount.
    fireEvent.click(await screen.findByRole('button', { name: 'Join now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Commit' }))
    const input = (await screen.findByRole('textbox')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    // Review → start the pipeline (approve, then commit).
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and commit' }))

    await act(async () => {})
    expect(approveSpy).toHaveBeenCalledTimes(1)
    expect(commitSpy).not.toHaveBeenCalled()

    // Detach the flow (modal closed) while approve's receipt is pending, then
    // let it resolve. The engine must pause before the commit send — no wallet
    // prompt with no UI behind it.
    unmount()
    await act(async () => {
      resolveApproveWait?.({ status: 1, logs: [] })
    })
    expect(firstRefresh).toHaveBeenCalled() // approve's `after` ran
    expect(commitSpy).not.toHaveBeenCalled()

    // Reopen the flow (remount, same address) → re-attach resumes the pipeline,
    // which now prompts for the commit it had parked on.
    render(<ParticipateFlowV2 {...makeProps()} />)
    await act(async () => {})
    expect(commitSpy).toHaveBeenCalledTimes(1)
  })

  it('clears the parent running flag when unmounted mid-pipeline', async () => {
    // Park the pipeline on the approve receipt so `submitting` stays true.
    approveImpl = () =>
      Promise.resolve({ hash: '0xapprove', wait: () => new Promise(() => {}) })
    commitImpl = () =>
      Promise.resolve({ hash: '0xcommit', wait: () => Promise.resolve({ status: 1, logs: [] }) })

    const { unmount } = render(<ParticipateFlowV2 {...makeProps()} />)

    // First-timer: wallet → splash → Before you start. Step past both, then
    // enter an amount.
    fireEvent.click(await screen.findByRole('button', { name: 'Join now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Commit' }))
    const input = (await screen.findByRole('textbox')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and commit' }))
    await act(async () => {})

    // The pipeline is in flight — the parent was told it is running.
    expect(onRunningChange).toHaveBeenCalledWith(true)

    // Closing the modal unmounts the flow; the parent's flag must reset so a
    // reopen doesn't think a pipeline is still running.
    unmount()
    expect(onRunningChange).toHaveBeenLastCalledWith(false)
  })
})

describe('ParticipateFlowV2 fully-committed shortcut', () => {
  it('skips a fully-committed participant straight to the confirmation screen (after events hydrate)', async () => {
    // Open the flow while events are still hydrating (no positions yet).
    const { rerender } = render(
      <ParticipateFlowV2 {...makeProps()} eventsLoading positions={[]} />,
    )
    expect(screen.getByText('Checking eligibility…')).toBeTruthy()

    // Events hydrate with a position already at its cap. The committed baseline
    // must be captured here (not frozen at the mount-time zero), so the flow
    // recognizes "fully committed" and lands on the confirmation screen — maxed
    // copy, stepper at Confirmation, Invite option — instead of a dead-end
    // "fully committed" message on the input step.
    const fullPosition: HopPosition = {
      hop: 0,
      invitesReceived: 1,
      committed: 4000n * USDC_UNIT,
      effectiveCap: 4000n * USDC_UNIT,
      remaining: 0n,
      invitesUsed: 0,
      invitesAvailable: 0,
      invitedBy: [],
    }
    rerender(<ParticipateFlowV2 {...makeProps()} eventsLoading={false} positions={[fullPosition]} />)

    expect(await screen.findByText('Already committed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Whitelist a friend' })).toBeTruthy()
    // No amount input — we skipped the commit/input step entirely.
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

describe('ParticipateFlowV2 splash card', () => {
  it('walks a first-timer splash → Before you start → commit', async () => {
    render(<ParticipateFlowV2 {...makeProps()} />)

    // Splash first — no amount input yet.
    expect(await screen.findByText(/invited to join the fleet/i)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()

    // Join → the pre-commit intro, still no amount input.
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }))
    expect(await screen.findByText('How to participate')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()

    // Continue → commit input appears.
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(await screen.findByRole('textbox')).toBeTruthy()
  })

  it('links Before you start\'s Contract tile to the deployed crowdfund', async () => {
    render(<ParticipateFlowV2 {...makeProps()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Join now' }))

    const link = await screen.findByRole('link', { name: /Contract/ })
    expect(link.getAttribute('href')).toBe(`${EXPLORER}/address/${CROWDFUND}`)
  })

  it('keeps the entered amount when going back from Review to Commit', async () => {
    render(<ParticipateFlowV2 {...makeProps()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Join now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Commit' }))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(await screen.findByRole('button', { name: 'Approve and commit' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(((await screen.findByRole('textbox')) as HTMLInputElement).value).toBe('100')
  })

  it('cross-fades between steps: the old step exits before the next one shows', async () => {
    render(<ParticipateFlowV2 {...makeProps()} />)
    const joinNow = await screen.findByRole('button', { name: 'Join now' })
    expect(joinNow.closest('[class*="frameEnter"]')).toBeTruthy()

    fireEvent.click(joinNow)
    // The splash stays up, animating out…
    expect(joinNow.closest('[class*="frameExit"]')).toBeTruthy()
    expect(screen.queryByText('How to participate')).toBeNull()
    // …then Before you start mounts with the enter animation.
    const heading = await screen.findByText('How to participate')
    expect(heading.closest('[class*="frameEnter"]')).toBeTruthy()
  })

  it('returns from Before you start to the splash on Back', async () => {
    render(<ParticipateFlowV2 {...makeProps()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Join now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))

    expect(await screen.findByText(/invited to join the fleet/i)).toBeTruthy()
  })

  it('skips the splash for a returning participant (goes straight to commit)', async () => {
    const returningPosition: HopPosition = {
      hop: 0,
      invitesReceived: 1,
      committed: 100n * USDC_UNIT,
      effectiveCap: 4000n * USDC_UNIT,
      remaining: 3900n * USDC_UNIT,
      invitesUsed: 0,
      invitesAvailable: 0,
      invitedBy: [],
    }
    render(<ParticipateFlowV2 {...makeProps()} positions={[returningPosition]} />)

    // Straight to the commit input — no splash.
    expect(await screen.findByRole('textbox')).toBeTruthy()
    expect(screen.queryByText(/invited to join the fleet/i)).toBeNull()
  })
})

describe('ParticipateFlowV2 modal close handoff', () => {
  it('hands the close control to the step chrome from Before you start onward', async () => {
    const onModalCloseChange = vi.fn()
    render(<ParticipateFlowV2 {...makeProps()} onModalCloseChange={onModalCloseChange} />)

    // The splash card draws its own X — the modal hides its.
    expect(await screen.findByRole('button', { name: 'Join now' })).toBeTruthy()
    expect(onModalCloseChange).toHaveBeenLastCalledWith(false)

    // Before you start and commit both draw their own FlowChrome close.
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Commit' }))
    await screen.findByRole('textbox')
    expect(onModalCloseChange).toHaveBeenLastCalledWith(false)
  })

  it('closes the splash from its own X (the only close control there)', async () => {
    const onClose = vi.fn()
    render(<ParticipateFlowV2 {...makeProps()} onClose={onClose} />)
    expect(await screen.findByRole('button', { name: 'Join now' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close participate flow' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps the modal close while the wallet is disconnected', async () => {
    const onModalCloseChange = vi.fn()
    render(
      <ParticipateFlowV2
        {...makeProps()}
        walletConnected={false}
        onModalCloseChange={onModalCloseChange}
      />,
    )
    await act(async () => {})
    expect(onModalCloseChange).toHaveBeenLastCalledWith(true)
  })

  it('keeps the modal close on the invite-slots step', async () => {
    getDefaultStore().set(pipelinesAtom, {
      [ADDR]: { rows: [{ label: 'Commit participation', status: 'done' }], phase: 'success' },
    })
    const onModalCloseChange = vi.fn()
    render(<ParticipateFlowV2 {...makeProps()} onModalCloseChange={onModalCloseChange} />)

    // Confirmation owns its chrome; stepping into invite slots hands the close back.
    expect(onModalCloseChange).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Whitelist a friend' }))
    await act(async () => {})
    expect(onModalCloseChange).toHaveBeenLastCalledWith(true)
  })
})

describe('ParticipateFlowV2 finished-pipeline cleanup', () => {
  it('clears a finished pipeline on close so reopening does not re-attach to the stale confirmation', () => {
    const store = getDefaultStore()
    // Prior commit left the address-keyed pipeline in a terminal "success" state.
    store.set(pipelinesAtom, {
      [ADDR]: { rows: [{ label: 'Commit participation', status: 'done' }], phase: 'success' },
    })

    const { unmount } = render(<ParticipateFlowV2 {...makeProps()} />)
    // Re-attaches to the confirmation screen on open.
    expect(screen.getByRole('button', { name: 'Whitelist a friend' })).toBeTruthy()

    // Closing clears the finished pipeline → a reopen starts fresh (can commit more).
    unmount()
    expect(getPipelineState(store, ADDR).phase).toBe('idle')
  })
})

describe('ParticipateFlowV2 in-flow close', () => {
  it('asks before the step X closes the flow mid-transaction', async () => {
    // approve stays pending so the pipeline is in flight when X is pressed.
    approveImpl = () => Promise.resolve({ hash: '0xapprove', wait: () => new Promise(() => {}) })
    const onClose = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm')

    render(<ParticipateFlowV2 {...makeProps()} onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Join now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Commit' }))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and commit' }))
    await act(async () => {})
    expect(approveSpy).toHaveBeenCalledTimes(1)

    // Declining the prompt keeps the flow open.
    confirmSpy.mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: 'Close participate flow' }))
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()

    // Accepting it closes.
    confirmSpy.mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close participate flow' }))
    expect(onClose).toHaveBeenCalledOnce()
    confirmSpy.mockRestore()
  })

  it('closes without asking when nothing is in flight', async () => {
    const onClose = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm')

    render(<ParticipateFlowV2 {...makeProps()} onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Join now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close participate flow' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
    confirmSpy.mockRestore()
  })
})

describe('ParticipateFlowV2 confirmation invite gate', () => {
  function renderConfirmation(sections: CrowdfundInviteSlotSection[]) {
    getDefaultStore().set(pipelinesAtom, {
      [ADDR]: { rows: [{ label: 'Commit participation', status: 'done' }], phase: 'success' },
    })
    render(<ParticipateFlowV2 {...makeProps()} inviteSlotSections={sections} />)
  }

  it('offers Whitelist a friend while an invite slot is free', () => {
    renderConfirmation([makeInviteSection(1)])
    expect(screen.getByRole('button', { name: 'Whitelist a friend' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to crowdfund' })).toBeNull()
  })

  it('hides Whitelist a friend when every invite slot is used', () => {
    renderConfirmation([makeInviteSection(0)])
    expect(screen.queryByRole('button', { name: 'Whitelist a friend' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to crowdfund' })).toBeTruthy()
  })

  it('shows the real commit-window countdown in What happens next', () => {
    getDefaultStore().set(pipelinesAtom, {
      [ADDR]: { rows: [{ label: 'Commit participation', status: 'done' }], phase: 'success' },
    })
    render(<ParticipateFlowV2 {...makeProps()} secondsLeft={5 * 86_400 + 600} />)
    fireEvent.click(screen.getByRole('button', { name: 'While the window is open' }))
    expect(screen.getByText(/closes in 5 days\./)).toBeTruthy()
  })

  it('hides Whitelist a friend for a Hop-2 wallet, which cannot invite', () => {
    const hop2Section: CrowdfundInviteSlotSection = {
      ...makeInviteSection(0),
      hop: 2,
      hopLabel: 'HOP-2',
      totalSlots: 0,
    }
    hop2Section.config = { ...hop2Section.config, slots: [] }
    renderConfirmation([hop2Section])
    expect(screen.queryByRole('button', { name: 'Whitelist a friend' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to crowdfund' })).toBeTruthy()
  })
})
