// ABOUTME: ui/heading-sm — Geist Medium 17px / 24px line-height. Default element is h3 for step titles.
// ABOUTME: Wraps Text with variant ui-heading-sm; use instead of per-screen .title CSS.

import type { HTMLAttributes } from 'react'
import { Text } from '../Text'

export interface HeadingSmProps extends HTMLAttributes<HTMLHeadingElement> {
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'div' | 'p'
}

export function HeadingSm({ as = 'h3', className, children, ...props }: HeadingSmProps) {
  return (
    <Text variant="ui-heading-sm" as={as} className={className} {...props}>
      {children}
    </Text>
  )
}
