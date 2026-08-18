// ABOUTME: Armada logo — `full` (gradient flotilla glyph + "ARMADA" wordmark, 132×32) or `mark` (diamond symbol only, 32×32).
// ABOUTME: Extracted from the mockup's Header.tsx so consumer apps can build their own header chrome.

import styles from './ArmadaLogo.module.css'

export interface ArmadaLogoProps {
  /**
   * `mark` — diamond symbol only (mobile header). `full` — symbol + wordmark.
   * `mono` — full layout with every flotilla path in `currentColor`, so the parent's
   * CSS color drives the glyph (armada-interface's all-white dashboard logo).
   */
  variant?: 'full' | 'mark' | 'mono'
  /** Mark fill. `brand` — gem gradient (default). `white` — currentColor (dark chrome). `deep` — brand deep. */
  markTone?: 'brand' | 'white' | 'deep'
  className?: string
}

const GRADIENT_DEFS = (
  <defs>
    <linearGradient id="armada-lg0" x1="16" y1="32" x2="16" y2="0" gradientUnits="userSpaceOnUse">
      <stop stopColor="#F8D197" />
      <stop offset="1" stopColor="#CA8AEA" />
    </linearGradient>
    <linearGradient id="armada-lg1" x1="16" y1="32" x2="16" y2="0" gradientUnits="userSpaceOnUse">
      <stop stopColor="#F8D197" />
      <stop offset="1" stopColor="#CA8AEA" />
    </linearGradient>
    <linearGradient id="armada-lg2" x1="16" y1="32" x2="16" y2="0" gradientUnits="userSpaceOnUse">
      <stop stopColor="#F8D197" />
      <stop offset="1" stopColor="#CA8AEA" />
    </linearGradient>
    <linearGradient id="armada-lg3" x1="16" y1="32" x2="16" y2="0" gradientUnits="userSpaceOnUse">
      <stop stopColor="#F8D197" />
      <stop offset="1" stopColor="#CA8AEA" />
    </linearGradient>
    <linearGradient id="armada-lg4" x1="16" y1="32" x2="16" y2="0" gradientUnits="userSpaceOnUse">
      <stop stopColor="#F8D197" />
      <stop offset="1" stopColor="#CA8AEA" />
    </linearGradient>
    <linearGradient id="armada-lg5" x1="16" y1="32" x2="16" y2="0" gradientUnits="userSpaceOnUse">
      <stop stopColor="#F8D197" />
      <stop offset="1" stopColor="#CA8AEA" />
    </linearGradient>
    <linearGradient id="armada-lg6" x1="16" y1="32" x2="16" y2="0" gradientUnits="userSpaceOnUse">
      <stop stopColor="#F8D197" />
      <stop offset="1" stopColor="#CA8AEA" />
    </linearGradient>
  </defs>
)

function ArmadaMark({ tone = 'brand' }: { tone?: 'brand' | 'white' | 'deep' }) {
  const fill = tone === 'brand' ? undefined : 'currentColor'

  return (
    <>
      <path
        d="M16.0001 32L13.405 29.405H18.5951L16.0001 32Z"
        fill={fill ?? 'url(#armada-lg0)'}
      />
      <path
        d="M20.3249 27.6752H11.6752L9.51334 25.5134H22.4868L20.3249 27.6752Z"
        fill={fill ?? 'url(#armada-lg1)'}
      />
      <path
        d="M16.0005 23.7837H7.78361L5.62103 21.6211H13.8379L16.0005 23.7837Z"
        fill={fill ?? 'url(#armada-lg2)'}
      />
      <path
        d="M24.2164 23.7837H16.0009L18.1634 21.6211H26.379L24.2164 23.7837Z"
        fill={fill ?? 'url(#armada-lg3)'}
      />
      <path
        d="M12.1081 19.8914H3.8913L1.72943 17.7296H9.94628L12.1081 19.8914Z"
        fill={fill ?? 'url(#armada-lg4)'}
      />
      <path
        d="M28.1087 19.8914H19.8932L22.055 17.7296H30.2706L28.1087 19.8914Z"
        fill={fill ?? 'url(#armada-lg5)'}
      />
      <path
        d="M32 15.9997H23.7845L16.0007 8.21604L8.21685 15.9997H0L16.0001 0L32 15.9997Z"
        fill={fill ?? 'url(#armada-lg6)'}
      />
    </>
  )
}

