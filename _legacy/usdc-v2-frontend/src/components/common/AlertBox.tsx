import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type AlertTone = 'info' | 'warning' | 'error'

interface AlertBoxProps {
  title?: string
  tone?: AlertTone
  children?: ReactNode
}

const toneStyles: Record<AlertTone, string> = {
  info: 'card-info text-info-foreground',
  warning: 'card-warning text-warning-foreground',
  error: 'card-error text-error-foreground',
}

export function AlertBox({ title, tone = 'info', children }: AlertBoxProps) {
  return (
    <div className={cn('card px-4 py-3 text-sm', toneStyles[tone])}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      {children ? <div className="space-y-1 text-sm leading-relaxed">{children}</div> : null}
    </div>
  )
}
