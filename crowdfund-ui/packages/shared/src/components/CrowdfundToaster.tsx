// ABOUTME: Shared sonner Toaster mount with themed classNames + positioning.
// ABOUTME: Used by observer + committer. Admin keeps its own bare mount (out of scope).

import { Toaster } from 'sonner'

export function CrowdfundToaster() {
  return (
    <Toaster
      position="bottom-right"
      expand
      visibleToasts={5}
      toastOptions={{
        classNames: {
          toast:
            '!bg-card !text-card-foreground !border !border-border shadow-lg rounded-lg',
          description: '!text-muted-foreground',
          actionButton:
            '!bg-primary !text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          cancelButton:
            '!bg-muted !text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          success: '!border-success/40',
          error: '!border-error/40',
          warning: '!border-warning/40',
          info: '!border-info/40',
          loading: '!border-info/40',
        },
      }}
    />
  )
}