export function ArmadaLogo({ variant = 'full', markTone = 'brand', className }: ArmadaLogoProps = {}) {
  if (variant === 'mark') {
    const markClassName = [className, markTone === 'deep' && styles.markDeep]
      .filter(Boolean)
      .join(' ')

    return (
      <svg
        className={markClassName || undefined}
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Armada"
        role="img"
      >
        <ArmadaMark tone={markTone} />
        {markTone === 'brand' ? GRADIENT_DEFS : null}
      </svg>
    )
  }

  const isDeep = markTone === 'deep'
  const fullClassName = [className, isDeep && styles.fullDeep].filter(Boolean).join(' ')
  const fullMarkTone = isDeep ? 'deep' : variant === 'mono' ? 'white' : 'brand'

  return (
    <svg
      className={fullClassName || undefined}
      width="132"
      height="32"
      viewBox="0 0 132 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Armada"
      role="img"
    >
      <ArmadaMark tone={fullMarkTone} />
      <path
        d="M54.5439 23.9917H51.5312L50.4043 20.4985H45.8184L44.9795 17.896H49.5645L47.2725 10.7837L44.9795 17.896L43.0146 23.9917H40L45.502 8.0083H49.042L54.5439 23.9917ZM62.4424 8.0083C63.5382 8.00834 64.5015 8.2097 65.3301 8.61279C66.1601 9.01591 66.7987 9.5882 67.248 10.3257C67.6975 11.0648 67.9219 11.898 67.9219 12.8267C67.9219 13.7553 67.6857 14.6083 67.2139 15.3384C66.8193 15.9489 66.2924 16.4427 65.6367 16.8247C66.2683 17.2309 66.7727 17.7419 67.1465 18.3628C67.6183 19.1467 67.8545 20.034 67.8545 21.0239V23.9917H64.9775V21.0239C64.9775 20.3999 64.8546 19.8639 64.6113 19.4146C64.368 18.9652 64.0023 18.6231 63.5156 18.3872C63.0289 18.1513 62.4346 18.0327 61.7344 18.0327H58.9717V23.9917H56.1416V8.0083H62.4424ZM73.3135 8.01611L73.3379 8.0083L77.916 19.6421L82.4951 8.0083L82.5439 8.02393L82.541 8.0083H85.8291V23.9917H83.1797V12.73L78.7734 23.9917H77.0391L72.6523 12.6987V23.9907H70.0039V8.0083H73.3154L73.3135 8.01611ZM101.966 23.9917H98.9521L97.8252 20.4985H93.2402L92.4004 17.896H96.9863L94.6943 10.7837L92.4004 17.896L90.4346 23.9917H87.4209L92.9229 8.0083H96.4639L101.966 23.9917ZM109.066 8.0083C110.619 8.00835 111.973 8.35906 113.13 9.05908C114.287 9.75931 115.178 10.715 115.802 11.9243C116.426 13.1351 116.737 14.4926 116.737 16.0005C116.737 17.5083 116.426 18.8659 115.802 20.0767C115.178 21.2876 114.286 22.2416 113.13 22.9419C111.973 23.6421 110.619 23.9916 109.066 23.9917H103.562V8.0083H109.066ZM125.83 8.0083L131.333 23.9917H128.318L127.193 20.4985H122.607L121.769 17.896H126.354L124.061 10.7837L121.769 17.896L119.802 23.9917H116.789L122.291 8.0083H125.83ZM106.394 21.2974H106.395V20.9546C106.395 21.183 106.509 21.2974 106.737 21.2974H108.838C109.872 21.2973 110.767 21.0686 111.521 20.6118C112.275 20.1549 112.845 19.5274 113.233 18.7271C113.622 17.9268 113.815 17.0192 113.815 15.9995C113.815 14.9799 113.621 14.0707 113.233 13.272C112.845 12.4732 112.275 11.8441 111.521 11.3872C110.767 10.9304 109.872 10.7017 108.838 10.7017H106.394V21.2974ZM58.9717 15.52H62.1006C62.6945 15.52 63.2078 15.4286 63.6406 15.2466C64.0751 15.0644 64.4096 14.7943 64.6455 14.436C64.8814 14.0792 65 13.618 65 13.0552C65 12.4923 64.8814 12.0274 64.6455 11.6616C64.4097 11.2961 64.0861 11.0224 63.6758 10.8403C63.2652 10.6582 62.7766 10.5679 62.2139 10.5679H58.9717V15.52Z"
        className={isDeep ? undefined : styles.wordmark}
        fill={isDeep ? 'currentColor' : undefined}
      />
      {variant === 'mono' || isDeep ? null : GRADIENT_DEFS}
    </svg>
  )
}
