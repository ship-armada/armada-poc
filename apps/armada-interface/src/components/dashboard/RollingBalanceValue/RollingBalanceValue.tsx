// ABOUTME: Odometer-style rolling numeric display that animates balance digits into place.
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  balanceRevealRollDurationMs,
  balanceRevealRollStartMs,
  BALANCE_ROLL_DIGIT_STAGGER_MS,
} from '@/components/dashboard/BalanceCard/balanceRevealMotion'
import styles from './RollingBalanceValue.module.css'

const DIGIT_SPIN_CYCLES = 1

export type BalanceRollMode = 'fromZero' | 'fromValue'

type BalanceToken =
  | { type: 'digit'; digit: number; key: string; digitIndex: number }
  | { type: 'separator'; char: string; key: string }

type DisplayDigit = {
  type: 'digit'
  key: string
  digitIndex: number
  fromDigit: number
  toDigit: number
}

type DisplayToken = DisplayDigit | { type: 'separator'; char: string; key: string }

function tokenizeBalance(value: string): BalanceToken[] {
  const tokens: BalanceToken[] = []
  let digitIndex = 0

  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i)
    if (char >= '0' && char <= '9') {
      tokens.push({
        type: 'digit',
        digit: Number(char),
        digitIndex,
        key: `d-${i}`,
      })
      digitIndex += 1
      continue
    }

    tokens.push({ type: 'separator', char, key: `s-${i}` })
  }

  return tokens
}

function parseAmountParts(value: string): { intDigits: number[]; fracDigits: number[] } {
  const cleaned = value.replace(/,/g, '')
  const dot = cleaned.indexOf('.')
  const intPart = (dot === -1 ? cleaned : cleaned.slice(0, dot)) || '0'
  const fracPart = dot === -1 ? '' : cleaned.slice(dot + 1)
  return {
    intDigits: intPart.split('').map((char) => Number(char)),
    fracDigits: fracPart.split('').map((char) => Number(char)),
  }
}

