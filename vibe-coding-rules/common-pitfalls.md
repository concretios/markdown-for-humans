# Common Pitfalls to Avoid

> Known issues and their solutions.
> Index: See `AGENTS.md` for canonical instructions.

---

## 1. Feedback Loops in Document Sync

**Problem:** Update from extension → triggers webview update → triggers extension update → infinite loop

**Solution:**
- Set `ignoreNextUpdate` flag when applying edits
- Check `lastEditTimestamp` before updating from external changes
- Skip updates if content unchanged (string comparison)
- Always bypass content deduplication for the webview `ready` handshake. The
  optimistic startup post can run before the webview installs its listener,
  and even an empty document needs an `update` payload to initialize TipTap.

**See:** `[Project Root]/docs/ARCHITECTURE.md#document-synchronization`

---

## 2. Breaking Cursor Position

**Problem:** Updating editor content resets cursor to start of document

**Solution:**
```typescript
// Save cursor position
const selection = editor.state.selection;

// Update content
editor.commands.setContent(newContent);

// Restore cursor (best effort)
try {
  editor.commands.setTextSelection(selection);
} catch (e) {
  // Position invalid after update, ignore
}
```

---

## 3. Performance Degradation with Large Docs

**Problem:** Editor becomes sluggish with 5000+ line documents

**Current solutions:**
- 500ms debounce on updates
- Skip redundant updates
- Respect user editing state

**Future solutions (if needed):**
- Virtual scrolling (only render visible content)
- Lazy loading (images, diagrams)
- Web Workers (background parsing)

---

## 4. Mermaid Rendering Errors

**Problem:** Invalid mermaid syntax breaks rendering

**Solution:**
```typescript
try {
  const { svg } = await mermaid.render(id, code);
  element.innerHTML = svg;
} catch (error) {
  element.innerHTML = `
    <div class="mermaid-error">
      Failed to render diagram. <a href="#" onclick="showCode()">View code</a>
    </div>
  `;
}
```

Always provide fallback UI with error message and code view option.

---

## 5. Theme Conflicts

**Problem:** Hard-coded colors break in dark/light themes

**Solution:**
```css
/* ✅ Good - Uses VS Code theme variables */
.editor {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
}

/* ❌ Bad - Hard-coded colors */
.editor {
  background: #ffffff;
  color: #000000;
}
```

Always use CSS variables for colors that should adapt to themes.

**See:** `[Project Root]/vibe-coding-rules/styling.md` for comprehensive styling guidelines.
