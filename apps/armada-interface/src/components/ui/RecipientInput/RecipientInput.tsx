// ABOUTME: RecipientInput — labelled text input for EVM/shielded addresses with optional error rendering and a paste-from-clipboard shortcut.
// ABOUTME: Pure presentational: validation lives in lib/address; callers decide the error string + accepted formats.

import { useId, useState, type ChangeEvent } from 'react'
import { WalletIcon } from '@heroicons/react/24/solid'
import { ClipboardPaste } from 'lucide-react'
import styles from './RecipientInput.module.css'

export interface RecipientInputProps {
  value: string
  onValueChange: (next: string) => void
  label?: string
  placeholder?: string
  disabled?: boolean
  /** Inline error message rendered below the input. Caller validates with lib/address helpers. */
  error?: string
  /** When true, renders a "Paste" button next to the input that pulls from navigator.clipboard. */
  showPasteButton?: boolean
  /** Leading wallet icon (e.g. locked connected-wallet recipient on withdraw). */
  showWalletIcon?: boolean
}

export function RecipientInput({
  value,
  onValueChange,
  label,
  placeholder = '0x…',
  disabled,
  error,
  showPasteButton = true,
  showWalletIcon = false,
}: RecipientInputProps) {
  const id = useId()
  const [pasted, setPasted] = useState(false)

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText()
      onValueChange(text.trim())
      setPasted(true)
      window.setTimeout(() => setPasted(false), 1200)
    } catch {
      // Clipboard read can fail in iframes or insecure contexts. Silent — user can still type.
    }
  }

  return (
    <div className={styles.root}>
      {label ? (
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
      ) : null}
      <div className={[styles.inputRow, showWalletIcon && styles.inputRowWithIcon]
        .filter(Boolean)
        .join(' ')}
      >
        {showWalletIcon ? (
          <span className={styles.walletIconWrap} aria-hidden>
            <WalletIcon className={styles.walletIcon} />
          </span>
        ) : null}
        <input
          id={id}
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className={styles.input}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onValueChange(e.target.value)}
        />
        {showPasteButton ? (
          <button
            type="button"
            className={styles.pasteBtn}
            onClick={handlePaste}
            disabled={disabled}
            aria-label="Paste from clipboard"
          >
            <ClipboardPaste size={14} aria-hidden="true" />
            <span>{pasted ? 'Pasted' : 'Paste'}</span>
          </button>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      ) : null}
    </div>
  )
}
