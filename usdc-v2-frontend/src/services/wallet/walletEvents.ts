export interface EvmAccountsChangedPayload {
  accounts: string[]
}

export interface EvmChainChangedPayload {
  chainIdHex: string
}

export interface EvmDisconnectedPayload {
  error?: unknown
}

interface WalletEventPayloadMap {
  'evm:accountsChanged': EvmAccountsChangedPayload
  'evm:chainChanged': EvmChainChangedPayload
  'evm:disconnected': EvmDisconnectedPayload
}

export type WalletEventName = keyof WalletEventPayloadMap

type WalletEventHandler<E extends WalletEventName> = (payload: WalletEventPayloadMap[E]) => void

const handlers = new Map<WalletEventName, Set<WalletEventHandler<WalletEventName>>>()

export function onWalletEvent<E extends WalletEventName>(event: E, handler: WalletEventHandler<E>): void {
  const existing = handlers.get(event) ?? new Set<WalletEventHandler<WalletEventName>>()
  existing.add(handler as WalletEventHandler<WalletEventName>)
  handlers.set(event, existing)
}

export function offWalletEvent<E extends WalletEventName>(event: E, handler: WalletEventHandler<E>): void {
  handlers.get(event)?.delete(handler as WalletEventHandler<WalletEventName>)
}

export function emitWalletEvent<E extends WalletEventName>(event: E, payload: WalletEventPayloadMap[E]): void {
  handlers.get(event)?.forEach((handler) => {
    ;(handler as WalletEventHandler<E>)(payload)
  })
}
