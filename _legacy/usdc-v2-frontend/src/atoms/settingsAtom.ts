import { atom } from 'jotai'
import type { AppSettings } from '@/types/wallet'

export const defaultSettings: AppSettings = {
  preferredEvmChain: undefined,
  preferredTheme: 'system',
  enableNotifications: true,
}

export const settingsAtom = atom<AppSettings>(defaultSettings)

// TODO: Persist user preferences via storage/persist service layer.
