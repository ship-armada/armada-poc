# Reusable Components Documentation

This document describes the reusable components available in the `src/components/common/` directory for common UI patterns.

## ExplorerLink

A reusable component for external explorer links with consistent styling and accessibility.

### Props

```typescript
interface ExplorerLinkProps {
  url: string                    // Required: The URL to open
  label?: string                 // Optional: ARIA label (defaults to "Open in explorer")
  children?: React.ReactNode      // Optional: Link content (defaults to showing icon only)
  className?: string              // Optional: Additional CSS classes
  size?: 'sm' | 'md' | 'lg'      // Optional: Icon size (default: 'md')
  iconOnly?: boolean             // Optional: Hide underline when true (default: false)
  onClick?: (e: MouseEvent) => void // Optional: Click handler
}
```

### Usage

```tsx
// Basic usage
<ExplorerLink url={explorerUrl}>View on Explorer</ExplorerLink>

// With custom content
<ExplorerLink url={txHashUrl} size="sm">
  {formatHash(txHash)}
</ExplorerLink>

// Icon only (no underline)
<ExplorerLink url={explorerUrl} iconOnly size="sm" />

// Styled as button
<ExplorerLink
  url={explorerUrl}
  className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80 px-4 py-2 text-sm font-medium"
>
  View on Explorer
</ExplorerLink>
```

### Features

- Always includes `target="_blank" rel="noopener noreferrer"` for security
- Uses `ExternalLink` icon from lucide-react
- Default styling: `text-info hover:text-info/80 underline flex items-center gap-1`
- Icon sizes: sm (h-3 w-3), md (h-3.5 w-3.5), lg (h-4 w-4)
- Automatic dark mode support via theme variables

## CopyButton

A reusable copy-to-clipboard button component with success state feedback.

### Props

```typescript
interface CopyButtonProps {
  text: string                    // Required: Text to copy to clipboard
  label?: string                  // Optional: Label for toast notification
  onCopy?: () => void             // Optional: Callback after successful copy
  size?: 'sm' | 'md' | 'lg'       // Optional: Icon size (default: 'md')
  className?: string              // Optional: Additional CSS classes
  showSuccessState?: boolean      // Optional: Show check icon after copy (default: true)
  successDuration?: number        // Optional: Duration to show success state in ms (default: 2000)
}
```

### Usage

```tsx
// Basic usage
<CopyButton text={address} label="Address" />

// Small size
<CopyButton text={txHash} size="sm" />

// With custom callback
<CopyButton
  text={value}
  label="Value"
  onCopy={() => console.log('Copied!')}
/>

// Without success state
<CopyButton
  text={value}
  showSuccessState={false}
/>
```

### Features

- Handles clipboard write internally
- Shows success state (Check icon) temporarily after copy
- Displays toast notification (unless `onCopy` callback is provided)
- Default styling: `p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors rounded flex-shrink-0`
- Icon sizes: sm (h-3 w-3), md (h-3.5 w-3.5), lg (h-4 w-4)
- Automatic dark mode support

## AddressDisplay

A component for displaying addresses/hashes with copy and explorer actions.

### Props

```typescript
interface AddressDisplayProps {
  value: string                   // Required: The address/hash to display
  explorerUrl?: string            // Optional: URL for explorer link
  label?: string                  // Optional: Label for copy/explorer actions
  format?: 'short' | 'medium' | 'full' // Optional: Format style (default: 'short')
  showCopy?: boolean              // Optional: Show copy button (default: true)
  showExplorer?: boolean          // Optional: Show explorer link (default: true)
  className?: string              // Optional: Additional CSS classes
  copyLabel?: string              // Optional: Custom label for copy button
  explorerLabel?: string          // Optional: Custom label for explorer link
  size?: 'sm' | 'md' | 'lg'       // Optional: Size for buttons and text (default: 'md')
}
```

### Format Options

- `short`: `${value.slice(0, 6)}...${value.slice(-4)}` (e.g., `0x1234...5678`)
- `medium`: `${value.slice(0, 10)}...${value.slice(-8)}` (e.g., `0x12345678...90abcdef`)
- `full`: Shows the complete value

### Usage

```tsx
// Basic usage
<AddressDisplay
  value={address}
  explorerUrl={explorerUrl}
  label="Address"
/>

// Medium format, no explorer
<AddressDisplay
  value={txHash}
  format="medium"
  showExplorer={false}
/>

// Custom labels
<AddressDisplay
  value={address}
  explorerUrl={explorerUrl}
  copyLabel="Copy address"
  explorerLabel="View in block explorer"
/>
```

