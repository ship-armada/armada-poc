// ABOUTME: Shared class-name helper. Merges clsx + tailwind-merge into cn().
// ABOUTME: Consumed by shadcn primitives and any shared component that needs it.
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
