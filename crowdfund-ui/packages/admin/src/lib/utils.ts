// ABOUTME: Utility function for merging Tailwind CSS class names.
// ABOUTME: Used by all shadcn/ui components.
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
