// ABOUTME: Direct invite UI (Path B) — invite by address, inviter pays gas.
// ABOUTME: Shows invite slots per hop, address input, validation, and self-invite shortcut.

import { useState, useMemo, useCallback, useEffect } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer, JsonRpcProvider } from 'ethers'
import { Loader2, Ticket } from 'lucide-react'
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
  TOOLTIPS,
  ToggleGroup,
  ToggleGroupItem,
  hopLabel,
  formatUsdc,
  CROWDFUND_ABI_FRAGMENTS,
  HOP_CONFIGS,
  type GraphNode,
} from '@armada/crowdfund-shared'
import type { HopPosition } from '@/hooks/useEligibility'
import type { UseInviteLinksResult } from '@/hooks/useInviteLinks'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { getExplorerUrl } from '@/config/network'
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
}

interface InviteFormValues {
  inviteeAddress: string
}

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
        if (resolving) return // defer while the debounced resolver is in flight
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
  } = props

  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [selectedHop, setSelectedHop] = useState<number | null>(null)
  const tx = useTransactionFlow(signer, { explorerUrl: getExplorerUrl() })

  const schema = useMemo(
    () => makeInviteSchema(resolvedAddress, resolving),
    [resolvedAddress, resolving],
  )

  // Generic inference friction between @hookform/resolvers v5 and zod v4: runtime is correct,
  // so we cast the resolver to the expected shape.
  const form = useForm<InviteFormValues>({
    resolver: zodResolver(schema) as unknown as Resolver<InviteFormValues>,
    mode: 'onChange',
    defaultValues: { inviteeAddress: '' },
  })

  const inviteeAddress = form.watch('inviteeAddress')

  // Positions with available invite slots
  const invitePositions = useMemo(
    () => positions.filter((p) => p.invitesAvailable > 0),
    [positions],
  )

  // Auto-select first available hop
  useEffect(() => {
    if (selectedHop === null && invitePositions.length > 0) {
      setSelectedHop(invitePositions[0].hop)
    }
  }, [invitePositions, selectedHop])

  // ENS resolution — resolve names containing '.'
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
    }, 500) // debounce

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [provider, inviteeAddress])

  // Re-run validation when ENS state settles so the resolver sees the latest resolvedAddress.
  useEffect(() => {
    if (inviteeAddress) form.trigger('inviteeAddress')
  }, [resolvedAddress, resolving, inviteeAddress, form])

  // The effective address to invite (resolved ENS or direct input)
  const effectiveAddress = resolvedAddress ?? inviteeAddress
  const targetHop = selectedHop !== null ? selectedHop + 1 : 0

  // Duplicate invite warning — non-blocking amber hint, not a validation error.
  const duplicateWarning = useMemo(() => {
    if (!effectiveAddress || !isAddress(effectiveAddress) || selectedHop === null) return null
    const nodeKey = `${effectiveAddress.toLowerCase()}-${targetHop}`
    const existing = nodes.get(nodeKey)
    if (!existing || existing.invitesReceived === 0) return null
    const capUsdc = targetHop < HOP_CONFIGS.length ? HOP_CONFIGS[targetHop].capUsdc : 0n
    return `This address already has ${existing.invitesReceived} slot${existing.invitesReceived > 1 ? 's' : ''} at ${hopLabel(targetHop)}. Your invite will add another slot, increasing their cap by ${formatUsdc(capUsdc)}.`
  }, [effectiveAddress, selectedHop, targetHop, nodes])

  const canSubmit =
    form.formState.isValid &&
    effectiveAddress &&
    isAddress(effectiveAddress) &&
    selectedHop !== null &&
    phase === 0 &&
    windowOpen &&
    !resolving

  const onSubmit = useCallback(
    async (values: InviteFormValues) => {
      if (selectedHop === null) return
      const target = resolvedAddress ?? values.inviteeAddress.trim()
      if (!isAddress(target)) return

      const success = await tx.execute(
        `Invite to ${hopLabel(selectedHop + 1)}`,
        async (s) => {
          const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
          return crowdfund.invite(target, selectedHop)
        },
      )

      if (success) {
        form.reset({ inviteeAddress: '' })
        setResolvedAddress(null)
      }
    },
    [selectedHop, resolvedAddress, crowdfundAddress, tx, form],
  )

  const handleSelfInvite = useCallback(async (hop: number) => {
    if (!address) return

    await tx.execute(
      `Self-invite at ${hopLabel(hop + 1)}`,
      async (s) => {
        const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
        return crowdfund.invite(address, hop)
      },
    )
  }, [address, crowdfundAddress, tx])

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

  return (
    <div className="space-y-4">
      {/* Invite slot summary */}
      <div className="space-y-2">
        <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <span>Your Invite Slots</span>
          <InfoTooltip text={TOOLTIPS.slot} label="What is an invite slot?" />
          <InfoTooltip text={TOOLTIPS.hop} label="What is a hop?" />
        </div>
        {invitePositions.map((pos) => (
          <div
            key={pos.hop}
            className="flex items-center justify-between rounded border border-border p-2"
          >
            <div>
              <span className="text-sm font-medium">{hopLabel(pos.hop)}</span>
              <span className="text-xs text-muted-foreground ml-2">
                {pos.invitesUsed} used / {pos.invitesUsed + pos.invitesAvailable} total
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {pos.invitesAvailable} remaining
              </span>
              {/* Self-invite shortcut — separate action, not a form submit */}
              <Button
                variant="secondary"
                size="xs"
                onClick={() => handleSelfInvite(pos.hop)}
                title={`Invite yourself at ${hopLabel(pos.hop + 1)}`}
              >
                Self
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Direct invite form */}
      <Form {...form}>
        <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="text-xs font-medium text-muted-foreground">Send Direct Invite</div>

          {/* Hop selector */}
          <ToggleGroup
            type="single"
            value={selectedHop !== null ? String(selectedHop) : ''}
            onValueChange={(v) => {
              if (v !== '') setSelectedHop(Number(v))
            }}
            className="gap-1"
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

          {/* Address input */}
          <FormField
            control={form.control}
            name="inviteeAddress"
            render={({ field, fieldState }) => (
              <FormItem>
                <FormControl>
                  <Input
                    {...field}
                    type="text"
                    placeholder="0x... or ENS name"
                    className="text-sm font-mono"
                    aria-invalid={!!fieldState.error || undefined}
                  />
                </FormControl>
                {/* ENS resolution display — shown alongside the FormMessage */}
                {resolving && (
                  <div className="text-xs text-muted-foreground">Resolving ENS name...</div>
                )}
                {resolvedAddress && !fieldState.error && (
                  <div className="text-xs text-success">
                    {inviteeAddress} →{' '}
                    <span className="font-mono">
                      {resolvedAddress.slice(0, 6)}...{resolvedAddress.slice(-4)}
                    </span>
                  </div>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Duplicate invite warning — non-blocking amber hint */}
          {duplicateWarning && (
            <div className="text-xs text-amber-500 rounded border border-amber-500/30 bg-amber-500/5 p-2">
              {duplicateWarning}
            </div>
          )}

          {/* Invite button */}
          <Button
            type="submit"
            className="w-full"
            disabled={!canSubmit || form.formState.isSubmitting}
          >
            {form.formState.isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              'Send Invite'
            )}
          </Button>

          <div className="text-xs text-muted-foreground">
            Direct invite: you pay gas, invitee appears in the graph immediately.
            They can then commit USDC at hop-{(selectedHop ?? 0) + 1}.
          </div>
        </form>
      </Form>

      <InviteLinkSection
        inviteLinks={inviteLinks}
        positions={positions}
        blockTimestamp={blockTimestamp}
      />
    </div>
  )
}
