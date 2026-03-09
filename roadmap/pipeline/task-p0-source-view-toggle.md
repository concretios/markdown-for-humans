# Task: Source View Toggle

## 1. Task Metadata

- **Task name:** Source View Toggle
- **Slug:** source-view-toggle
- **Status:** planned, implementation failed
- **Created:** 2025-11-29
- **Last updated:** 2025-12-01
- **Shipped:** *(pending)*

---

## 2. Context & Problem

**Problem:** Users occasionally need raw markdown access for:
- Debugging complex markdown (frontmatter, edge cases, custom HTML)
- Making precise manual edits (table alignment, special formatting)
- Copying raw markdown for external tools
- Learning/understanding the generated markdown

**Current state:**
- ✅ Toolbar `</>` button exists and opens VS Code's native text editor in split view
- ✅ Works with `ViewColumn.Beside` (side-by-side)
- ❌ **Missing scroll sync** - cursor/scroll position not synced between WYSIWYG and source
- ❌ No status bar indicator
- ❌ No command palette entry for discoverability

**User Intent:** Source view is a **power user/debugging feature**, not a primary editing mode. WYSIWYG remains the default and preferred experience (aligned with "write markdown the way humans think").

---

## 3. Desired Outcome & Scope

**Success criteria (MVP - Complete existing feature):**

- [ ] **Scroll sync** - When scrolling in WYSIWYG, scroll source view to same line (and vice versa)
- [ ] **Cursor sync** - When clicking in WYSIWYG, move source cursor to corresponding line
- [ ] **Command palette entry** - `Markdown for Humans: Open Source View` for discoverability
- [ ] **Status bar indicator** - Show "Split View Active" when source is open
- [ ] Toolbar `</>` button continues to work (already implemented)
- [ ] Source view uses VS Code's native markdown editor (already implemented)
- [ ] Split view layout (already implemented with `ViewColumn.Beside`)

**Out of scope:**

