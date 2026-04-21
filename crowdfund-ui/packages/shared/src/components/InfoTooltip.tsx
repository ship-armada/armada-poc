// ABOUTME: Small lucide Info icon wrapped in a shadcn Tooltip for domain-term glossing.
// ABOUTME: Pair with text in a label/heading to annotate concepts like hop, pro-rata, slot.

import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.js'
import { cn } from '../lib/utils.js'

export interface InfoTooltipProps {
  text: string
  className?: string
  iconSize?: number
  /** aria-label for the trigger. Defaults to "More information". */
  label?: string
}

export function InfoTooltip({ text, className, iconSize = 14, label = 'More information' }: InfoTooltipProps) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors',
            className,
          )}
        >
          <Info size={iconSize} />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
