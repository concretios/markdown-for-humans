# Task: GitHub Alerts Support

## 1. Task Metadata

- **Task name:** GitHub Alerts Support
- **Slug:** github-alerts
- **Status:** in-progress
- **Created:** 2025-12-09
- **Last updated:** 2025-12-09
- **Shipped:** Completed

---

## 2. Context & Problem

- **Problem:** GitHub callout syntax `[!NOTE]/[!WARNING]` renders as a plain quote, so warnings/tips look identical and are easy to miss.
- **Current state:** WYSIWYG shows a single gray blockquote with italic text; toolbar only toggles generic quotes; `[!TYPE]` renders as literal text.
- **Why it matters:** Readers miss hazards, docs feel unpolished, and GitHub-authored content loses meaning in our editor.
- **Impact on workflow:** Authors have to restyle manually or abandon callouts when switching between GitHub and the extension.
- **Doc clarity risk:** Safety or critical instructions are visually buried among regular quotes.

---

## 3. Desired Outcome & Scope

- **Success criteria:**
  - `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` render as colored callouts with icon + label in WYSIWYG.
  - Same syntax round-trips between source view, GitHub, and exports without extra markup.
  - Toolbar action inserts a selected alert type at cursor.
  - Automatic syntax matching for `> [!TYPE]` patterns, similar to other markdown tokens.
  - Alerts remain readable as standard blockquotes in editors that ignore the syntax.

- **Out of scope:** Custom alert types or user-defined colors/icons; nested alerts; non-GitHub syntaxes; keyboard shortcuts; slash commands.

---

## 4. UX & Behavior

- **Entry points:** Toolbar alert picker; manual `> [!TYPE]` in source view; convert existing quote by adding `[!TYPE]` to first line.
- **Flow – Insert via toolbar:** 1) Cursor in text → 2) Choose alert type → 3) Callout appears with label/icon and placeholder line ready for typing.
- **Flow – Manual markdown:** 1) Type `> [!WARNING]` + content → 2) Editor renders colored warning box; source view shows raw markdown unchanged.
- **Flow – Multi-line content:** 1) Additional `>` lines stay inside the same callout → 2) Lists/code/images render inside the styled alert without breaking layout.

### Current Functionality (Source of Truth)

- **Current behavior (user-facing):** Quotes toggle via toolbar or markdown `>` and display as a generic gray, italic blockquote; `[!NOTE]` shows as plain text with no icon or color.
- **Current implementation (technical):** Blockquote node comes from TipTap StarterKit + Markdown extension; toolbar `Quote` button calls `toggleBlockquote`; styles in `editor.css` set a uniform border/background.
- **Key files:** `src/webview/editor.ts`, `src/webview/BubbleMenuView.ts`, `src/webview/editor.css`.
- **Pattern to follow:** Custom TipTap extensions + CSS like `Mermaid`/`CustomImage` for specialized rendering, plus toolbar dropdown pattern used for tables/code blocks.

---

## 5. Technical Plan

- **Surfaces:**
  - Webview (TipTap editor + toolbar)
- **Key changes:**
  - `src/webview/extensions/githubAlerts.ts` – TipTap extension to detect/render GitHub alert blockquotes and expose alert types.
  - `src/webview/editor.ts` – Register the alert extension; ensure markdown serializer maps `[!TYPE]` without extra markup.
  - `src/webview/BubbleMenuView.ts` – Add toolbar picker entry for alert types (no slash/keyboard shortcuts).
  - `src/webview/editor.css` – Add alert-specific colors, labels, icons, and layout; ensure theme-friendly tokens.
  - `src/webview/extensions/markdownConfig.ts` (or equivalent) – Confirm parser/serializer settings handle `> [!TYPE]` gracefully for round-trip.
- **Architecture notes:**
  - Keep logic entirely in webview; extension side unchanged since no new commands or message types.
  - Follow existing custom extension patterns (e.g., Mermaid) for schema + node view/styling.
  - Preserve markdown fidelity: alerts serialize back to `> [!TYPE]` lines, and fallback renders as plain blockquote if unsupported.
- **Performance considerations:**
  - Avoid extra re-renders; rely on existing blockquote node with lightweight attrs.
  - Keep CSS minimal; no additional assets or async fetches.
  - Ensure detection is case-insensitive and handled during markdown parse, not via runtime scanning of DOM.

---

## 6. Work Breakdown

| Status | Task | Notes |
|--------|------|-------|
| `pending` | **Update feature-inventory.md** | Add task to "🚧 In Progress" |
| `pending` | Read current quote/markdown handling | `src/webview/editor.ts`, `extensions/markdownConfig.ts` |
| `pending` | Implement GitHub alert extension | `src/webview/extensions/githubAlerts.ts` |
| `pending` | Wire toolbar alert picker | `src/webview/BubbleMenuView.ts` |
| `pending` | Style alert types | `src/webview/editor.css` |
| `pending` | **Write unit tests** | `src/__tests__/webview/githubAlerts.test.ts` (render + round-trip) |
| `pending` | **Ship & update inventory** | Tag task-ship.md, move to shipped/ |

### How to Verify

