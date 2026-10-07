# Crowdfund allocation model

`crowdfund-model.html` is a single self-contained page for modeling the crowdfund before launch. You enter prospective participants and their commits at each hop. The page shows how the sale would finalize with those numbers: the outcome, the sale size, each hop's fill and ceiling, and every participant's ARM allocation and USDC refund.

It uses the mainnet constants and reproduces `ArmadaCrowdfund.sol`'s `finalize()` math exactly, to the last USDC base unit.

There are two ways to use it, both running the same tested engine:

- **Shared Google Sheet:** the team edits one persistent sheet together, and live `=ARMADA_*` formulas recompute on every edit. See [Shared Google Sheet](#shared-google-sheet).
- **Standalone page:** `crowdfund-model.html`, offline, with saving in your own browser.

## Using the standalone page

- **Open it:** double-click `crowdfund-model.html`, or send the file to a teammate. It needs no build, server or network access.
- **Add participants:** each row is one participant, with a commit amount at each hop they hold.
- **Invites:** set the number of invites each hop-1 and hop-2 node received (1–10 and 1–20), counting self-invites. A node's cap is invites × the per-slot cap ($15k / $4k / $1k).
- **Self-fill:** the participant spends all their own outgoing invites on themselves and commits every hop to its cap. A blank row becomes a seed at $15k + 3 × $4k + 6 × $1k = $33k. Invites already received from others are kept, so they stack on top.
- **In checkbox:** untick a row to leave a "maybe" commit out of the model without deleting it.
- **Saving:** the scenario saves automatically in your browser's local storage.
- **Sharing scenarios:** use **Export scenario** and **Import CSV**. **Export results** writes every participant's per-hop accepted amount, ARM and refund at full 6-decimal precision.
- **Issues panel:** flags inputs the contract would reject (under the $10 minimum commit, invite counts out of range, more than 180 seeds or 1,800 nodes). It also warns when the listed participants hold more invites than the listed seeds, hop-1 nodes and launch team could issue.

Displayed amounts round down to the cent, so an ARM figure and a refund can appear to sum a cent short of the committed amount. The results CSV has the exact values.

### Scenario CSV format

```
name,include,hop0_commit,hop1_commit,hop1_invites,hop2_commit,hop2_invites
Alice,yes,15000,12000,3,6000,6
```

Amounts are in dollars and can have up to 6 decimals. A blank amount means no commit at that hop. Hop-0 always has exactly one invite.

**Keep scenarios out of git.** Prospective commits are private. This directory's `.gitignore` blocks `*.csv` and `*.json` here.

## Shared Google Sheet

The sheet keeps the participant list in one place that everyone can edit. Google handles sharing, simultaneous edits, comments and version history. The math runs in the sheet's Apps Script, which is the same engine code as the page.

### One-time setup

1. Create a Google Sheet and share it with named teammates. **Do not use "Publish to web"**, which makes the data public to anyone with the link.
2. Open **Extensions → Apps Script**, replace the default `Code.gs` contents with [`sheet/Code.gs`](sheet/Code.gs), and save.
3. Reload the sheet. An **Armada** menu appears. Run **Armada → Set up model sheets** and grant the permission Google asks for (this is the first-run authorization step).
4. Run **Armada → Run self-test**. It must say `OK`. This confirms that the Apps Script runtime runs the engine and reproduces the contract's golden vectors.

Setup creates two tabs:

- **Inputs:** one row per participant, with columns `name, include, hop0_commit, hop1_commit, hop1_invites, hop2_commit, hop2_invites`.
  - Column B is a yes/no dropdown. Blank means included.
  - Amounts are in dollars.
  - Blank invites mean 1.
  - The sheet has no Self-fill button. A fully self-filled seed is `15000, 12000, 3, 6000, 6`.
  - The live results fill columns I–O, row for row: committed, accepted at each hop, ARM, refund, and that row's issues.
- **Model:** the summary (outcome, sale size, totals), the hop breakdown, and every issue, including invite-supply warnings.

Setup is safe to rerun: it only rewrites headers, formulas and formats, never your input rows. Don't type in columns I–O on the Inputs tab, because the results formula fills them.

You can also paste a scenario CSV exported from the standalone page into the Inputs tab, since the columns are identical.

### The formulas

| Formula | Returns |
|---------|---------|
| `=ARMADA_RESULTS(A2:G)` | Per-participant results, aligned with the input rows |
| `=ARMADA_SUMMARY(Inputs!A2:G)` | Outcome, refund reason, totals, sale size, net proceeds |
| `=ARMADA_HOPS(Inputs!A2:G)` | Hop table: share, committers, committed, capped, effective ceiling, allocated, fill, accepted, rollover |
| `=ARMADA_ISSUES(Inputs!A2:G, 2)` | Every issue, labelled with its sheet row (the `2` is the first data row) |
| `=ARMADA_SELFTEST()` | `OK` when the engine reproduces the golden vectors |

Values are exact to 6 decimals. The setup formats show at least 2 and up to 6 decimals, and Sheets rounds half-up for display.

### Updating the sheet's code

After any change to the engine or `sheet/sheet-functions.js`, regenerate the file with `npm run crowdfund-model:build-sheet`. Then paste the new `sheet/Code.gs` into the sheet's Apps Script editor and rerun the self-test.

A test fails if the committed `Code.gs` is out of date with its sources.

## How it matches the contract

The page has three script blocks:

| Block | What it does |
|-------|--------------|
| `crowdfund-model-engine` | BigInt port of the contract's `finalize()` and the internal functions it calls, plus `computeAllocation()`, with the mainnet constants. |
| `crowdfund-model-scenario` | Parsing, formatting, validation, self-fill and CSV. No DOM access. |
| `crowdfund-model-ui` | Rendering only. |

The tests extract the first two blocks from the HTML and run them directly. `sheet/Code.gs` is generated from those same two blocks plus `sheet/sheet-functions.js`. Either way, the tested code is the shipped code:

- `npm run test:crowdfund-model`: no chains needed. Covers:
  - unit tests for the engine and scenario helpers;
  - jsdom end-to-end tests of the page;
  - tests of the generated `sheet/Code.gs` itself, with sheet-shaped inputs and a recording stand-in for Google's spreadsheet API, plus a check that the committed file is up to date.
  - a syntax check of `Code.gs` with Esprima, the parser the Apps Script editor uses on save. The editor rejects BigInt literals like `1000000n`, so the build rewrites them as `BigInt('1000000')`.
- `test/crowdfund_model_parity.ts` (part of `npm run test:all`):
  - asserts every constant the model uses against the compiled contract;
  - builds curated and seeded-random scenarios on-chain (seeds, self-invites, stacked and launch-team invites, commits) and finalizes them;
  - checks that the sale size, refund mode, hop ceilings and demands, treasury proceeds, and every participant's per-hop ARM and refund match the model exactly.

If the crowdfund contract's constants or allocation math change, update the engine block and rerun both suites. The parity test fails until the two agree again.

### Known modeling limits

- **Rounding buffer:** on-chain, the treasury rounding buffer counts every invited node, including ones that never commit. The model counts only committing nodes. The difference is at most $0.0018.
- **Invite supply:** the invite-supply warnings only see listed participants. Unlisted seeds or hop-1 nodes could supply more invites.