- Full-screen source mode toggle (split view is simpler and more powerful)
- Mode persistence (split view is on-demand, not a persistent state)
- Custom source editor implementation (VS Code's native editor is feature-complete)
- Keyboard shortcuts (users can configure their own via VS Code keybindings)
- Custom syntax highlighting themes (VS Code's native markdown highlighting is excellent)
- Bidirectional content sync (VS Code handles this automatically - both views edit the same document)

---

## 4. UX & Behavior

### Entry Points

**Existing (already implemented):**
- ✅ **Toolbar Button** - `</>` icon titled "Open source view (split)"
  - Opens VS Code's native text editor in split view (`ViewColumn.Beside`)
  - Location: [BubbleMenuView.ts:243-249](src/webview/BubbleMenuView.ts#L243-L249)

**To add:**
- 🔲 **Command Palette** - `Markdown for Humans: Open Source View`
  - Same behavior as toolbar button (open split view)
  - Purpose: Discoverability, keyboard-first users, searchable
  - Why: VS Code users expect features in command palette (searchable, namespaced)

- 🔲 **Status Bar** - "Split View Active" indicator when source is open
  - Purpose: Show user that split view is active
  - Clicking toggles split view on/off (close the source editor)
  - Why: Provides visibility and quick access to close split view

### User Flows

**Flow 1: Open Split View**
1. User clicks toolbar `</>` button or runs command palette action
2. VS Code opens native text editor beside WYSIWYG view (side-by-side)
3. **Scroll sync activates** - scrolling in one view updates the other
4. **Cursor sync activates** - clicking in WYSIWYG moves source cursor to same line
5. User can edit in either view; both edit the same underlying document
6. Status bar shows "Split View Active"

**Flow 2: Edit in Split View**
1. User types in source editor (right pane)
2. Changes auto-save to document (VS Code handles this)
3. WYSIWYG view (left pane) updates automatically on document change
4. Scroll position syncs when user scrolls in either pane

**Flow 3: Close Split View**
1. User closes the source editor tab (standard VS Code close)
2. OR clicks status bar "Split View Active" indicator to close source view
3. Status bar indicator disappears
4. WYSIWYG view remains open

### Behavior Rules

**Scroll Sync (Key Priority):**
- When user scrolls in WYSIWYG, scroll source view to corresponding line
- When user scrolls in source view, scroll WYSIWYG to corresponding block
- Use debouncing (100-200ms) to avoid performance issues
- Sync should feel instant but not cause lag

**Cursor Sync (Key Priority):**
- When user clicks in WYSIWYG editor, move source cursor to same line number
- When user clicks in source editor, scroll WYSIWYG to corresponding block (best-effort)
- Track line number mapping between TipTap editor state and markdown document

**Split View Behavior:**
- Opens in `ViewColumn.Beside` (side-by-side with WYSIWYG)
- Both views edit the same underlying VS Code document (auto-sync)
- Closing source view doesn't affect WYSIWYG view
- Status bar shows "Split View Active" when source is open

**Automatic (VS Code handles):**
- ✅ Undo/redo across both views (VS Code's undo stack)
- ✅ Auto-save works in both views (same document)
- ✅ Syntax highlighting in source view (VS Code's markdown grammar)
- ✅ Read-only behavior (both views respect document state)
- ✅ Git integration (both views edit same file)

---

## 5. Technical Implementation Notes

### Current Architecture (Already Implemented)

**Existing:**
- ✅ Toolbar button dispatches `openSourceView` event ([BubbleMenuView.ts:246](src/webview/BubbleMenuView.ts#L246))
- ✅ Webview posts message to extension ([editor.ts:518](src/webview/editor.ts#L518))
- ✅ Extension opens VS Code text editor with `vscode.openWith` ([MarkdownEditorProvider.ts:134-139](src/editor/MarkdownEditorProvider.ts#L134-L139))
- ✅ Uses `ViewColumn.Beside` for split view
- ✅ Both editors work on same underlying `TextDocument`

**Missing (to implement):**
- ❌ Scroll sync between WYSIWYG and source view
- ❌ Cursor sync (click in WYSIWYG → move source cursor)
- ❌ Command palette entry
- ❌ Status bar indicator

### Implementation Tasks

**1. Scroll Sync (Priority 1)**

Track the open source editor and sync scroll positions:

```typescript
// In MarkdownEditorProvider.ts
private sourceEditorUri: vscode.Uri | null = null;

case 'openSourceView':
  this.sourceEditorUri = document.uri;
  // Open editor...
  // Start listening to scroll events

case 'scrollTo':
  // When WYSIWYG scrolls, get line number from message
  // Find source editor by URI
  // Use vscode.window.visibleTextEditors to find matching editor
  // Call editor.revealRange() to scroll source
```

Listen to source editor scroll:
```typescript
// In extension.ts
vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
  if (isSourceEditorForActiveWYSIWYG(event.textEditor)) {
    // Get visible line range
    // Post message to webview to scroll WYSIWYG
  }
});
```

**2. Cursor Sync (Priority 2)**

```typescript
// In webview - track cursor position in TipTap
editor.on('selectionUpdate', () => {
  const pos = editor.state.selection.$anchor.pos;
  const lineNumber = getLineNumberFromPos(pos); // Map TipTap pos → line
  vscode.postMessage({ type: 'cursorUpdate', line: lineNumber });
});

// In MarkdownEditorProvider.ts
case 'cursorUpdate':
  const sourceEditor = findSourceEditor(document.uri);
  if (sourceEditor) {
    const position = new vscode.Position(message.line, 0);
    sourceEditor.selection = new vscode.Selection(position, position);
    sourceEditor.revealRange(new vscode.Range(position, position));
  }
```

**3. Command Palette Entry**

```typescript
// In extension.ts
vscode.commands.registerCommand('markdown-for-humans.openSourceView', () => {
  // Get active WYSIWYG editor
  // Send 'openSourceView' message to webview
  // Same behavior as toolbar button
});

// In package.json
"commands": [
  {
    "command": "markdown-for-humans.openSourceView",
    "title": "Open Source View",
    "category": "Markdown for Humans"
  }
]
```

**4. Status Bar Indicator**

```typescript
// In extension.ts
const statusBarItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right, 100
);
statusBarItem.text = "$(split-horizontal) Split View Active";
statusBarItem.command = "markdown-for-humans.closeSourceView";
statusBarItem.tooltip = "Click to close source view";

// Show when source opens, hide when closed
// Listen to vscode.window.onDidChangeVisibleTextEditors
```

### Performance Considerations

- **Debounce scroll sync:** 100-200ms to avoid excessive updates
- **Throttle cursor updates:** Only update on selection change, not every keystroke
- **Lazy listeners:** Only register scroll/cursor listeners when split view is active
- **Cleanup:** Remove listeners when split view closes

### Edge Cases

- **Multiple markdown files open:** Track which source editor corresponds to which WYSIWYG
- **User manually closes source tab:** Update status bar, clean up listeners
- **User opens source view multiple times:** Reuse existing source editor or open new split
- **Line mapping edge cases:**
  - Collapsed blocks in WYSIWYG may not have 1:1 line mapping
  - Use best-effort matching (closest line)

### Testing Checklist

- [ ] Toolbar `</>` button opens split view (already works)
- [ ] Command palette entry opens split view
- [ ] Status bar shows "Split View Active" when source is open
- [ ] Scrolling in WYSIWYG scrolls source view to same line
- [ ] Scrolling in source view scrolls WYSIWYG to same block
- [ ] Clicking in WYSIWYG moves source cursor to same line
- [ ] Clicking status bar closes source view
- [ ] Manually closing source tab updates status bar
- [ ] Multiple markdown files don't interfere with each other
- [ ] Performance: scroll sync feels instant (<200ms)

---

## 6. Related Work

**VS Code APIs to leverage:**
- `vscode.workspace.getConfiguration()` - User settings (default mode)
- `context.workspaceState` - Per-file mode persistence
- `vscode.window.createStatusBarItem()` - Status bar indicator
- `vscode.commands.registerCommand()` - Toggle command

**Existing extensions for reference:**
- [vscode-markdown-wysiwyg](https://github.com/zaaack/vscode-markdown-wysiwyg) - Basic source toggle (study their approach)
- [Foam](https://foambubble.github.io/foam/) - Markdown editing patterns

---

## 7. Decisions Made

### Q: Should we add a config option `markdown-for-humans.defaultMode`?
**A:** Not needed. The config would let users choose whether files open in WYSIWYG or source mode by default. Since split view is on-demand (not a persistent mode), this isn't applicable. WYSIWYG is always the default; users open source view when needed.

### Q: Should we support split view in MVP?
**A:** ✅ Yes - already implemented! The toolbar button opens VS Code's native text editor in split view. This is the correct UX (not full-screen toggle).

### Q: Should we use Monaco or custom editor for source editing?
**A:** ✅ Use VS Code's native markdown editor. The existing implementation (`vscode.openWith`) is the right approach:
- Free syntax highlighting (VS Code's markdown grammar)
- Free undo/redo stack
- Free Git integration
- No custom editor code to maintain
- Users get familiar VS Code editing experience

### Q: Should we sync scroll position?
**A:** ✅ Yes - **key priority** for this task. Scroll sync is essential for split view to be usable. Without it, users lose context when switching between views.