- **Feature inventory updated:** `roadmap/feature-inventory.md` shows github-alerts in 🚧.
- **Toolbar picker:** In WYSIWYG, select alert type → block appears with label/icon and placeholder; no keyboard/slash entries.
- **Markdown round-trip:** Type `> [!WARNING]` + content in source → renders colored warning; toggle source to confirm unchanged markdown; export/plain view remains standard blockquote.
- **Existing quotes unaffected:** Plain blockquote still renders gray and toggles via existing toolbar button.
- **Unit tests:** Run `npm test`; coverage confirms parsing, rendering, serialization, and toolbar action inserts correct markdown.

---

## 7. Implementation Log

### 2025-12-09 – Task refined

- **What:** Added technical plan, work breakdown, and verification steps; set status to in-progress.
- **Ready for:** Implementing alert extension + toolbar picker.
- **First task:** Update feature-inventory.md entry.

### 2025-12-09 – Implementation complete

- **What:** Implemented GitHub alerts extension with full markdown round-trip support
- **Files:**
  - `src/webview/extensions/githubAlerts.ts` – TipTap extension for parsing/rendering alerts
  - `src/webview/editor.ts` – Registered GitHubAlerts extension (priority 150, before StarterKit)
  - `src/webview/BubbleMenuView.ts` – Added Alert dropdown with 5 types (NOTE, TIP, IMPORTANT, WARNING, CAUTION)
  - `src/webview/editor.css` – Added styling for all alert types with colors, icons, labels, dark theme support
  - `src/__tests__/webview/githubAlerts.test.ts` – Unit tests for parsing and rendering (TDD)
  - `roadmap/feature-inventory.md` – Updated status to in-progress
- **Implementation details:**
  - Extension intercepts blockquote tokens matching `[!TYPE]` pattern (case-insensitive)
  - Supports all 5 GitHub alert types with proper validation
  - Renders with custom node view showing icon + label header
  - CSS uses GitHub colors with VS Code theme integration
  - Toolbar dropdown inserts markdown syntax directly
  - Round-trip: parse `> [!NOTE]` → render alert → serialize back to `> [!NOTE]`
- **Decisions:**
  - Used `content: 'block+'` to allow paragraphs/lists inside alerts (like regular blockquotes)
  - Priority 150 ensures alerts parse before StarterKit's blockquote (100)
  - Node view creates header + content wrapper for proper styling
  - Icons use emoji fallbacks (ℹ, 💡, 📢, ⚠, 🛑) for simplicity
- **Testing:** Unit tests written (TDD), ready for manual verification
- **Status:** Implementation complete, ready for testing and refinement

### 2025-12-11 – Critical bug fixes after user testing

- **What:** Fixed two critical bugs discovered during real-world usage
- **Bug #1: Content edits not syncing to markdown**
  - **Issue:** Pressing backspace in alert content appeared to delete text visually but didn't update markdown or mark document dirty
  - **Root cause:** Missing `ignoreMutation` method in custom node view - ProseMirror couldn't distinguish between mutations in decorative header vs editable content
  - **Fix:** Added `ignoreMutation` method to githubAlerts.ts (lines 212-220) to ignore header mutations and process content mutations
  - **Research:** Based on ProseMirror documentation and GitHub issues (#1257, #1311) showing this is standard pattern for node views with mixed editable/non-editable content
- **Bug #2: Cursor appearing in non-editable header**
  - **Issue:** Cursor could appear between icon and label in header (screenshot: cursor blinking in "IMPORTANT" header)
  - **Root cause:** `contentEditable="false"` alone wasn't enough - CSS didn't prevent pointer events or text selection
  - **Fix:** Added `user-select: none` and `pointer-events: none` to `.github-alert-header` CSS
- **Enhancement: Preserve inline formatting**
  - **Issue:** Bold/italic text inside alerts lost during markdown round-trip
  - **Fix:** Improved parseMarkdown to use token-based parsing via `helpers.parseChildren` instead of plain text parsing
  - **Result:** `**bold**` and `_italic_` now preserved correctly inside alerts
- **Files modified:**
  - `src/webview/extensions/githubAlerts.ts` – Added ignoreMutation, contentEditable fix, inline formatting parser, JSDoc updates
  - `src/webview/editor.css` – Added user-select/pointer-events to header, improved content spacing
  - `src/__tests__/webview/githubAlerts.test.ts` – Updated tests for paragraph structure, added inline formatting test
- **Testing:** All 15 unit tests passing, changes validated against task goals
- **Stability:** LOW RISK - Changes scoped to GitHub Alerts extension only, based on official ProseMirror/TipTap patterns, no regressions
- **Status:** Bug fixes complete, feature now stable and usable

### 2025-12-12 – Cursor gap & blank-line cleanup (final)

- **What:** Resolved caret appearing in the gap under the alert header and removed stray `<br>` emitted from blank lines.
- **Root cause:** Markdown with a blank line after `[!TYPE]` produced a leading hard break/empty text node, rendering as `<p><br>` and creating a clickable caret spot under the non-editable header.
- **Fixes:**
  - Trim leading hard breaks/empty text from parsed paragraphs and drop empty paragraphs so alerts render without a leading `<br>`.
  - Keep spacing inside the non-editable header via padding (no margin-gap click-through) and rely on `ignoreMutation` only (removed JS selection hacks).
- **Files:** `src/webview/extensions/githubAlerts.ts`, `src/webview/editor.css`, `src/__tests__/webview/githubAlerts.test.ts`.
- **Testing:** `npm test -- githubAlerts.test.ts` (18 tests passing).
- **Status:** Cursor now lands only in real content; blank-line rendering clean; ready to ship.