### Features

- Formats address/hash based on `format` prop
- Includes copy button and optional explorer link
- Uses `font-mono` for value display
- Text size adapts to `size` prop (text-xs for sm, text-sm for md/lg)
- Automatic dark mode support

## InfoRow

A component for displaying labeled information with copy and explorer actions, typically used in definition lists.

### Props

```typescript
interface InfoRowProps {
  label: string                    // Required: Label for the row
  value: string                   // Required: Value to display
  explorerUrl?: string            // Optional: URL for explorer link
  onCopy?: () => void             // Optional: Callback after copy (CopyButton handles toast by default)
  className?: string              // Optional: Additional CSS classes
  valueClassName?: string        // Optional: Additional classes for value span
  size?: 'sm' | 'md' | 'lg'       // Optional: Size for buttons and text (default: 'md')
}
```

### Usage

```tsx
// Basic usage
<InfoRow
  label="Sender Address"
  value={formatAddress(senderAddress)}
  explorerUrl={buildExplorerUrl(senderAddress, 'address', 'evm')}
/>

// Without explorer
<InfoRow
  label="Transaction Hash"
  value={formatHash(txHash)}
/>

// Small size
<InfoRow
  label="Address"
  value={address}
  size="sm"
/>
```

### Features

- Uses `dt`/`dd` structure for semantic HTML
- Combines CopyButton and ExplorerLink components
- Label uses `text-muted-foreground`
- Value uses `font-mono`
- Text size adapts to `size` prop
- Automatic dark mode support

## Utility Classes

The following utility classes are available in `src/index.css`:

### `.link-explorer`
Explorer link base styles:
```css
@apply text-info hover:text-info/80 underline flex items-center gap-1;
```

### `.btn-copy`
Copy button base styles:
```css
@apply p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors rounded flex-shrink-0;
```

### `.text-address`
Address/hash text styles (medium):
```css
@apply font-mono text-sm;
```

### `.text-address-sm`
Address/hash text styles (small):
```css
@apply font-mono text-xs;
```

### `.action-group`
Container for action buttons (copy + explorer):
```css
@apply flex items-center gap-1;
```

### `.value-with-actions`
Container for value with action buttons:
```css
@apply flex items-center gap-2;
```

### `.explorer-link-inline`
Inline explorer link (icon only, no underline):
```css
@apply p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors rounded flex-shrink-0;
```

## Migration Examples

### Before: Hardcoded Explorer Link

```tsx
<a
  href={explorerUrl}
  target="_blank"
  rel="noopener noreferrer"
  className="text-info hover:text-info/80 underline flex items-center gap-1"
>
  <ExternalLink className="h-3.5 w-3.5" />
  View on Explorer
</a>
```

### After: Using ExplorerLink Component

```tsx
<ExplorerLink url={explorerUrl} size="md">
  View on Explorer
</ExplorerLink>
```

### Before: Hardcoded Copy Button

```tsx
<button
  type="button"
  onClick={async () => {
    await navigator.clipboard.writeText(address)
    notify(buildCopySuccessToast('Address'))
  }}
  className="p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors rounded"
>
  <Copy className="h-3.5 w-3.5" />
</button>
```

### After: Using CopyButton Component

```tsx
<CopyButton text={address} label="Address" size="md" />
```

### Before: Inline Address Display

```tsx
<div className="flex items-center gap-2">
  <span className="font-mono text-sm">{formatAddress(address)}</span>
  <button onClick={() => copy(address)}>
    <Copy className="h-3.5 w-3.5" />
  </button>
  <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
    <ExternalLink className="h-3.5 w-3.5" />
  </a>
</div>
```

### After: Using AddressDisplay Component

```tsx
<AddressDisplay
  value={address}
  explorerUrl={explorerUrl}
  label="Address"
  format="medium"
/>
```

## Best Practices

1. **Use components over utility classes** when you need functionality (copy, navigation)
2. **Use utility classes** for simple styling patterns
3. **Always provide labels** for accessibility
4. **Use appropriate sizes** - `sm` for compact spaces, `md` for normal, `lg` for prominent displays
5. **Leverage format options** in AddressDisplay for different contexts
6. **Combine components** - InfoRow uses CopyButton and ExplorerLink internally

## Accessibility

All components include:
- Proper ARIA labels
- Keyboard navigation support
- Focus states
- Semantic HTML where appropriate

## Theme Integration

All components use theme variables and automatically support:
- Light and dark modes
- Consistent colors across the app
- Easy theme customization
