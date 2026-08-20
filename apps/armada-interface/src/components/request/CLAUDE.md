# components/request/

The "Request USDC via link" flow — compose a payment request and share a link that drops the payer into a prefilled Send. Opened via `setOpenModal('request')` (the dashboard **Request** action).

## Contents

| Component | Purpose |
|---|---|
| `RequestModal` | Orchestrator on `FlowShell` (steps `Receive → Share link`). Owns amount/expiry/note state; builds the link on Create via `lib/payViaLink.buildPayViaLinkUrl` from the active wallet's 0zk address. |
| `RequestReceiveScreen` | Compose step — amount + `Link expires` SegmentedControl + optional note. "Create link" advances to the link screen. "Copy your address instead" hands off to `ReceiveDialog` (the amount-less path). |
| `RequestLinkScreen` | Link step — the generated URL (middle-truncated) + Copy, plus the wired-ready **Link revoked** variant. |

## What's real vs. deferred

- **Real:** amount / expiry / note / request id / the shareable `/pay-via-link` URL (with our origin + the real 0zk address). The payer path (landing → Send prefill) is in `pages/PayViaLinkLanding` + `hooks/usePayViaLinkIntent`.
- **Disabled placeholder — Revoke.** A session-local flag can't stop a payer who already has the link; true revocation needs shared backend state. The Revoke trigger is disabled + marked "coming soon". The `revoked` variant screen is built and rendered when `RequestLinkScreen`'s `revoked` prop is true — nothing sets it yet.
- **Dropped:** per-request "paid" tracking + the mockup's 60s mock auto-settle + fake tx hash. Received payments surface through the normal activity/receipt path (chunk 6b), not a request-specific signal — matching a payment back to a request would need memo-on-send tagging (not wired).

## Deviation from the mockup

The mockup's desktop compose has no plain copy-address affordance (it lives only in the mobile chooser sheet). To preserve the amount-less "share my address" path on desktop without the mobile chrome, `RequestReceiveScreen` adds a subtle **"Copy your address instead"** link that opens `ReceiveDialog`.
