# Environment Context – VS Code Extension

> **Distilled technical context** for LLMs implementing features in `markdown-for-humans`.
>
> This file is intentionally lean (~80 lines). For deep dives, see `docs/ARCHITECTURE.md`.
>
> **Maintenance rule:** Update this file when architecture changes. Keep it brief—essentials only.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                VS Code Extension Host (Node.js)             │
│                                                             │
│   MarkdownEditorProvider (CustomTextEditorProvider)         │
│   • Registers custom editor for .md files                   │
│   • Manages webview lifecycle                               │
│   • Handles two-way document sync                           │
│                                                             │
│   TextDocument ◄──────────────────► WebviewPanel            │
│   (Source of truth)                 (Visual editor)         │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────▼───────────────┐
              │    WebView Context (Browser)  │
              │                               │
              │    TipTap Editor (ProseMirror)│
              │    • StarterKit (formatting)  │
              │    • Markdown (serialization) │
              │    • Tables, TaskList, Link   │
              │    • Custom: Mermaid, Image   │
              │                               │
              │    BubbleMenuView (toolbar)   │
              └───────────────────────────────┘
```

---

## Source of Truth

**TextDocument is canonical.** The webview renders it; edits flow back to update it.

- VS Code handles save/undo/redo automatically
- Git diffs work correctly (text-based)
- External changes (git pull, other editors) trigger webview refresh

---

## Messaging Protocol

| Direction | Message Type | Purpose |
|-----------|--------------|---------|
| Extension → Webview | `update` | Send markdown content (initial load or external change) |
| Webview → Extension | `edit` | User changed content, apply to TextDocument |
| Webview → Extension | `save` | User pressed Cmd/Ctrl+S, trigger VS Code save |
| Webview → Extension | `ready` | Confirm listener readiness and force initial content delivery |

---

## Performance Constraints

| Metric | Budget | Notes |
|--------|--------|-------|
| Typing latency | <16ms | Never block the editor thread |
| Sync debounce | 500ms | Batch rapid edits before sending to extension |
| External update skip | 2s | Don't interrupt user if they edited recently |
| Target doc size | <10,000 lines | Beyond this, consider virtual scrolling |

---

## Key File Locations

| Task | Primary File | Directory |
|------|--------------|-----------|
| Register command/keybinding | `extension.ts` | `src/` |
| Handle webview messages | `MarkdownEditorProvider.ts` | `src/editor/` |
| TipTap setup & extensions | `editor.ts` | `src/webview/` |
| Toolbar buttons | `BubbleMenuView.ts` | `src/webview/` |
| Custom TipTap extension | Create new file | `src/webview/extensions/` |
| Styles | `editor.css` | `src/webview/` |
| Extension manifest | `package.json` | Root |

---

## TipTap Extension Pattern

New features often follow this pattern:

1. **Create extension** in `src/webview/extensions/[feature].ts`
2. **Register** in `editor.ts` extensions array
3. **Add toolbar button** in `BubbleMenuView.ts` (if UI needed)
4. **Wire messages** in `MarkdownEditorProvider.ts` (if extension-side logic needed)
5. **Add command** in `package.json` contributes (if command palette entry needed)

---

## References

- **Full architecture:** `[Project Root]/docs/ARCHITECTURE.md`
- **Design principles:** `[Project Root]/docs/DEVELOPMENT.md`
- **Coding guide:** `[Project Root]/AGENTS.md` (index) + `[Project Root]/vibe-coding-rules/` (details)
