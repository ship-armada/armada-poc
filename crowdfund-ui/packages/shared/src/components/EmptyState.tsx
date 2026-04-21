// ABOUTME: Shared "no data" state — icon + title + optional description + optional action.
// ABOUTME: Used for absence-of-data surfaces; terminal-success screens stay bespoke.

import * as React from 'react'
import { type LucideIcon } from 'lucide-react'

import { cn } from '../lib/utils.js'

export interface EmptyStateProps {
  /** Lucide icon component rendered inside a muted rounded tile at the top. */
  icon: LucideIcon
  /** Primary title. Rendered in foreground colour with medium weight. */
  title: React.ReactNode
  /** Optional body copy underneath the title. */
  description?: React.ReactNode
  /** Optional primary action (button, link, etc.) rendered below the text. */
  action?: React.ReactNode
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 p-6 text-center',
        className,
      )}
    >
      <div className="rounded-md bg-muted p-3">
        <Icon className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <div className="font-medium text-foreground">{title}</div>
        {description ? (
          <div className="text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  )
}
