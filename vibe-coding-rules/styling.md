# Styling Guidelines

> CSS styling, visual feedback, and Apple-like polish principles.
> Index: See `AGENTS.md` for canonical instructions.

**Load this guide when:** Working on CSS, visual feedback, hover states, focus indicators, or theme-aware styling.

---

## Core Principles

1. **Theme-Aware First** - Always use VS Code CSS variables, never hard-coded colors
2. **Subtlety Over Flash** - Apple-like polish means clear but unobtrusive feedback
3. **State Hierarchy** - Understand CSS specificity and state priority
4. **Smooth Transitions** - 0.15s ease transitions for state changes
5. **Test in All Themes** - Light, dark, high-contrast dark, and high-contrast light must all work

---

## Theme-Aware Styling

### CSS Variables (Always Use These)

```css
/* ✅ Good - Theme-aware colors */
.element {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  border: 1px solid var(--vscode-editorWidget-border);
}

/* ❌ Bad - Hard-coded colors */
.element {
  background: #ffffff;
  color: #000000;
  border: 1px solid #ccc;
}
```

### Common VS Code CSS Variables

| Variable | Purpose |
|----------|---------|
| `--vscode-editor-background` | Main background |
| `--vscode-editor-foreground` | Main text |
| `--vscode-focusBorder` | Focus indicators |
| `--vscode-editorWidget-border` | Widget borders |
| `--vscode-list-hoverBackground` | Hover states |
| `--vscode-button-background` | Buttons |
| `--vscode-descriptionForeground` | Muted text |
| `--vscode-errorForeground` | Errors |

### Theme Detection

```css
/* Base colors follow whichever theme is active. */
.element {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
}

/* Both high-contrast kinds may need stronger boundaries. */
.vscode-high-contrast .element,
.vscode-high-contrast-light .element {
  border-color: var(--vscode-contrastBorder);
}
```

Prefer shared variable-based styles. Use theme classes for deliberate visual
differences, such as contrast boundaries, without assuming a high-contrast theme
has a dark background.

### Code Blocks and Syntax Tokens

`package.json` contributes eight `markdownForHumans.code*` color IDs: `codeKeyword`,
`codeString`, `codeValue`, `codeFunction`, `codeType`, `codeComment`, `codeAddition`
and `codeDeletion`. Their defaults cover all four theme kinds. Theme authors and
users can override these IDs through `workbench.colorCustomizations`.

```css
.code-block-highlighted [data-highlight-scope~="keyword"] {
  color: var(--vscode-markdownForHumans-codeKeyword, var(--vscode-editor-foreground));
}
```

Keep palette defaults in the manifest and consume the generated variables in CSS.
Token classes retain flattened ancestor scopes for diagnostics; color selectors
use `data-highlight-scope` so an ancestor string, parameter or tag cannot override
the innermost token. Weight and emphasis can still inherit across those scopes.
VS Code does not expose arbitrary TextMate token colors as webview CSS variables;
these contributed defaults do not promise exact native-editor token-theme parity.
Both high-contrast defaults use `editor.foreground`, with bold keywords/titles and
italic comments for additional cues. Punctuation uses the editor foreground.

Keep code surface, font and border styles separate from token classes. In
`editor.css`, `.code-block-wrapper > pre` owns the margin and 48 px copy-button
clearance; `.code-block-highlighted` must not change geometry when colors arrive.
The fallback status belongs below the block in normal flow, outside `contentDOM`,
and remains hidden until needed. Neither fallback explanations nor copy feedback
may enter copied or serialized code.

`codeHighlightAppearance.test.ts` checks palette contrast against reference theme
backgrounds, layout independence and status visibility. Native VS Code checks must
also verify actual computed colors, color overrides, copy controls and 100/150/200%
zoom in all four theme kinds. Reference-color tests alone do not establish contrast
for every installed theme.

---

## Visual Feedback Patterns

### State Hierarchy (Priority Order)

When multiple states can apply, use this priority:

1. **Error/Warning** (highest) - `image-pending-delete`, error states
2. **Selected** - `ProseMirror-selectednode`, `image-caret-selected`
3. **Cursor-based** - `image-caret-before`, `image-caret-after`
4. **Hover** - `:hover` (only when no higher state)
5. **Default** (lowest) - Base state

### Conditional Hover States

**Problem:** Hover can conflict with cursor-based states

**Solution:** Use `:not()` selectors to make hover conditional

```css
/* ✅ Good - Hover only when no cursor state */
.image-wrapper:not(.image-caret-before):not(.image-caret-after):not(.image-caret-selected) .markdown-image:hover {
  /* Hover styles */
}

/* ❌ Bad - Hover always applies, conflicts with cursor states */
.markdown-image:hover {
  /* Hover styles */
}
```

### One-Sided Visual Feedback

When cursor is on one side of an element (e.g., image), show feedback only on that side:

