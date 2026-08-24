// ABOUTME: ChainSelect — full-width styled popover over the configured chains in network.ts (hub + clients by default).
// ABOUTME: Trigger + listbox match the mockup's SendRecipientScreen network selector; icons via @web3icons, else a letter avatar.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDownIcon } from '@heroicons/react/24/solid'
import { getAllChainIdentities, type ChainIdentity } from '@/config/network'
import { chainIconForChainId } from '@/components/ui/chainIcons'
import { useMobileLayout } from '@/hooks/useMobileLayout'
import { BottomSheet } from '@/design'
import styles from './ChainSelect.module.css'

const ICON_SIZE = 32

export interface ChainSelectProps {
  /** Selected chainId. */
  value: number
  onChange: (chainId: number) => void
  /** Subset of chains to offer; defaults to [hub, ...clients]. */
  chains?: ReadonlyArray<ChainIdentity>
  /** Accessible name for the trigger (no visible label is rendered — matches the mockup). */
  label?: string
  disabled?: boolean
  className?: string
}

function ChainIcon({ chainId, name }: { chainId: number; name: string }) {
  const Icon = chainIconForChainId(chainId)
  if (Icon) {
    // `background` variant carries the network's own dark circular backdrop (matches the mockup).
    return (
      <span className={styles.iconSlot} aria-hidden>
        <Icon size={ICON_SIZE} variant="background" />
      </span>
    )
  }
  // Unmapped chain (e.g. local Anvil with no brand): letter avatar on a neutral slot.
  return (
    <span className={[styles.iconSlot, styles.iconSlotFallback].join(' ')} aria-hidden>
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

export function ChainSelect({ value, onChange, chains, label, disabled, className }: ChainSelectProps) {
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // On phones the option list opens as a BottomSheet instead of the inline popover (mockup 748ba20).
  const isMobile = useMobileLayout()

  // useMemo so the default chain list is stable across renders without re-running getAllChainIdentities.
  const options = useMemo(() => chains ?? getAllChainIdentities(), [chains])
  const selected = options.find(c => c.chainId === value) ?? options[0]
  const selectable = !disabled && options.length > 1

  useEffect(() => {
    // The mobile BottomSheet owns its own dismissal (scrim + Escape), so the outside-click handler
    // is desktop-only.
    if (!menuOpen || isMobile) return
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [menuOpen, isMobile])

  function selectChain(nextId: number) {
    onChange(nextId)
    setMenuOpen(false)
  }

  const cls = [styles.root, className].filter(Boolean).join(' ')

  const optionItems = options.map(option => (
    <li key={option.chainId} role="presentation">
      <button
        type="button"
        role="option"
        aria-selected={option.chainId === value}
        className={styles.option}
        onClick={() => selectChain(option.chainId)}
      >
        <ChainIcon chainId={option.chainId} name={option.name} />
        <span className={styles.optionLabel}>{option.name}</span>
      </button>
    </li>
  ))

  // Non-interactive "coming soon" hint below the selectable chains. `role="presentation"` keeps it
  // out of the listbox's option set (not selectable, not arrow-navigable); the text stays perceivable.
  const moreChainsNotice = (
    <li role="presentation" className={styles.notice}>
      More chains supported soon
    </li>
  )

  return (
    <div className={cls} ref={rootRef}>
      {selectable ? (
        <button
          type="button"
          className={styles.trigger}
          aria-haspopup={isMobile ? 'dialog' : 'listbox'}
          aria-expanded={menuOpen}
          aria-controls={isMobile ? undefined : listboxId}
          aria-label={label}
          onClick={() => setMenuOpen(open => !open)}
        >
          <ChainIcon chainId={selected?.chainId ?? value} name={selected?.name ?? ''} />
          <span className={styles.copy}>
            <span className={styles.label}>Network</span>
            <span className={styles.name}>{selected?.name}</span>
          </span>
          <ChevronDownIcon className={styles.chevron} aria-hidden />
        </button>
      ) : (
        <div className={styles.triggerStatic} aria-label={label}>
          <ChainIcon chainId={selected?.chainId ?? value} name={selected?.name ?? ''} />
          <span className={styles.copy}>
            <span className={styles.label}>Network</span>
            <span className={styles.name}>{selected?.name}</span>
          </span>
        </div>
      )}

      {menuOpen && selectable && !isMobile ? (
        <ul id={listboxId} className={styles.menu} role="listbox" aria-label="Network">
          {optionItems}
          {moreChainsNotice}
        </ul>
      ) : null}

      {selectable && isMobile ? (
        <BottomSheet
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          title="Network"
          ariaLabel="Network"
        >
          <ul className={styles.sheetList} role="listbox" aria-label="Network">
            {optionItems}
            {moreChainsNotice}
          </ul>
        </BottomSheet>
      ) : null}
    </div>
  )
}
