# Theme System Documentation

This document describes the theme system used in the USDC v2 Frontend application, built with Tailwind CSS v4 and semantic color tokens.

## Overview

The theme system uses CSS custom properties (CSS variables) defined in `src/index.css` and exposed through Tailwind v4's `@theme` directive. This approach provides:

- **Consistency**: All components use the same design tokens
- **Maintainability**: Colors are defined in one place
- **Dark Mode Support**: Automatic dark mode variants
- **Type Safety**: Tailwind generates utility classes automatically

## Theme Variables

### Base Color Tokens

All colors are defined using the OKLCH color space for better perceptual uniformity and color manipulation.

#### Semantic Colors

- **`--success`**: Used for success states, completed actions, positive feedback
  - Light: `oklch(0.72 0.15 150)`
  - Dark: `oklch(0.65 0.15 150)`
  - Utilities: `bg-success`, `text-success`, `border-success`

- **`--error`**: Used for error states, destructive actions, failures
  - Light: `oklch(0.577 0.245 27.325)` (same as destructive)
  - Dark: `oklch(0.704 0.191 22.216)`
  - Utilities: `bg-error`, `text-error`, `border-error`

- **`--warning`**: Used for warnings, caution states, pending actions
  - Light: `oklch(0.75 0.15 80)`
  - Dark: `oklch(0.7 0.15 80)`
  - Utilities: `bg-warning`, `text-warning`, `border-warning`

- **`--info`**: Used for informational messages, neutral status indicators
  - Light: `oklch(0.6 0.15 240)`
  - Dark: `oklch(0.55 0.15 240)`
  - Utilities: `bg-info`, `text-info`, `border-info`

- **`--overlay`**: Used for modal backdrops and overlays
  - Light: `oklch(0 0 0 / 0.6)`
  - Dark: `oklch(0 0 0 / 0.7)`
  - Utilities: `bg-overlay`

#### Foreground Colors

Each semantic color has a corresponding foreground color for text on colored backgrounds:

- `--success-foreground`: Text on success backgrounds
- `--error-foreground`: Text on error backgrounds
- `--warning-foreground`: Text on warning backgrounds
- `--info-foreground`: Text on info backgrounds

#### Shadcn UI Colors

The theme also includes standard Shadcn UI color tokens:

- `--background`, `--foreground`: Base background and text colors
- `--card`, `--card-foreground`: Card backgrounds and text
- `--primary`, `--primary-foreground`: Primary action colors
- `--secondary`, `--secondary-foreground`: Secondary action colors
- `--muted`, `--muted-foreground`: Muted/subdued colors
- `--accent`, `--accent-foreground`: Accent colors
- `--destructive`: Destructive action color (same as error)
- `--border`: Border color
- `--input`: Input field background
- `--ring`: Focus ring color

## Usage Guidelines

### When to Use Semantic Colors

**Use `success` for:**
- Completed transactions
- Successful operations
- Positive status indicators
- Confirmation messages

**Use `error` for:**
- Failed transactions
- Error messages
- Destructive actions
- Critical warnings

**Use `warning` for:**
- Pending states
- Caution messages
- Unregistered addresses
- Timeout warnings

**Use `info` for:**
- Informational messages
- Neutral status indicators
- Progress indicators
- Help text

**Use `overlay` for:**
- Modal backdrops
- Dialog overlays
- Loading overlays

### Examples

#### Status Badges

```tsx
// Success badge
<span className="bg-success/10 border border-success/30 text-success px-2.5 py-0.5 rounded-full">
  Registered
</span>

// Error badge
<span className="bg-error/10 border border-error/30 text-error px-2.5 py-0.5 rounded-full">
  Failed
</span>

// Warning badge
<span className="bg-warning/10 border border-warning/30 text-warning px-2.5 py-0.5 rounded-full">
  Pending
</span>
```

#### Buttons

```tsx
// Error button (destructive action)
<button className="bg-error hover:bg-error/90 text-error-foreground">
  Delete
</button>

// Warning button
<button className="bg-warning hover:bg-warning/90 text-warning-foreground">
  Invalidate
</button>
```

#### Status Icons

```tsx
// Success icon
<CheckCircle2 className="h-5 w-5 text-success" />

// Error icon
<XCircle className="h-5 w-5 text-error" />

// Info icon
<Info className="h-5 w-5 text-info" />
```

#### Overlays

```tsx
// Modal backdrop
<div className="absolute inset-0 bg-overlay backdrop-blur-sm" />
```

### Opacity Modifiers

Use Tailwind's opacity modifiers for subtle backgrounds:

```tsx
// Subtle success background
<div className="bg-success/10 border border-success/20">
  Success message
</div>

// More prominent error background
<div className="bg-error/20 border border-error/30">
  Error message
</div>
```

### Migration from Hardcoded Colors

**Before:**
```tsx
<div className="bg-red-100 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400">
  Error message
</div>
```

**After:**
```tsx
<div className="bg-error/10 border border-error/30 text-error">
  Error message
</div>
```

## Dark Mode

Dark mode is automatically handled through the `.dark` class selector. All semantic colors have corresponding dark mode values defined in the `.dark` block in `src/index.css`.

The theme system uses Tailwind's `@custom-variant dark` directive to enable dark mode support:

```css
@custom-variant dark (&:is(.dark *));
```

To toggle dark mode, add or remove the `dark` class on the root element (typically `<html>` or `<body>`).

## Adding New Theme Variables

To add a new semantic color:

1. **Add to `:root` block:**
   ```css
   :root {
     --new-color: oklch(0.7 0.15 180);
     --new-color-foreground: oklch(0.98 0 0);
   }
   ```

2. **Add dark mode variant:**
   ```css
   .dark {
     --new-color: oklch(0.65 0.15 180);
   }
   ```

3. **Add to `@theme inline` block:**
   ```css
   @theme inline {
     --color-new-color: var(--new-color);
     --color-new-color-foreground: var(--new-color-foreground);
   }
   ```

4. **Use in components:**
   ```tsx
   <div className="bg-new-color text-new-color-foreground">
     Content
   </div>
   ```

## Best Practices

1. **Always use semantic tokens** instead of hardcoded color values
2. **Use foreground variants** for text on colored backgrounds
3. **Leverage opacity modifiers** (`/10`, `/20`, `/30`) for subtle backgrounds
4. **Maintain consistency** - use the same semantic color for the same meaning across the app
5. **Test in both light and dark modes** to ensure proper contrast

## Troubleshooting

### Colors not appearing

- Ensure the color is defined in both `:root` and `@theme inline` blocks
- Check that Tailwind is processing the CSS file
- Verify the utility class name matches the theme variable (e.g., `--color-success` → `bg-success`)

### Dark mode not working

- Ensure the `.dark` class is applied to the root element
- Check that dark mode values are defined in the `.dark` block
- Verify the `@custom-variant dark` directive is present

### Opacity modifiers not working

- Ensure you're using the correct syntax: `bg-success/10` not `bg-success-10`
- Check that the base color token exists

## References

- [Tailwind CSS v4 Theme Variables](https://tailwindcss.com/docs/theme)
- [Shadcn UI Theming](https://ui.shadcn.com/docs/theming)
- [OKLCH Color Space](https://oklch.com/)
