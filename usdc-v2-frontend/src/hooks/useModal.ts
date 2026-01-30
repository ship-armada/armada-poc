import { useEffect } from 'react'

export interface UseModalOptions {
  /**
   * Function that returns true when the modal should not be closable (e.g., during transaction submission)
   */
  preventCloseWhen?: () => boolean
}

/**
 * Hook to handle common modal behaviors:
 * - Escape key to close
 * - Prevent body scroll when open
 * 
 * @param open - Whether the modal is open
 * @param onClose - Callback to close the modal
 * @param options - Optional configuration
 */
export function useModal(
  open: boolean,
  onClose: () => void,
  options?: UseModalOptions
) {
  // Handle Escape key to close modal
  useEffect(() => {
    if (!open) return

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        // Check if we should prevent closing
        if (options?.preventCloseWhen?.()) {
          return
        }
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open, onClose, options])

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }

    return () => {
      document.body.style.overflow = ''
    }
  }, [open])
}

