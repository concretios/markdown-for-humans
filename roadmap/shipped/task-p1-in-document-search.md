# 1. Task Metadata

- **Task name:** Reliable in-document search for Markdown for Humans
- **Slug:** in-document-search
- **Status:** shipped in 0.4.0
- **Created:** 2025-12-09
- **Last updated:** 2025-12-09
- **Shipped:** 2025-12-09

---

## 2. Context & Problem

- **Problem:** In the Markdown for Humans custom editor, users cannot reliably search within the current document; pressing Cmd/Ctrl+F does not produce a working in-document search experience.
- **Current state:** The custom editor enables VS Codes find widget (`enableFindWidget: true`), but the native search behavior inside the WYSIWYG surface is currently broken or inconsistent and there is no visible search affordance.
- **Why it matters:** For long notes and documents, not being able to quickly jump to specific phrases or sections makes the editor feel heavy and pushes users back to the plain text editor or global Search, breaking the seamless WYSIWYG workflow.

---

## 3. Desired Outcome & Scope

- **Success criteria:**
  - In a Markdown for Humans editor, pressing Cmd/Ctrl+F always opens a search experience that clearly highlights matches in the WYSIWYG content and lets users move between them (next/previous).
  - Search remains responsive on typical markdown documents and does not interfere with existing shortcuts (save, formatting, TOC overlay) or text selection.
- **Out of scope:**
  - Cross-file or workspace-wide search (users continue to use VS Codes Search view for that).
  - Fuzzy/semantic search or ranking; this task is limited to straightforward in-document text search.

---

## 4. UX & Behavior

- **Entry points:**
  - Keyboard: Cmd+F / Ctrl+F when the Markdown for Humans editor is focused.
  - Optional toolbar icon: a Find in document button in the WYSIWYG toolbar that triggers the same search experience.
  - Optional command palette action: `Markdown for Humans: Find in Document` that focuses the editor and opens search.
- **Flow:**
  - User is editing in Markdown for Humans and presses Cmd/Ctrl+F.
  - A search UI appears (either VS Codes built-in find widget or a consistent in-editor bar/overlay) with focus in the query box.
  - As the user types, all matches in the current document are highlighted; Enter moves to the next match, Shift+Enter to the previous.
  - The current match is scrolled into view and clearly indicated (selection or distinct highlight).
  - Pressing Esc closes the search UI and returns focus to the editor without losing the current selection.

### Current Functionality (Source of Truth)

- **Current behavior (user-facing):** Inside the Markdown for Humans editor, there is no reliable in-document search experience; Cmd/Ctrl+F does not consistently activate a usable find widget, and there is no dedicated search control in the toolbar.
- **Current implementation (technical):**
  - `MarkdownEditorProvider` registers a `CustomTextEditorProvider` with `enableFindWidget: true`, but the webview/editor does not expose or verify search behavior.
  - `editor.ts` wires TipTap, toolbar actions, TOC overlay, export, and various keyboard shortcuts (save, formatting, link) but does not handle search-specific messaging or UI.
  - The outline tree (`OutlineViewProvider`) and TOC overlay provide heading-based navigation, not free-text search.
- **Key files:**
  - `src/editor/MarkdownEditorProvider.ts`  custom editor registration, webview options, document  webview sync.
  - `src/webview/editor.ts`  TipTap setup, keyboard shortcuts, toolbar wiring, message handling.
  - `src/features/outlineView.ts`  outline view + filter behavior (search-like UX pattern).
  - `src/webview/features/tocOverlay.ts`  in-editor overlay pattern with keyboard navigation.
- **Pattern to follow:**
  - For UX, follow the overlay and keyboard patterns used by `tocOverlay` and the outline filter (QuickPick + live filtering).
  - For wiring, follow the existing messaging and shortcut patterns between `MarkdownEditorProvider` and `editor.ts`, so that search integrates cleanly with the custom editor lifecycle and does not regress performance.
