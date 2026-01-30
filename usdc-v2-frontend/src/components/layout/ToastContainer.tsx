import { Toaster } from 'sonner'

export function ToastContainer() {
  return (
    <Toaster
    richColors
      // richColors removed to allow full control over styling via classNames
      // If you need type-specific colors (success/error/warning), you can add them via classNames.success, etc.
      position="bottom-right"
      // closeButton removed - toasts will not show close button by default
      toastOptions={{
        classNames: {
          // Base toast styles (used as fallback for default/info toasts)
          toast:
            '!bg-card !text-card-foreground !border-border shadow-lg rounded-lg',
          description: '!text-muted-foreground',
          actionButton:
            '!bg-primary !text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          cancelButton:
            '!bg-muted !text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          // Success toast styling (using info border color, icon remains colored)
          success:
            '!border-info/40 shadow-lg rounded-lg',
          // Error toast styling (using info border color, icon remains colored)
          error:
            '!border-info/4- shadow-lg rounded-lg',
          // Warning toast styling (using info border color, icon remains colored)
          warning:
            '!border-info/40 shadow-lg rounded-lg',
          // Info toast styling
          info:
            '!border-info/40 shadow-lg rounded-lg',
          // Loading toast styling (using info border color, icon remains colored)
          loading:
            '!border-info/40 shadow-lg rounded-lg',
        },
        // Accessibility: Use appropriate aria-live regions
        // Sonner automatically uses aria-live="polite" for toasts
        // We can enhance with better descriptions
      }}
      expand
      visibleToasts={5}
      // Accessibility: Enable keyboard navigation
      // Sonner handles this automatically, but we ensure it's enabled
    />
  )
}
