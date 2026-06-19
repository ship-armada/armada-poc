// ABOUTME: Shared sonner Toaster mount themed against @armada/ui design tokens.
// ABOUTME: Surfaces, text, borders, and status tints come from `--semantic-color-*` / `--primitives-*`, matching the designer's modal/header chrome.

import { Toaster } from 'sonner'
import styles from './CrowdfundToaster.module.css'

export function CrowdfundToaster() {
  return (
    <Toaster
      position="bottom-right"
      expand
      visibleToasts={5}
      toastOptions={{
        classNames: {
          toast: styles.toast,
          description: styles.description,
          actionButton: styles.actionButton,
          cancelButton: styles.cancelButton,
          success: styles.success,
          error: styles.error,
          warning: styles.warning,
          info: styles.info,
          loading: styles.loading,
        },
      }}
    />
  )
}
