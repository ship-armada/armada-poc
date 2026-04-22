// ABOUTME: Sonner toast content wrapper that animates in on copy-to-clipboard actions.
// ABOUTME: Scale 0.95 → 1.0, opacity 0 → 1 over 150ms via framer-motion.

import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

export function CopyToast({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.15 }}
    >
      {children}
    </motion.div>
  )
}
