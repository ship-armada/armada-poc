import { createStore } from 'jotai'

/**
 * Shared Jotai store used across the application so that services can
 * interact with the same atom state as React components.
 */
export const jotaiStore = createStore()

export type AppStore = typeof jotaiStore

