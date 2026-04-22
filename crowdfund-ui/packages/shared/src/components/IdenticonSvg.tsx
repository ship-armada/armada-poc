// ABOUTME: Deterministic identicon renderer using @metamask/jazzicon.
// ABOUTME: Appends jazzicon's HTMLElement output into a ref'd div; re-renders when address or size changes.

import { useEffect, useRef } from 'react'
import jazzicon from '@metamask/jazzicon'

export interface IdenticonSvgProps {
  address: string
  size?: number
  className?: string
}

/** Seed jazzicon with the first 8 hex chars of the address (same convention as metamask). */
function addressSeed(addr: string): number {
  const hex = addr.startsWith('0x') ? addr.slice(2, 10) : addr.slice(0, 8)
  return parseInt(hex, 16) || 0
}

export function IdenticonSvg({ address, size = 32, className }: IdenticonSvgProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const child = jazzicon(size, addressSeed(address))
    el.replaceChildren(child)
  }, [address, size])

  return (
    <div
      ref={ref}
      aria-hidden
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        overflow: 'hidden',
        pointerEvents: 'none',
        display: 'inline-block',
        lineHeight: 0,
      }}
    />
  )
}
