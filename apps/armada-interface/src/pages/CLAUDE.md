# pages/

Top-level route components. Each is a thin shell that composes header chrome (from `AppLayout`) + page content (from `components/`).

| Page | Route | Purpose |
|---|---|---|
| `Dashboard.tsx` | `/` | Balance overview + action triggers (shield/unshield/yield/pay modals); hosts the "all activity" panel + per-tx receipt overlay |
| `Settings.tsx` | `/settings` | Wallet unlock, passphrase, export, reset, debug |
| `AddressBook.tsx` | `/address-book` | Parked placeholder — not in nav until built |
| `Debug.tsx` | `/debug` | Developer panel — contract addresses, per-chain balances. Faucet drip column appears only in local mode (no faucet contracts on Sepolia). |

## Conventions

- Pages own page-level effects (data fetches that trigger on navigation). They can use hooks freely.
- Pages compose `components/` and `hooks/`. They should be short — most logic belongs in hooks or `lib/`.
- Route registration lives in `src/main.tsx`. Don't add `<BrowserRouter>` or `<Routes>` inside a page.
- Modal flows are NOT pages. They're components inside `components/<feature>/` that open via `openModalAtom`.

## When you add a page

1. Create the `.tsx` file with an ABOUTME header and a default export of a named function component.
2. Register the route in `src/main.tsx` (`<Route path="..." element={<NewPage />} />`).
3. Add the nav entry in `components/AppLayout.tsx` (`NAV` array) if it should appear in the header.
