// ABOUTME: Balance display that scrambles/settles glyphs when toggling between masked and revealed states.
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  BALANCE_MASK_CHAR,
  BALANCE_SCRAMBLE_MS,
  BALANCE_SCRAMBLE_POOL,
  BALANCE_SCRAMBLE_SETTLE_MS,
  BALANCE_SCRAMBLE_STAGGER_MS,
  BALANCE_SCRAMBLE_TICK_MS,
  balanceScrambleMaxDurationMs,
  maskBalanceValue,
} from './balanceScrambleMotion'
import styles from './BalanceScrambleValue.module.css'

const DIGIT_SPIN_CYCLES = 1
const SCRAMBLE_CHARS = BALANCE_SCRAMBLE_POOL.split('')

function isDigitChar(char: string): boolean {
  return char >= '0' && char <= '9'
}

function digitEndOffset(fromDigit: number, toDigit: number): number {
  if (fromDigit === toDigit) return fromDigit
  const delta = (toDigit - fromDigit + 10) % 10
  return fromDigit + DIGIT_SPIN_CYCLES * 10 + delta
}

function randomPoolIndex(): number {
  return Math.floor(Math.random() * SCRAMBLE_CHARS.length)
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

type BalanceChar = {
  char: string
  key: string
  charIndex: number
}

function tokenizeBalance(value: string): BalanceChar[] {
  return value.split('').map((char, index) => ({
    char,
    key: `c-${index}`,
    charIndex: index,
  }))
}

function OdometerDigit({
  fromDigit,
  toDigit,
  durationMs,
}: {
  fromDigit: number
  toDigit: number
  durationMs: number
}) {
  const [animating, setAnimating] = useState(false)
  const endOffset = digitEndOffset(fromDigit, toDigit)
  const shouldAnimate = endOffset !== fromDigit

  useEffect(() => {
    if (!shouldAnimate) return

    let frame2 = 0
    const frame1 = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => setAnimating(true))
    })

    return () => {
      window.cancelAnimationFrame(frame1)
      window.cancelAnimationFrame(frame2)
    }
  }, [shouldAnimate, fromDigit, toDigit])

  const offset = animating ? endOffset : fromDigit

  return (
    <span className={styles.digitColumn} aria-hidden>
      <span
        className={
          shouldAnimate && animating
            ? `${styles.digitTrack} ${styles.digitTrackRoll}`
            : styles.digitTrack
        }
        style={
          {
            '--digit-offset': offset,
            transitionDuration: shouldAnimate && animating ? `${durationMs}ms` : undefined,
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

function SettleGlyph({ char }: { char: string }) {
  return (
    <span className={`${styles.settleGlyph} ${styles.settleGlyphReveal}`} aria-hidden>
      {char}
    </span>
  )
}

function ScrambleSlot({
  fromChar,
  toChar,
  charIndex,
}: {
  fromChar: string
  toChar: string
  charIndex: number
}) {
  const reducedMotion = prefersReducedMotion()
  const [phase, setPhase] = useState<'scramble' | 'settle' | 'done'>(
    reducedMotion ? 'done' : 'scramble',
  )
  const [spinOffset, setSpinOffset] = useState(() => {
    const start = isDigitChar(fromChar)
      ? SCRAMBLE_CHARS.indexOf(fromChar)
      : SCRAMBLE_CHARS.indexOf(fromChar) >= 0
        ? SCRAMBLE_CHARS.indexOf(fromChar)
        : randomPoolIndex()
    return start >= 0 ? start : 0
  })
  const lastSpinDigitRef = useRef(isDigitChar(fromChar) ? Number(fromChar) : 0)

  useEffect(() => {
    if (reducedMotion) {
      setPhase('done')
      return
    }

    const delay = charIndex * BALANCE_SCRAMBLE_STAGGER_MS
    let tickId = 0
    let scrambleStartId = 0
    let settleId = 0

    scrambleStartId = window.setTimeout(() => {
      tickId = window.setInterval(() => {
        const nextIndex = randomPoolIndex()
        const nextChar = SCRAMBLE_CHARS[nextIndex] ?? ''
        if (isDigitChar(nextChar)) {
          lastSpinDigitRef.current = Number(nextChar)
        }
        setSpinOffset(nextIndex)
      }, BALANCE_SCRAMBLE_TICK_MS)
    }, delay)

    settleId = window.setTimeout(() => {
      window.clearInterval(tickId)
      setPhase('settle')
    }, delay + BALANCE_SCRAMBLE_MS)

    return () => {
      window.clearTimeout(scrambleStartId)
      window.clearTimeout(settleId)
      window.clearInterval(tickId)
    }
  }, [charIndex, reducedMotion])

  if (phase === 'done' || reducedMotion) {
    return <span className={styles.glyph}>{toChar}</span>
  }

  if (phase === 'settle') {
    if (toChar === BALANCE_MASK_CHAR) {
      return <SettleGlyph char={BALANCE_MASK_CHAR} />
    }

    if (isDigitChar(toChar)) {
      return (
        <OdometerDigit
          fromDigit={lastSpinDigitRef.current}
          toDigit={Number(toChar)}
          durationMs={BALANCE_SCRAMBLE_SETTLE_MS}
        />
      )
    }

    return <SettleGlyph char={toChar} />
  }

  return (
    <span className={styles.spinColumn} aria-hidden>
      <span
        className={`${styles.spinTrack} ${styles.spinTrackTick}`}
        style={{ '--spin-offset': spinOffset } as CSSProperties}
      >
        {SCRAMBLE_CHARS.map((char) => (
          <span key={char} className={styles.spinCell}>
            {char}
          </span>
        ))}
      </span>
    </span>
  )
}

type TransitionState = {
  key: number
  from: string
  to: string
}

export interface BalanceScrambleValueProps {
  value: string
  revealed: boolean
  className?: string
  /** Strike through the glyphs (failed/cancelled activity amounts). The glyphs are inline-block, so
   *  a parent's `text-decoration` can't reach them — this strikes them directly. */
  struck?: boolean
}

export function BalanceScrambleValue({
  value,
  revealed,
  className,
  struck = false,
}: BalanceScrambleValueProps) {
  const maskedValue = useMemo(() => maskBalanceValue(value), [value])
  const targetValue = revealed ? value : maskedValue
  const staticValueRef = useRef(targetValue)
  const [staticValue, setStaticValue] = useState(targetValue)
  const [transition, setTransition] = useState<TransitionState | null>(null)
  const transitionRef = useRef<TransitionState | null>(null)
  const skipMountRef = useRef(true)
  const prevRevealedRef = useRef(revealed)
  const prevValueRef = useRef(value)

  transitionRef.current = transition

  useEffect(() => {
    if (transition) return

    if (prevValueRef.current === value) return

    prevValueRef.current = value
    const next = revealed ? value : maskedValue
    staticValueRef.current = next
    setStaticValue(next)
  }, [revealed, value, maskedValue, transition])

  useEffect(() => {
    if (skipMountRef.current) {
      skipMountRef.current = false
      staticValueRef.current = targetValue
      setStaticValue(targetValue)
      prevRevealedRef.current = revealed
      return
    }

    if (prevRevealedRef.current === revealed) return

    prevRevealedRef.current = revealed

    const inFlight = transitionRef.current
    let from = staticValueRef.current
    if (inFlight) {
      from = inFlight.to
      staticValueRef.current = from
      setStaticValue(from)
    }

    const to = revealed ? value : maskedValue
    if (from === to) {
      setTransition(null)
      return
    }

    const maxMs = balanceScrambleMaxDurationMs(to.length)

    setTransition({ key: Date.now(), from, to })

    const timer = window.setTimeout(() => {
      staticValueRef.current = to
      setStaticValue(to)
      setTransition(null)
    }, maxMs)

    return () => window.clearTimeout(timer)
  }, [revealed, value, maskedValue])

  const rootClassName = [styles.root, struck && styles.struck, className].filter(Boolean).join(' ')
  const fromValue = transition?.from ?? staticValue
  const toValue = transition?.to ?? staticValue
  const fromTokens = useMemo(() => tokenizeBalance(fromValue), [fromValue])
  const toTokens = useMemo(() => tokenizeBalance(toValue), [toValue])

  const renderGlyphs = (text: string, keyPrefix: string) =>
    tokenizeBalance(text).map((token) => (
      <span key={`${keyPrefix}-${token.key}`} className={styles.glyph}>
        {token.char}
      </span>
    ))

  return (
    <span className={rootClassName} aria-label={revealed ? value : 'Balance hidden'}>
      <span className={styles.widthAnchor} aria-hidden>
        {value}
      </span>
      <span className={styles.displayLayer}>
        {transition
          ? fromTokens.map((token, index) => (
              <ScrambleSlot
                key={`${transition.key}-${token.key}`}
                fromChar={token.char}
                toChar={toTokens[index]?.char ?? BALANCE_MASK_CHAR}
                charIndex={token.charIndex}
              />
            ))
          : renderGlyphs(toValue, 'static')}
      </span>
    </span>
  )
}
