// ABOUTME: Controlled USDC amount input with a Max button that snaps to the
// ABOUTME: smallest of one or more labelled ceilings; used by commit/redeem forms.

import * as React from 'react'
import { Button } from './ui/button.js'
import { Input } from './ui/input.js'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip.js'
import { cn } from '../lib/utils.js'

export interface AmountCeiling {
  label: string
  value: bigint
}

export interface AmountInputProps {
  value: string
  onChange: (value: string) => void
  /** One or more upper bounds. Max button picks min(value); tooltip shows the binding label when >1. */
  ceilings?: AmountCeiling[]
  /** Fixed-point decimals for the Max button's value conversion. Defaults to 6 (USDC). */
  decimals?: number
  /** Marks the input as invalid for a11y; visible error text is rendered via FormMessage. */
  error?: boolean
  id?: string
  name?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  inputClassName?: string
  maxLabel?: string
  'aria-describedby'?: string
  'aria-label'?: string
  onBlur?: React.FocusEventHandler<HTMLInputElement>
}

function formatFromBigint(amount: bigint, decimals: number): string {
  if (amount <= 0n) return ''
  const scale = 10 ** decimals
  return (Number(amount) / scale).toString()
}

export function AmountInput({
  value,
  onChange,
  ceilings,
  decimals = 6,
  error,
  id,
  name,
  placeholder = '0',
  disabled,
  className,
  inputClassName,
  maxLabel = 'MAX',
  onBlur,
  ...ariaProps
}: AmountInputProps) {
  const binding = React.useMemo(() => {
    if (!ceilings || ceilings.length === 0) return null
    let smallest = ceilings[0]
    for (const c of ceilings) {
      if (c.value < smallest.value) smallest = c
    }
    return smallest
  }, [ceilings])

  const maxDisabled = disabled || !binding || binding.value <= 0n

  const handleMax = React.useCallback(() => {
    if (!binding || binding.value <= 0n) return
    onChange(formatFromBigint(binding.value, decimals))
  }, [binding, decimals, onChange])

  const maxButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-11 self-center rounded-[4px] border border-border/60 bg-transparent px-4 text-xs text-muted-foreground hover:border-hop-0/40 hover:bg-hop-0/10 hover:text-foreground"
      onClick={handleMax}
      disabled={maxDisabled}
    >
      {maxLabel}
    </Button>
  )

  const showTooltip = !maxDisabled && ceilings && ceilings.length > 1 && binding

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        id={id}
        name={name}
        type="text"
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        aria-invalid={error || undefined}
        aria-label={ariaProps['aria-label']}
        aria-describedby={ariaProps['aria-describedby']}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={cn(
          'h-11 flex-1 rounded-md border-border/70 bg-background/35 text-base font-medium tabular-nums shadow-inner placeholder:text-muted-foreground/60 focus-visible:border-primary/70 focus-visible:ring-primary/20',
          inputClassName,
        )}
      />
      {showTooltip ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>{maxButton}</TooltipTrigger>
            <TooltipContent side="top">
              Limited by {binding.label}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        maxButton
      )}
    </div>
  )
}
