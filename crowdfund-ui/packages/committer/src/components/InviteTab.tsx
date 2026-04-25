// ABOUTME: Invite flow as a stepwise checkout — mode → details → review → status.
// ABOUTME: Direct on-chain invites run the full 4-step path; shareable links use a 2-step path.

import { useState, useMemo, useCallback, useEffect } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer, JsonRpcProvider, TransactionResponse } from 'ethers'
import { Link2, Send, Ticket } from 'lucide-react'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Button,
  EmptyState,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
  InfoTooltip,
  Input,
  StepFooter,
  Stepper,
  type StepperStep,
  TOOLTIPS,
  ToggleGroup,
  ToggleGroupItem,
  TxStatusPipeline,
  type TxPipelineRow,
  type TxPipelineStatus,
  hopLabel,
  formatUsdc,
  CROWDFUND_ABI_FRAGMENTS,
  HOP_CONFIGS,
  useTxToast,
  type GraphNode,
} from '@armada/crowdfund-shared'
import type { HopPosition } from '@/hooks/useEligibility'
import type { UseInviteLinksResult } from '@/hooks/useInviteLinks'
import { getExplorerUrl } from '@/config/network'
import { mapRevertToMessage } from '@/lib/revertMessages'
import { InviteLinkSection } from './InviteLinkSection'

export interface InviteTabProps {
  positions: HopPosition[]
  signer: Signer | null
  address: string | null
  crowdfundAddress: string
  phase: number
  windowOpen: boolean
  inviteLinks: UseInviteLinksResult
  blockTimestamp: number
  nodes: Map<string, GraphNode>
  provider: JsonRpcProvider | null
  /** Optional: invoked when the user clicks Back from step 1, returning to
   *  the Participate page's intent picker. */
  onBackToIntent?: () => void
}

type InviteMode = 'direct' | 'link'
type Step = 'mode' | 'details' | 'review' | 'status' | 'link'

interface InviteFormValues {
  inviteeAddress: string
}

const DIRECT_STEPS: ReadonlyArray<StepperStep> = [
  { id: 'mode', label: 'Choose invite type' },
  { id: 'details', label: 'Enter recipient' },
  { id: 'review', label: 'Review and confirm' },
  { id: 'status', label: 'Pending / Success' },
]

const LINK_STEPS: ReadonlyArray<StepperStep> = [
  { id: 'mode', label: 'Choose invite type' },
  { id: 'link', label: 'Generate shareable link' },
]

function makeInviteSchema(resolvedAddress: string | null, resolving: boolean) {
  return z
    .object({
      inviteeAddress: z.string(),
    })
    .superRefine((values, ctx) => {
      const raw = values.inviteeAddress.trim()
      if (!raw) {
        ctx.addIssue({
          code: 'custom',
          path: ['inviteeAddress'],
          message: 'Address or ENS name required',
        })
        return
      }
      if (raw.includes('.')) {
        if (resolving) return
        if (!resolvedAddress) {
          ctx.addIssue({
            code: 'custom',
            path: ['inviteeAddress'],
            message: 'ENS name not found',
          })
        }
        return
      }
      if (!isAddress(raw)) {
        ctx.addIssue({
          code: 'custom',
          path: ['inviteeAddress'],
          message: 'Invalid Ethereum address',
        })
      }
    })
}

