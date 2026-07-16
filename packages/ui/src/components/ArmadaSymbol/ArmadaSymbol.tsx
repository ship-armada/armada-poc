// ABOUTME: Armada flotilla mark only (no wordmark) — for modal chrome and compact branding.

import { useId } from 'react'

export interface ArmadaSymbolProps {
  className?: string
  /** Render size in CSS pixels. Default 32. */
  size?: number
}

export function ArmadaSymbol({ className, size = 32 }: ArmadaSymbolProps) {
  const uid = useId().replace(/:/g, '')
  const grad = (n: number) => `url(#${uid}-lg${n})`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path d="M16.0001 32L13.405 29.405H18.5951L16.0001 32Z" fill={grad(0)} />
      <path d="M20.3249 27.6752H11.6752L9.51334 25.5134H22.4868L20.3249 27.6752Z" fill={grad(1)} />
      <path d="M16.0005 23.7837H7.78361L5.62103 21.6211H13.8379L16.0005 23.7837Z" fill={grad(2)} />
      <path d="M24.2164 23.7837H16.0009L18.1634 21.6211H26.379L24.2164 23.7837Z" fill={grad(3)} />
      <path d="M12.1081 19.8914H3.8913L1.72943 17.7296H9.94628L12.1081 19.8914Z" fill={grad(4)} />
      <path d="M28.1087 19.8914H19.8932L22.055 17.7296H30.2706L28.1087 19.8914Z" fill={grad(5)} />
      <path d="M32 15.9997H23.7845L16.0007 8.21604L8.21685 15.9997H0L16.0001 0L32 15.9997Z" fill={grad(6)} />
      <defs>
        {[0, 1, 2, 3, 4, 5, 6].map(n => (
          <linearGradient
            key={n}
            id={`${uid}-lg${n}`}
            x1="16"
            y1="32"
            x2="16"
            y2="0"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#F8D197" />
            <stop offset="1" stopColor="#CA8AEA" />
          </linearGradient>
        ))}
      </defs>
    </svg>
  )
}
