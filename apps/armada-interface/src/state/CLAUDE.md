# state/

Jotai atoms. **Read-mostly from components.** Write paths go through hooks or `set(upsertTxAtom)`.

| File | Atoms |
|---|---|
| `tx.ts` | `txListAtom` (root, all wallets) + `activeTxListAtom` (V2 Phase 6: filtered to `activeRailgunWalletIdAtom`) + `pendingTxsAtom` (sources from `activeTxListAtom`), `txByIdAtom(id)`, `txsForKindAtom(K)`, `txsForStatusAtom(s)`, `upsertTxAtom` (write-only). UI surfaces (History page, RecentActivityCard, InProgressCard, usePrivateUsdcDisplay) MUST read `activeTxListAtom` so wallet switches can't leak prior history. |
| `wallet.ts` | `evmAddressAtom`, `shieldedWalletAtom`, `usdcBalancesAtom`, `shieldedUsdcAtom`, `yieldSharesAtom` |
| `fees.ts` | `feeQuoteAtom`, `feeQuoteIsStaleAtom` (derived) |
| `visibility.ts` | `tabVisibleAtom` (updated only by `useTabVisible()` — single listener) |
| `ui.ts` | `openModalAtom` |

## Conventions

- **Atoms own no logic.** They expose data. Logic lives in hooks (which write atoms) and `lib/` (which produces values).
- **Derived atoms compose with `atom((get) => ...)`** so memoization is automatic. Don't add `useMemo` on top of `useAtomValue(derivedAtom)` — it's redundant.
- **Atom names end in `Atom`.** Match crowdfund-shared's convention.
- **Selector-style atoms (e.g. `txByIdAtom(id)`) return a NEW atom per call** — wrap with `useMemo` at the call site to avoid re-subscribing every render. Pattern:
  ```ts
  const record = useAtomValue(useMemo(() => txByIdAtom(id), [id]))
  ```
- **Never persist directly from a setter.** Atoms are runtime state. Persistence (IDB) is the hook's job — write to the atom AND `lib/.../storage.ts` in the same callback.
