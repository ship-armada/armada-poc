import { useCallback } from 'react'
import { toast } from 'sonner'
import { TOAST_DURATION } from '@/config/constants'
import type { ReactNode } from 'react'
import { getToastIcon } from '@/utils/toastHelpers'

export type ToastLevel = 'success' | 'error' | 'info' | 'warning' | 'loading'

export interface ToastActionButton {
  label: string
  onClick: () => void | Promise<void>
}

export interface ToastArgs {
  title: string
  description?: string
  level?: ToastLevel
  duration?: number
  action?: ToastActionButton
  icon?: ReactNode
  id?: string | number
}

export function useToast() {
  const notify = useCallback(
    ({
      title,
      description,
      level = 'info',
      duration,
      action,
      icon,
      id,
    }: ToastArgs) => {
      // Determine duration based on level if not provided
      const toastDuration =
        duration ??
        (level === 'error'
          ? TOAST_DURATION.LONG
          : level === 'info'
            ? TOAST_DURATION.SHORT
            : level === 'loading'
              ? TOAST_DURATION.PERSISTENT
              : TOAST_DURATION.DEFAULT)

      const options: Parameters<typeof toast>[1] = {
        description,
        duration: toastDuration === Infinity ? undefined : toastDuration,
        id,
      }

      // Add action button if provided
      if (action) {
        options.action = {
          label: action.label,
          onClick: action.onClick,
        }
      }

      // Add custom icon if provided, otherwise use default icon with theme colors
      if (icon) {
        options.icon = icon
      } else {
        // Automatically add icon with theme colors when no icon is provided
        options.icon = getToastIcon(level)
      }

      // Handle different toast levels
      // Handle different toast levels and return the toast ID
      switch (level) {
        case 'success':
          return toast.success(title, options)
        case 'error':
          return toast.error(title, options)
        case 'warning':
          return toast.warning(title, options)
        case 'loading':
          return toast.loading(title, options)
        default:
          return toast(title, options)
      }
    },
    []
  )

  // Helper to update an existing toast (useful for transaction status updates)
  const updateToast = useCallback(
    (id: string | number, args: Omit<ToastArgs, 'id'>) => {
      notify({ ...args, id })
    },
    [notify]
  )

  // Helper to dismiss a toast
  const dismissToast = useCallback((id?: string | number) => {
    toast.dismiss(id)
  }, [])

  return { notify, updateToast, dismissToast }
}
