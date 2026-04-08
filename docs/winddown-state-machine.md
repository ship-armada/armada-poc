# Wind-Down Sequence

State machine for ArmadaWindDown and the post-trigger redemption flow.

## Trigger Paths

```mermaid
flowchart TD
    A[Normal Operation] --> B{Which trigger path?}

    B -->|Permissionless| C[triggerWindDown]
    C --> D{deadline passed?}
    D -->|no| X1[REVERT]
    D -->|yes| E{revenue < threshold?}
    E -->|no| X2[REVERT: revenue meets threshold]
    E -->|yes| F[_executeWindDown]

    B -->|Governance| G[governanceTriggerWindDown]
    G --> H{caller == timelock?}
    H -->|no| X3[REVERT]
    H -->|yes| F

    F --> I[triggered = true — PERMANENT]
```

- **Permissionless path**: Anyone can trigger if `block.timestamp > windDownDeadline` AND `recognizedRevenueUsd < revenueThreshold`. Designed as a safety valve if the protocol fails to generate sufficient revenue.
- **Governance path**: Timelock can trigger at any time, no conditions. Requires a governance proposal (Extended type).
- Both paths converge on `_executeWindDown()`. Once `triggered = true`, it cannot be reversed.

## On-Trigger Effects

```mermaid
flowchart LR
    A[_executeWindDown] --> B[ARM token: setTransferable → true]
    A --> C[Governor: setWindDownActive → true]
    A --> D[ShieldPauseController: setWindDownActive → true]

    B --> B1[ARM holders can freely transfer/sell]
    C --> C1[No new proposals can be created]
    D --> D1[Shield pause limited to single use]
```

| Effect | Contract | Method | Impact |
|--------|----------|--------|--------|
| Enable ARM transfers | ArmadaToken | `setTransferable(true)` | Holders can move ARM to redeem |
| Disable governance | ArmadaGovernor | `setWindDownActive()` | All propose/vote/execute reverts |
| Post-wind-down pause mode | ShieldPauseController | `setWindDownActive()` | SC gets one final pause only |

## Treasury Sweep

After trigger, anyone can sweep non-ARM assets from treasury to the redemption contract:

```mermaid
flowchart TD
    A[triggered == true] --> B[sweepToken — permissionless]
    A --> C[sweepETH — permissionless]

    B --> D{token == ARM?}
    D -->|yes| X[REVERT: cannot sweep ARM]
    D -->|no| E[treasury.transferTo → redemptionContract]

    C --> F[treasury.transferETHTo → redemptionContract]
```

- **ARM is never swept** — treasury ARM stays locked permanently
- Sweep bypasses outflow rate limits (wind-down authority)
- Anyone can call sweep — no access control after trigger

## Redemption Flow

```mermaid
flowchart TD
    A[ARM holder] -->|redeem| B[ArmadaRedemption.redeem]
    B --> C[Burn ARM tokens]
    C --> D[Calculate pro-rata share of each treasury asset]
    D --> E[Transfer share of each asset to redeemer]
```

- Pro-rata: `payout = (armAmount / armTotalSupply) * assetBalance`
- Permissionless, no admin, no deadline, no upgradeability
- Multiple redemption tokens supported (USDC, ETH, etc.)
- ARM total supply decreases with each redemption (burn)

## Governable Parameters (Pre-Trigger Only)

| Parameter | Setter | Constraint |
|-----------|--------|------------|
| `revenueThreshold` | `setRevenueThreshold()` — timelock only | Must be > 0 (prevents disabling trigger) |
| `windDownDeadline` | `setWindDownDeadline()` — timelock only | Must be in the future |

Both setters revert after trigger (`require(!triggered)`). Both are Extended selectors requiring 30% quorum and 14-day voting.
