// ABOUTME: React hook over the counted page scroll lock — holds one lock while `active`.
// ABOUTME: Used by the participate modal, invite action sheet, and invite method picker.

import { useEffect } from 'react'
import { lockBodyScroll } from '../lib/bodyScrollLock'

export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    return lockBodyScroll()
  }, [active])
}
