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

function buildDisplayTokens(
  toValue: string,
  mode: BalanceRollMode,
  fromValue?: string,
): DisplayToken[] {
  const toTokens = tokenizeBalance(toValue)
  const fromDigits =
    mode === 'fromValue' && fromValue
      ? tokenizeBalance(fromValue)
          .filter((token): token is Extract<BalanceToken, { type: 'digit' }> => token.type === 'digit')
          .map((token) => token.digit)
      : []

  const toDigitCount = toTokens.filter((token) => token.type === 'digit').length
  while (fromDigits.length < toDigitCount) {
    fromDigits.unshift(0)
  }

  let digitIndex = 0

  return toTokens.map((token) => {
    if (token.type === 'separator') {
      return { type: 'separator', char: token.char, key: token.key }
    }

    const fromDigit = mode === 'fromZero' ? 0 : (fromDigits[digitIndex] ?? 0)
    const displayDigit: DisplayDigit = {
      type: 'digit',
      key: token.key,
      digitIndex,
      fromDigit,
      toDigit: token.digit,
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
