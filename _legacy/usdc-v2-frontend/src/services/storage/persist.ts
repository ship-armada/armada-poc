import { loadItem, saveItem, deleteItem } from './localStore'

const WALLET_KEY = 'wallet-state'
const SETTINGS_KEY = 'app-settings'

export function persistWallet<T>(value: T): void {
  saveItem(WALLET_KEY, value)
}

export function restoreWallet<T>(): T | undefined {
  return loadItem<T>(WALLET_KEY)
}

export function clearWallet(): void {
  deleteItem(WALLET_KEY)
}

export function persistSettings<T>(value: T): void {
  saveItem(SETTINGS_KEY, value)
}

export function restoreSettings<T>(): T | undefined {
  return loadItem<T>(SETTINGS_KEY)
}

// TODO: Replace local storage with IndexedDB once shielded context persistence is implemented.
