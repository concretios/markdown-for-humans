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
- Feedback mode is a deliberate exception to live refresh: it freezes saved bytes and invalidates on a later source change

---

## Messaging Protocol

| Direction | Message Type | Purpose |
|-----------|--------------|---------|
| Extension → Webview | `update` | Send markdown content (initial load or external change) |
| Webview → Extension | `edit` | User changed content, apply to TextDocument |
| Webview → Extension | `save` | User pressed Cmd/Ctrl+S, trigger VS Code save |
| Webview → Extension | `ready` | Webview initialized, request initial content |
| Webview → Extension | `feedback.*` requests | Start a snapshot, mutate draft items, seal, reveal, diagnose, or discard |
| Extension → Webview | `feedback.*` results | Activate/update/invalidate/end the session or return a structured error |

All Feedback requests cross `parseFeedbackWebviewMessage`; unknown or malformed payloads are rejected before host file operations.

---

## Feedback Snapshot Contract

- Start flushes pending rich-view edits, saves, reads exact source bytes, and records SHA-256.
- `feedbackAnchors.ts` accepts anchors only when canonical rich blocks and raw `markdown-it` blocks have matching count, order, and normalized kinds. It never uses fuzzy fallback.
- Canonical blocks include ProseMirror content sizes. Character-addressable text may carry a strict block-relative half-open range that the host bounds-checks and enriches with canonical block hashes. Draft metadata is removed on seal. Exact resolved cross-block text keeps inline highlighting; opaque, multi-block block-level fallback, legacy, and runtime-degraded targets retain one continuous block bracket.
- The active editor is selection-capable but read-only. Any later source change preserves the draft, invalidates the session, and blocks new items and sealing.
- Each start or resume creates a fresh runtime token separate from the durable round. Active host responses are token-correlated, and inactive draft discard has its own response shape, so stale async work cannot mutate or close a newer session.
- Feedback decorations are dynamically registered only for an active session. Pins, connectors, compact cards, and the composer live in an absolute sibling layer under `#editor`, so document scroll requires no annotation JavaScript or independent panel scroll surface.
- Drafts live at `.md4h/feedback/<source-directory>/<filename>--<UTC>-<suffix>/feedback.md`; screenshot evidence is `assets/F<n>.png`.
- Matching drafts are announced with content-free metadata and resume only after explicit user action. Strict resume revalidates the report, persisted `next_id`, paths, bounded PNG structure, and exact per-asset SHA-256 before restoring read-only mode.
- `feedbackSessionStore.ts` serializes atomic rewrites, allocates at most 2,000 monotonic IDs, caps cumulative screenshot evidence at 64 MiB, validates source and screenshot hashes on seal, and treats sealed bundles as immutable.
- Screenshot capture is DOM-based through `modern-screenshot@4.7.0`, limited to mapped visible blocks, 12 MP, and 10 MiB. Intersecting Mermaid wrappers must reach their explicit ready state before cloning; errors and the bounded timeout fail visibly. The host revalidates the flattened PNG.

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
| Validate Feedback protocol | `feedbackProtocol.ts` | `src/shared/` |
| Map Feedback source lines | `feedbackAnchors.ts` | `src/editor/` |
| Persist Feedback bundles | `feedbackSessionStore.ts` | `src/editor/` |
| Feedback session/same-scroll UI | `feedbackReview.ts` | `src/webview/features/` |
| Feedback exact rendered ranges | `feedbackRenderedRange.ts` | `src/webview/features/` |
| Feedback decoration state | `feedbackAnnotations.ts` | `src/webview/features/` |
| Feedback collision layout | `feedbackAnnotationLayout.ts` | `src/webview/features/` |
| Feedback capture/markup | `feedbackCapture*.ts`, `feedbackDomCapture.ts` | `src/webview/features/` |
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