function groupedIntegerSkeleton(intDigits: number[]): string {
  return intDigits.join('').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Split into integer/fraction and pad each side independently so digits stay aligned on the
// decimal point across a roll — otherwise a width change (e.g. 1,000.00 → 250.00) misaligns the
// from/to digit columns and the roll passes through garbage intermediate numbers.
function buildDisplayTokens(
  toValue: string,
  mode: BalanceRollMode,
  fromValue?: string,
): DisplayToken[] {
  if (mode !== 'fromValue' || !fromValue) {
    return tokenizeBalance(toValue).map((token, index, tokens) => {
      if (token.type === 'separator') return { type: 'separator', char: token.char, key: token.key }
      const digitIndex = tokens.slice(0, index).filter((item) => item.type === 'digit').length
      return {
        type: 'digit',
        key: token.key,
        digitIndex,
        fromDigit: 0,
        toDigit: token.digit,
      }
    })
  }

  const from = parseAmountParts(fromValue)
  const to = parseAmountParts(toValue)
  const intWidth = Math.max(from.intDigits.length, to.intDigits.length, 1)
  const fracWidth = Math.max(from.fracDigits.length, to.fracDigits.length)

  while (from.intDigits.length < intWidth) from.intDigits.unshift(0)
  while (to.intDigits.length < intWidth) to.intDigits.unshift(0)
  while (from.fracDigits.length < fracWidth) from.fracDigits.push(0)
  while (to.fracDigits.length < fracWidth) to.fracDigits.push(0)

  const skeleton =
    fracWidth > 0
      ? `${groupedIntegerSkeleton(to.intDigits)}.${'0'.repeat(fracWidth)}`
      : groupedIntegerSkeleton(to.intDigits)

  const fromDigits = [...from.intDigits, ...from.fracDigits]
  const toDigits = [...to.intDigits, ...to.fracDigits]
  let digitIndex = 0

  return tokenizeBalance(skeleton).map((token) => {
    if (token.type === 'separator') {
      return { type: 'separator', char: token.char, key: token.key }
    }

    const displayDigit: DisplayDigit = {
      type: 'digit',
      key: token.key,
      digitIndex,
      fromDigit: fromDigits[digitIndex] ?? 0,
      toDigit: toDigits[digitIndex] ?? 0,
    }
    digitIndex += 1
    return displayDigit
  })
}

function digitEndOffset(fromDigit: number, toDigit: number): number {
  if (fromDigit === toDigit) return fromDigit
  const delta = (toDigit - fromDigit + 10) % 10
  return fromDigit + DIGIT_SPIN_CYCLES * 10 + delta
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface RollingBalanceValueProps {
  value: string
  className?: string
  enableRoll?: boolean
  mode?: BalanceRollMode
  fromValue?: string
  rollTrigger?: number
  rollStartMs?: number
  rollDurationMs?: number
  digitStaggerMs?: number
}

function DigitColumn({
  fromDigit,
  toDigit,
  digitIndex,
  animating,
  visible,
  rollDurationMs,
  digitStaggerMs,
}: {
  fromDigit: number
  toDigit: number
  digitIndex: number
  animating: boolean
  visible: boolean
  rollDurationMs: number
  digitStaggerMs: number
}) {
  const startOffset = fromDigit
  const endOffset = digitEndOffset(fromDigit, toDigit)
  const offset = animating ? endOffset : startOffset
  const shouldAnimate = animating && endOffset !== startOffset

  return (
    <span
      className={[styles.digitColumn, visible ? styles.digitVisible : styles.digitHidden].join(' ')}
      aria-hidden
    >
      <span
        className={
          shouldAnimate ? `${styles.digitTrack} ${styles.digitTrackRoll}` : styles.digitTrack
        }
        style={
          {
            '--digit-offset': offset,
            transitionDuration: shouldAnimate ? `${rollDurationMs}ms` : undefined,
            transitionDelay: shouldAnimate ? `${digitIndex * digitStaggerMs}ms` : undefined,
          } as CSSProperties
        }
      >
        {Array.from({ length: (DIGIT_SPIN_CYCLES + 2) * 10 }, (_, index) => (
          <span key={index} className={styles.digitCell}>
            {index % 10}
          </span>
        ))}
      </span>
    </span>
  )
}

export function RollingBalanceValue({
  value,
  className,
  enableRoll = true,
  mode = 'fromZero',
  fromValue,
  rollTrigger = 0,
  rollStartMs = balanceRevealRollStartMs(),
  rollDurationMs = balanceRevealRollDurationMs(),
  digitStaggerMs = BALANCE_ROLL_DIGIT_STAGGER_MS,
}: RollingBalanceValueProps) {
  const reducedMotion = prefersReducedMotion()
  const shouldRoll = enableRoll && !reducedMotion
  const [visible, setVisible] = useState(!shouldRoll || mode === 'fromValue')
  const [animating, setAnimating] = useState(false)
  const tokens = useMemo(
    () => buildDisplayTokens(value, mode, fromValue),
    [value, mode, fromValue],
  )

  useEffect(() => {
    if (!shouldRoll) {
      setVisible(true)
      setAnimating(false)
      return
    }

    if (mode === 'fromValue') {
      setVisible(true)
      setAnimating(false)

      let frame2 = 0
      const frame1 = window.requestAnimationFrame(() => {
        frame2 = window.requestAnimationFrame(() => setAnimating(true))
      })

      return () => {
        window.cancelAnimationFrame(frame1)
        window.cancelAnimationFrame(frame2)
      }
    }

    setVisible(false)
    setAnimating(false)

    const delay = rollTrigger === 0 ? rollStartMs : 0
    const timer = window.setTimeout(() => {
      setVisible(true)
      setAnimating(true)
    }, delay)

    return () => window.clearTimeout(timer)
  }, [shouldRoll, mode, rollStartMs, rollTrigger, value, fromValue])

  const rootClassName = [styles.root, className].filter(Boolean).join(' ')

  if (!shouldRoll) {
    return (
      <span className={rootClassName} aria-label={value}>
        {value}
      </span>
    )
  }

  return (
    <span className={rootClassName} aria-label={value}>
      {tokens.map((token) =>
        token.type === 'digit' ? (
          <DigitColumn
            key={token.key}
            fromDigit={token.fromDigit}
            toDigit={token.toDigit}
            digitIndex={token.digitIndex}
            animating={animating}
            visible={visible}
            rollDurationMs={rollDurationMs}
            digitStaggerMs={digitStaggerMs}
          />
        ) : (
          <span
            key={token.key}
            className={[styles.separator, visible && styles.separatorVisible].filter(Boolean).join(' ')}
            aria-hidden
          >
            {token.char}
          </span>
        ),
      )}
    </span>
  )
}