export function InviteTab(props: InviteTabProps) {
  const {
    positions,
    signer,
    address,
    crowdfundAddress,
    phase,
    windowOpen,
    inviteLinks,
    blockTimestamp,
    nodes,
    provider,
    onBackToIntent,
  } = props

  const [mode, setMode] = useState<InviteMode>('direct')
  const [step, setStep] = useState<Step>('mode')
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [selectedHop, setSelectedHop] = useState<number | null>(null)
  const [pipeline, setPipeline] = useState<TxPipelineRow[]>([])
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [pipelineError, setPipelineError] = useState<string | null>(null)
  const [pipelineDone, setPipelineDone] = useState(false)
  const txToast = useTxToast({ explorerUrl: getExplorerUrl() })

  const schema = useMemo(
    () => makeInviteSchema(resolvedAddress, resolving),
    [resolvedAddress, resolving],
  )

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(schema) as unknown as Resolver<InviteFormValues>,
    mode: 'onChange',
    defaultValues: { inviteeAddress: '' },
  })

  const inviteeAddress = form.watch('inviteeAddress')

  const invitePositions = useMemo(
    () => positions.filter((p) => p.invitesAvailable > 0),
    [positions],
  )

  useEffect(() => {
    if (selectedHop === null && invitePositions.length > 0) {
      setSelectedHop(invitePositions[0].hop)
    }
  }, [invitePositions, selectedHop])

  // ENS resolution — debounced 500ms
  useEffect(() => {
    if (!provider || !inviteeAddress.includes('.')) {
      setResolvedAddress(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setResolving(true)
      try {
        const addr = await provider.resolveName(inviteeAddress)
        if (!cancelled) setResolvedAddress(addr)
      } catch {
        if (!cancelled) setResolvedAddress(null)
      } finally {
        if (!cancelled) setResolving(false)
      }
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [provider, inviteeAddress])

  useEffect(() => {
    if (inviteeAddress) form.trigger('inviteeAddress')
  }, [resolvedAddress, resolving, inviteeAddress, form])

  const effectiveAddress = resolvedAddress ?? inviteeAddress.trim()
  const targetHop = selectedHop !== null ? selectedHop + 1 : 0

  const duplicateWarning = useMemo(() => {
    if (!effectiveAddress || !isAddress(effectiveAddress) || selectedHop === null) return null
    const nodeKey = `${effectiveAddress.toLowerCase()}-${targetHop}`
    const existing = nodes.get(nodeKey)
    if (!existing || existing.invitesReceived === 0) return null
    const capUsdc = targetHop < HOP_CONFIGS.length ? HOP_CONFIGS[targetHop].capUsdc : 0n
    return `This address already has ${existing.invitesReceived} slot${existing.invitesReceived > 1 ? 's' : ''} at ${hopLabel(targetHop)}. Your invite will add another slot, increasing their cap by ${formatUsdc(capUsdc)}.`
  }, [effectiveAddress, selectedHop, targetHop, nodes])

  const detailsValid =
    form.formState.isValid &&
    !!effectiveAddress &&
    isAddress(effectiveAddress) &&
    selectedHop !== null &&
    !resolving

  const explorer = getExplorerUrl()
  const explorerBuilder = useMemo(
    () => (explorer ? (h: string) => `${explorer}/tx/${h}` : undefined),
    [explorer],
  )

  /** Run the invite pipeline. The Self shortcut on the mode step skips the
   *  details + review path by passing an explicit override; the normal flow
   *  reads from the form / resolvedAddress. */
  const runPipeline = useCallback(
    async (override?: { target: string; hop: number; isSelf?: boolean }) => {
      if (!signer) return
      const hop = override?.hop ?? selectedHop
      if (hop === null) return
      const target =
        override?.target ??
        (resolvedAddress ?? form.getValues('inviteeAddress').trim())
      if (!isAddress(target)) return

      setStep('status')
      setPipelineRunning(true)
      setPipelineError(null)
      setPipelineDone(false)

      const opLabel = override?.isSelf
        ? `Self-invite at ${hopLabel(hop + 1)}`
        : `Invite to ${hopLabel(hop + 1)}`
      setPipeline([
        {
          id: 'invite',
          label: opLabel,
          detail: `${target.slice(0, 6)}…${target.slice(-4)}`,
          status: 'idle' as TxPipelineStatus,
          explorerUrl: explorerBuilder,
        },
      ])

      const setRow = (patch: Partial<TxPipelineRow>) =>
        setPipeline((prev) => prev.map((r) => (r.id === 'invite' ? { ...r, ...patch } : r)))

      setRow({ status: 'pending' })
      const handle = txToast.notifyTxPending(opLabel)
      let txHash: string | null = null
      try {
        const send = async (s: Signer): Promise<TransactionResponse> => {
          const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
          return crowdfund.invite(target, hop)
        }
        const tx = await send(signer)
        txHash = tx.hash
        setRow({ status: 'submitted', txHash })
        txToast.notifyTxSubmitted(handle, tx.hash)

        const receipt = await tx.wait()
        if (!receipt || receipt.status === 0) {
          const msg = 'Transaction reverted'
          setRow({ status: 'error', errorMessage: msg, txHash })
          txToast.notifyTxFailed(handle, msg)
          setPipelineError(msg)
          setPipelineRunning(false)
          return
        }

        setRow({ status: 'confirmed', txHash })
        txToast.notifyTxConfirmed(handle)
        setPipelineRunning(false)
        setPipelineDone(true)
      } catch (err) {
        const msg = mapRevertToMessage(err)
        setRow({ status: 'error', errorMessage: msg, txHash })
        txToast.notifyTxFailed(handle, msg)
        setPipelineError(msg)
        setPipelineRunning(false)
      }
    },
    [
      signer,
      selectedHop,
      resolvedAddress,
      form,
      crowdfundAddress,
      txToast,
      explorerBuilder,
    ],
  )

  const handleSelfInvite = useCallback(
    (hop: number) => {
      if (!address) return
      runPipeline({ target: address, hop, isSelf: true })
    },
    [address, runPipeline],
  )

  const resetFlow = useCallback(() => {
    form.reset({ inviteeAddress: '' })
    setResolvedAddress(null)
    setPipeline([])
    setPipelineError(null)
    setPipelineDone(false)
    setStep('mode')
  }, [form])

  if (invitePositions.length === 0) {
    return (
      <EmptyState
        icon={Ticket}
        title="No Invite Slots Available"
        description={
          positions.length === 0
            ? 'You must be invited to the crowdfund before you can invite others.'
            : 'All your invite slots have been used.'
        }
      />
    )
  }

  if (phase !== 0 || !windowOpen) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        Invites can only be sent during the active sale window.
      </div>
    )
  }

  const steps = mode === 'direct' ? DIRECT_STEPS : LINK_STEPS
  const stepIndex = Math.max(
    0,
    steps.findIndex((s) => s.id === step),
  )

  return (
    <Stepper steps={steps} current={stepIndex}>
      <Form {...form}>
        {step === 'mode' && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-base font-medium text-foreground">
                How do you want to invite?
              </div>
              <div className="text-sm text-muted-foreground">
                Send an invite directly to a wallet address, or generate a shareable link the
                invitee redeems on their own.
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <span>Your invite slots</span>
                <InfoTooltip text={TOOLTIPS.slot} label="What is an invite slot?" />
                <InfoTooltip text={TOOLTIPS.hop} label="What is a hop?" />
              </div>
              {invitePositions.map((pos) => (
                <div
                  key={pos.hop}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-card/50 px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <span className="font-medium text-foreground">{hopLabel(pos.hop)}</span>
                    <span className="ml-2 text-muted-foreground">
                      {pos.invitesUsed} used / {pos.invitesUsed + pos.invitesAvailable} total
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground tabular-nums">
                      {pos.invitesAvailable} remaining
                    </span>
                    {/* Self-invite shortcut — bypasses the details + review
                        steps and goes straight to the status step, since
                        the recipient (you) and hop are already known. */}
                    {address && (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => handleSelfInvite(pos.hop)}
                        title={`Invite yourself at ${hopLabel(pos.hop + 1)}`}
                      >
                        Self
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setMode('direct')}
                className={`rounded-md border bg-card/40 p-4 text-left transition-colors hover:border-primary/60 ${
                  mode === 'direct' ? 'border-primary' : 'border-border/60'
                }`}
              >
                <Send className="mb-2 size-4 text-primary" aria-hidden="true" />
                <div className="text-sm font-medium text-foreground">Direct on-chain invite</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  You pay gas. The invitee appears in the graph immediately.
                </div>
              </button>
              <button
                type="button"
                onClick={() => setMode('link')}
                className={`rounded-md border bg-card/40 p-4 text-left transition-colors hover:border-primary/60 ${
                  mode === 'link' ? 'border-primary' : 'border-border/60'
                }`}
              >
                <Link2 className="mb-2 size-4 text-primary" aria-hidden="true" />
                <div className="text-sm font-medium text-foreground">Shareable link</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Sign once and share — the invitee pays gas when they redeem.
                </div>
              </button>
            </div>

            <StepFooter
              onBack={onBackToIntent}
              onNext={() => setStep(mode === 'direct' ? 'details' : 'link')}
              backLabel="Back"
              nextLabel="Continue"
            />
          </div>
        )}

        {step === 'details' && mode === 'direct' && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-base font-medium text-foreground">
                Who are you inviting?
              </div>
              <div className="text-sm text-muted-foreground">
                Pick a slot and the recipient address (or ENS name).
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Slot
              </div>
              <ToggleGroup
                type="single"
                value={selectedHop !== null ? String(selectedHop) : ''}
                onValueChange={(v) => {
                  if (v !== '') setSelectedHop(Number(v))
                }}
                className="flex flex-wrap gap-1"
              >
                {invitePositions.map((pos) => (
                  <ToggleGroupItem
                    key={pos.hop}
                    value={String(pos.hop)}
                    size="sm"
                    className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  >
                    From {hopLabel(pos.hop)} → {hopLabel(pos.hop + 1)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <FormField
              control={form.control}
              name="inviteeAddress"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      {...field}
                      type="text"
                      placeholder="0x… or ENS name"
                      className="text-sm font-mono"
                      aria-invalid={!!fieldState.error || undefined}
                    />
                  </FormControl>
                  {resolving && (
                    <div className="text-xs text-muted-foreground">Resolving ENS name…</div>
                  )}
                  {resolvedAddress && !fieldState.error && (
                    <div className="text-xs text-success">
                      {inviteeAddress} →{' '}
                      <span className="font-mono">
                        {resolvedAddress.slice(0, 6)}…{resolvedAddress.slice(-4)}
                      </span>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            {address &&
              effectiveAddress &&
              isAddress(effectiveAddress) &&
              effectiveAddress.toLowerCase() === address.toLowerCase() && (
                <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-500">
                  Inviting yourself is allowed — your slot count at the source hop will be
                  consumed.
                </div>
              )}

            {duplicateWarning && (
              <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-500">
                {duplicateWarning}
              </div>
            )}

            <StepFooter
              onBack={() => setStep('mode')}
              onNext={() => setStep('review')}
              nextDisabled={!detailsValid}
              nextLabel="Continue"
            />
          </div>
        )}

        {step === 'review' && mode === 'direct' && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-base font-medium text-foreground">Review and confirm</div>
              <div className="text-sm text-muted-foreground">
                You're sending an on-chain invite at {hopLabel(targetHop)}. You pay the gas.
              </div>
            </div>

            <div className="rounded-md border border-border/60 bg-card/40 p-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">From slot</span>
                <span className="font-medium">
                  {selectedHop !== null ? hopLabel(selectedHop) : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">To hop</span>
                <span className="font-medium">{hopLabel(targetHop)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Recipient</span>
                <span className="font-mono text-xs">
                  {effectiveAddress
                    ? `${effectiveAddress.slice(0, 6)}…${effectiveAddress.slice(-4)}`
                    : '—'}
                </span>
              </div>
            </div>

            <StepFooter
              onBack={() => setStep('details')}
              onNext={runPipeline}
              nextLabel="Confirm transaction"
            />
          </div>
        )}

        {step === 'status' && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-base font-medium text-foreground">
                {pipelineRunning
                  ? 'Submitting your invite'
                  : pipelineError
                  ? 'Something went wrong'
                  : pipelineDone
                  ? 'Invite sent!'
                  : 'Preparing transaction'}
              </div>
              <div className="text-sm text-muted-foreground">
                {pipelineRunning
                  ? 'Confirm in your wallet. The recipient will appear in the graph once the transaction confirms.'
                  : pipelineDone
                  ? "The invite is on-chain. The recipient can commit at the new hop right away."
                  : null}
              </div>
            </div>

            <TxStatusPipeline rows={pipeline} />

            <StepFooter
              onBack={pipelineRunning ? undefined : () => setStep('review')}
              onNext={pipelineDone ? resetFlow : undefined}
              backLabel="Back to review"
              nextLabel="Send another invite"
              nextVariant="outline"
              hideNext={!pipelineDone && !pipelineError}
            />
          </div>
        )}

        {step === 'link' && mode === 'link' && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-base font-medium text-foreground">Shareable link</div>
              <div className="text-sm text-muted-foreground">
                Sign an EIP-712 message to mint a redeemable link. Anyone with the link can join
                at the chosen hop until you revoke it or it expires.
              </div>
            </div>

            <InviteLinkSection
              inviteLinks={inviteLinks}
              positions={positions}
              blockTimestamp={blockTimestamp}
            />

            <StepFooter onBack={() => setStep('mode')} hideNext />
          </div>
        )}
      </Form>
    </Stepper>
  )
}
