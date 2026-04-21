// ABOUTME: Shared block-panel error/warning alert built on the shadcn Alert primitive.
// ABOUTME: Accepts a title, body children, optional lucide icon, and destructive|warning variant.

import * as React from 'react'
import { AlertTriangle, type LucideIcon } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from './ui/alert.js'
import { cn } from '../lib/utils.js'

export interface ErrorAlertProps {
  /** Optional title rendered above the body in a stronger weight. */
  title?: React.ReactNode
  /** Body content. May be a plain string or rich ReactNode. */
  children: React.ReactNode
  /**
   * Lucide icon component rendered on the left.
   * Defaults to AlertTriangle. Pass `false` to suppress the icon entirely.
   */
  icon?: LucideIcon | false
  /** Visual tone. Defaults to 'destructive'. */
  variant?: 'destructive' | 'warning'
  className?: string
}

export function ErrorAlert({
  title,
  children,
  icon,
  variant = 'destructive',
  className,
}: ErrorAlertProps) {
  const Icon = icon === false ? null : icon ?? AlertTriangle
  return (
    <Alert variant={variant} className={cn(className)}>
      {Icon ? <Icon /> : null}
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
