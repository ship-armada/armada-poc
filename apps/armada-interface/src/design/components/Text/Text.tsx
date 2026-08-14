// ABOUTME: Typography primitive — applies a generated composite (e.g. ui/heading-sm) via .armada-text-* class.
// ABOUTME: Prefer HeadingSm for step titles; use Text with variant for other composites.

import type { ElementType, HTMLAttributes } from 'react'
import { typographyClassName, type TypographyVariant } from '../../typography/variants'
import styles from './Text.module.css'

export type { TypographyVariant }

export interface TextProps extends HTMLAttributes<HTMLElement> {
  variant: TypographyVariant
  as?: ElementType
}

export function Text({ variant, as: Component = 'p', className, ...props }: TextProps) {
  const cls = [typographyClassName(variant), styles.root, className].filter(Boolean).join(' ')
  return <Component className={cls} {...props} />
}