```css
/* Cursor left - only left border and glow */
.image-wrapper.image-caret-before .markdown-image {
  outline: none;  /* Remove full outline */
  border-left: 2px solid var(--md-focus);
  border-right: none;
  border-top: none;
  border-bottom: none;
  box-shadow: 
    -10px 0 20px rgba(0, 122, 204, 0.6),  /* Left glow only */
    -5px 0 10px rgba(0, 122, 204, 0.4);
}

/* Cursor right - only right border and glow */
.image-wrapper.image-caret-after .markdown-image {
  outline: none;
  border-right: 2px solid var(--md-focus);
  border-left: none;
  border-top: none;
  border-bottom: none;
  box-shadow: 
    10px 0 20px rgba(0, 122, 204, 0.6),  /* Right glow only */
    5px 0 10px rgba(0, 122, 204, 0.4);
}
```

**Key points:**
- Remove redundant borders (outline + border + base border in box-shadow)
- Use directional glows (negative X for left, positive X for right)
- Explicitly set other borders to `none` for clarity

---

## Glow Effects

### Apple-Like Subtlety

Glows should be visible but not distracting:

```css
/* Light theme - subtle glows */
.element {
  box-shadow: 
    0 0 0 2px var(--md-focus),           /* Base border */
    0 0 12px rgba(0, 122, 204, 0.4),      /* Soft glow */
    0 0 24px rgba(0, 122, 204, 0.2);      /* Outer glow */
}

/* Dark theme - brighter glows for visibility */
.vscode-dark .element {
  box-shadow: 
    0 0 0 2px var(--md-focus),
    0 0 16px rgba(100, 200, 255, 0.6),    /* Brighter for dark */
    0 0 32px rgba(100, 200, 255, 0.3);
}
```

### Glow Guidelines

- Light: opacity 0.4-0.6, softer colors
- Dark: opacity 0.6-0.8, brighter colors  
- Blur: 10-12px inner, 20-24px outer
- Directional: negative X (left), positive X (right)

---

## Borders and Outlines

### When to Use Each

| Property | Use Case | Notes |
|----------|----------|-------|
| `border` | Structural borders | Part of layout, always visible |
| `outline` | Focus indicators | Temporary, doesn't affect layout |
| `box-shadow` | Glows, depth | Can create borders with `0 0 0 2px` |

### Avoid Redundancy

```css
/* ❌ Bad - Redundant borders */
.element {
  outline: 2px solid var(--md-focus);
  border: 2px solid var(--md-focus);
  box-shadow: 0 0 0 2px var(--md-focus);  /* Another border! */
}

/* ✅ Good - Single border method */
.element {
  outline: 2px solid var(--md-focus);
  outline-offset: 2px;
  /* Or use border, or box-shadow - pick one */
}
```

---

## Transitions

### Standard Timing

```css
/* Standard transition for state changes */
.element {
  transition: box-shadow 0.15s ease, border 0.15s ease, outline 0.15s ease;
}

/* Faster for hover (more responsive) */
.element:hover {
  transition: box-shadow 0.1s ease;
}
```

### Respect Reduced Motion

```css
/* Animation */
@keyframes pulse {
  /* ... */
}

.element {
  animation: pulse 0.25s ease-out;
}

/* Disable for users who prefer reduced motion */
@media (prefers-reduced-motion: reduce) {
  .element {
    animation: none;
  }
}
```

---

## CSS Specificity and Cascade

### Specificity Order

1. **Inline styles** (highest) - Avoid unless necessary
2. **IDs** - Use sparingly, prefer classes
3. **Classes, attributes, pseudo-classes** - Primary method
4. **Elements, pseudo-elements** (lowest)

### Best Practices

```css
/* ✅ Good - Specific but not overly complex */
.image-wrapper.image-caret-before .markdown-image {
  /* Styles */
}

/* ❌ Bad - Too specific, hard to override */
div.image-wrapper.image-caret-before img.markdown-image {
  /* Styles */
}

/* ❌ Bad - Too generic, conflicts with other rules */
.markdown-image {
  /* Styles that might conflict */
}
```

### State Management with :not()

Use `:not()` to create conditional styles:

```css
/* Apply only when NOT in certain states */
.element:not(.state-a):not(.state-b):hover {
  /* Hover only when not in state-a or state-b */
}
```

---

## Common Patterns

### Focus Indicators

```css
/* Standard focus indicator */
.button:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 2px;
}

/* Remove default outline, add custom */
.button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--vscode-focusBorder);
}
```

### Active States

```css
/* Button active (pressed) */
.button:active {
  transform: scale(0.98);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}
```

### Hover with Icon Reveal

```css
/* Hide icon by default */
.icon {
  display: none;
  opacity: 0;
}

/* Show on hover */
.wrapper:hover .icon {
  display: flex;
  opacity: 1;
  transition: opacity 0.2s ease;
}
```

---

## Testing Checklist

- [ ] All four themes (light/dark/high-contrast dark/high-contrast light) - colors visible
- [ ] All states (hover/focus/active/selected) - no conflicts
- [ ] Transitions smooth, reduced motion respected
- [ ] No redundant borders/outlines
- [ ] CSS variables only (no hard-coded colors)
- [ ] Manual read test (3000+ words, 10+ minutes)

---

## File Organization

**File:** `src/webview/editor.css`

**Structure:**
- Group related styles, use section comments
- Keep theme overrides near base styles
- Document complex selectors inline

---
