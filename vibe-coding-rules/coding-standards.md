# Coding Standards

> TypeScript style, **code documentation**, and file organization guidelines.
> Documentation is auto-updated with every code change.
> Index: See `AGENTS.md` for canonical instructions.

---

## TypeScript

**Style:**
```typescript
// ✅ Good - Clear types, meaningful names
function updateDocument(content: string, preserveCursor: boolean): void {
  const editor = getEditor();
  if (preserveCursor) {
    const selection = editor.state.selection;
    editor.commands.setContent(content);
    editor.commands.setTextSelection(selection);
  }
}

// ❌ Bad - Any types, cryptic names
function updateDoc(c: any, p: any) {
  const e = getEd();
  if (p) {
    const s = e.state.sel;
    e.cmds.setCont(c);
  }
}
```

**Rules:**
- Use TypeScript strict mode (enabled in tsconfig)
- Prefer `const` over `let`, never `var`
- Add types for function parameters and returns
- Meaningful variable names (no `x`, `temp`, `data`)
- Private members prefixed with `_`

---

## Code Documentation

**Philosophy:** Document intent and contracts, not implementation details. Keep docs close to code so they stay in sync.

### Documentation Levels

| Level | What | When |
|-------|------|------|
| **File-level** | Purpose, key exports | Every `.ts` file with 3+ exports or complex logic |
| **Class/Interface** | Responsibility, usage | All exported classes/interfaces |
| **Function/Method** | Contract (params, returns, throws) | All exported + complex internal functions |
| **Inline** | WHY, not WHAT | Non-obvious decisions, edge cases, gotchas |

### File-Level Header (Required for key files)

```typescript
/**
 * @file editor.ts - TipTap editor setup and VS Code bridge
 * @description Initializes the WYSIWYG editor, handles message passing
 *              between webview and extension host.
 *
 * Key responsibilities:
 * - Editor initialization with extensions
 * - Content sync (webview ↔ VS Code document)
 * - Toolbar state management
 */
```

### Function Documentation (JSDoc)

```typescript
/**
 * Updates the webview editor content from the VS Code document.
 * Implements debounced sync to avoid feedback loops.
 *
 * @param document - Source VS Code document
 * @param webview - Target webview to update
 * @returns void
 * @throws Never - errors are caught and logged
 */
export function updateWebview(document: TextDocument, webview: Webview): void {
```

### Inline Comments

**When to comment:**
- Explain **WHY**, not **WHAT**
- Warn about gotchas and edge cases
- Reference GitHub issues for workarounds
- Mark TODO/FIXME with ticket reference

```typescript
// ✅ Good - Explains WHY
// Debounce updates to avoid excessive sync overhead.
// 500ms balances responsiveness with performance. See #42.
const DEBOUNCE_DELAY = 500;

// ✅ Good - Warns about gotcha
// GOTCHA: Must update selection AFTER content, or cursor jumps to start
editor.commands.setContent(content);
editor.commands.setTextSelection(savedSelection);

// ❌ Bad - Explains WHAT (obvious from code)
// Set debounce delay to 500
const DEBOUNCE_DELAY = 500;
```

### File-Type Specific Rules

| File Type | Documentation Requirements |
|-----------|---------------------------|
| `*.ts` (extension) | File header, JSDoc for exports, inline for sync logic |
| `*.ts` (webview) | File header, JSDoc for message handlers, inline for DOM manipulation |
| `*.css` | Section comments, variable groupings |
| `*.json` (package.json) | Commands/config have descriptions in manifest |
| `*.md` (docs) | Keep in sync with code via cross-references |
| `*/__tests__/*.ts` | Describe blocks explain test scenarios, not implementation |

### Auto-Update Discipline

**When modifying code, always:**
1. **Update adjacent docs**: If you change a function, update its JSDoc
2. **Update file header**: If you add/remove key exports
3. **Remove stale comments**: Delete comments that no longer apply
4. **Add migration notes**: For breaking changes, add `@deprecated` or `@since`

```typescript
/**
 * @deprecated Use `updateWebview()` instead. Will be removed in v2.0.
 * @see updateWebview
 */
export function syncContent() { /* ... */ }
```

---

## File Organization

**Naming:**
- Variables/Functions: `camelCase`
- Classes/Interfaces: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Files: `PascalCase.ts` for classes, `camelCase.ts` for utilities

**Structure & source layout:**
- See `[Project Root]/vibe-coding-rules/env-context.md` for the up-to-date `src/` tree.
- Update that file when you add or move top-level modules.

---

## Markdown Documentation

**When updating code:**
- Check update triggers table in AGENTS.md
- Verify file references in affected docs (grep for `src/` paths, verify they exist)
- Update code examples if patterns changed
- Move plan to `roadmap/shipped/` when shipping

**File reference format:** Use backticks: `` `src/webview/editor.ts` ``
**Keep it current:** If you change a file path, update docs that reference it

---

## Error Handling Requirements

**Rule:** All async operations and critical operations must have error handling

### Pattern for Critical Operations

Critical operations are those that affect user data or core functionality (save, applyEdit, file operations):

```typescript
// ✅ Good - User-facing errors for critical operations
private async applyEdit(content: string, document: vscode.TextDocument): Promise<boolean> {
  try {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, content);
    const success = await vscode.workspace.applyEdit(edit);
    
    if (!success) {
      vscode.window.showErrorMessage(
        'Failed to save changes. The file may be read-only or locked.'
      );
      console.error('[MD4H] applyEdit failed:', { uri: document.uri.toString() });
    }
    return success;
  } catch (error) {
    const message = error instanceof Error 
      ? `Failed to save: ${error.message}`
      : 'Failed to save: Unknown error';
    vscode.window.showErrorMessage(message);
    console.error('[MD4H] applyEdit exception:', error);
    return false;
  }
}
```

### Pattern for Non-Critical Operations

Non-critical operations (UI updates, logging, optional features) should log errors but not interrupt user workflow:

```typescript
// ✅ Good - Log errors for non-critical operations
async function updateToolbarState() {
  try {
    await fetchToolbarData();
  } catch (error) {
    console.error('[MD4H] Failed to update toolbar:', error);
    // Continue without toolbar update - not critical
  }
}
```

### Error Handling Checklist

- [ ] All `async` functions have try/catch
- [ ] Critical operations (save, applyEdit, file I/O) show user-facing errors via `vscode.window.showErrorMessage()`
- [ ] Non-critical errors are logged only (no user interruption)
- [ ] Error messages are user-friendly (no stack traces, explain what went wrong)
- [ ] Technical details logged with `console.error()` for debugging
- [ ] Error messages provide actionable next steps when possible

### When to Show User Errors

| Operation Type | Show Error? | Example |
|----------------|-------------|---------|
| Save/applyEdit | Yes | "Failed to save changes. The file may be read-only." |
| File I/O | Yes | "Failed to export document. Check file permissions." |
| Image loading | Maybe | Show if blocking, log if non-blocking |
| Toolbar update | No | Log only |
| Analytics/logging | No | Log only |

See also: `vibe-coding-rules/ux-principles.md` for user-facing error message guidelines.

---

## Code Review Checklist

**Code:** TypeScript strict, no `any`, meaningful names, no hardcoded values, error handling, logging, linter passes

**Docs:** File header updated, JSDoc current, stale comments removed, inline comments explain WHY, TODO/FIXME has ticket
