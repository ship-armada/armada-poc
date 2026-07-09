# Typography composites (`@armada/ui`)

Composite text styles from Figma / Token Studio live in `src/tokens/armada-tokens.json` under `semantic.typography`. They are **not** hand-copied into component CSS.

## Regenerating CSS

From the monorepo root:

```bash
npm run tokens:typography --workspace=@armada/ui
```

This writes:

- `src/styles/typography.css` — `:root` variables + `.armada-text-*` utility classes
- `src/typography/variants.ts` — `TypographyVariant` union + `typographyClassName()`

`tokens.css` imports `typography.css`, so apps that `@import "@armada/ui/styles/tokens.css"` get composites automatically.

## Using composites in code

**Preferred — React primitive:**

```tsx
import { HeadingSm, Text } from '@armada/ui'

<HeadingSm>Step title</HeadingSm>
<Text variant="body-lg">Body copy</Text>
```

**CSS utility (no React):**

```css
.myLabel {
  composes: armada-text-ui-label-sm from global;
}
```

Or add the global class in JSX: `className="armada-text-ui-body-sm"`.

**CSS variables (custom layout):**

```css
.custom {
  font-size: var(--semantic-typography-ui-heading-sm-font-size);
  line-height: var(--semantic-typography-ui-heading-sm-line-height);
}
```

## UI composites (reference)

| Composite | Size | Line height | Weight | Typical use |
|-----------|------|-------------|--------|----------------|
| `ui/heading-lg` | **20px** (`fontSize-xl`) | 120% | Medium | Card titles |
| `ui/heading-sm` | **17px** (`fontSize-lg`) | **24px** (`spacing.6`) | Medium | Step titles, subheadings |
| `ui/body-lg` | 15px | 140% | Regular | Primary body |
| `ui/body-sm` | 13px | 140% | Regular | Captions |
| `ui/label-md` | 12px | 100% | Medium | UI labels |
| `ui/button` | 14px | 100% | Medium | Button labels (see button tokens too) |

Display and mono composites are also generated — see `armada-tokens.json` → `semantic.typography`.

## Editing a composite

1. Change `src/tokens/armada-tokens.json` (e.g. `semantic.typography.ui.heading-sm`).
2. Run `npm run tokens:typography --workspace=@armada/ui`.
3. Commit both the JSON and generated files.

Do **not** edit `typography.css` or `variants.ts` by hand.
