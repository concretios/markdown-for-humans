# Manual QA + Usage Guide — Markdown for Humans (VS Code)

This document is for **manual QA engineers** and also doubles as a **user-facing usage guide** for the extension.

**Product goal:** a medium.com-style writing/reading experience where you can write Markdown naturally, with minimal syntax friction, while keeping the underlying file as plain Markdown (so Git diffs, tooling, and other editors still work).

---

## 1) What you’re testing

### Core concept

- The editor is a **VS Code Custom Editor** (`CustomTextEditorProvider`) that opens `.md` / `.markdown` files as a WYSIWYG webview.
- **Source of truth is the VS Code TextDocument** (the actual Markdown file text). The webview renders it and sends edits back as Markdown.

Why this matters for QA:

- Git diffs should look normal (plain text).
- Undo/redo and dirty state should behave like normal VS Code files.
- External changes (e.g. Git checkout/pull, editing in the default text editor) should refresh the WYSIWYG view.

---

## 2) Setup & installation

### Requirements

- VS Code `^1.98.0` (or newer).
- Open a trusted, disk-backed **workspace folder**. Virtual and untrusted workspaces are intentionally unsupported.
- For PDF export: **Chrome/Chromium** installed locally (the extension does not bundle a browser).

### Install

Pick one:

- Marketplace: install “Markdown for Humans”.
- VSIX: in VS Code, run `Extensions: Install from VSIX...` and choose the `.vsix`.

### Open a file in the editor

Pick one:

- Right click a `.md` file → **Open with Markdown for Humans**
- Command Palette → **Open with Markdown for Humans**
- If you want it to be default: click the file tab’s “Open With…” UI and choose this editor.

---

## 3) UI tour (what to look for)

### The WYSIWYG editor surface

- Top **formatting toolbar** (Codicon icons) with buttons and dropdowns.
- A clean reading layout: serif body typography, generous spacing, theme-aware colors.

### VS Code integration surfaces

- **Explorer View:** “Markdown for Humans: Outline” (heading tree)
- **Status bar:** word count (click shows detailed stats)
- **Command Palette:** outline commands (reveal/filter/clear)

---

## 4) Quick smoke test (15–20 minutes)

1. Open `docs/DEVELOPMENT.md` (long doc) in Markdown for Humans and scroll for ~2 minutes.
2. Type a sentence, apply **Bold** and **Italic**, then `Cmd/Ctrl+S` to save.
3. Insert a heading (H2), confirm the **Outline view** updates and clicking it navigates.
4. `Cmd/Ctrl+F` search for a word, jump next/previous, press `Esc` to close search.
5. Insert a table and resize a column; right-click a cell and use table context menu.
6. Insert a Mermaid diagram via toolbar, verify it renders; double-click to edit, save.
7. Insert a GitHub alert (`NOTE` or `WARNING`) from toolbar and type inside it.
8. Export → PDF (cancel is fine) and Export → Word (cancel is fine).

---

## 5) Detailed feature guide + test cases

### 5.1 Editor basics (typing, selection, save, undo)

#### Startup and tab lifecycle

**What to do**
- Open a zero-byte `.md` file and immediately click in the editor.
- Rapidly open at least three different Markdown files in separate tabs, including a long document.
- Switch among the tabs, then close and reopen one file.

**Expected**
- Every file, including the zero-byte file, immediately shows the toolbar and an editable surface.
- Each file renders its own content; no tab stays blank while another initializes.
- Pinned tabs remain open. An italic preview tab may be replaced by the next Explorer single-click,
  which is standard VS Code preview-mode behavior rather than an extension-initiated close.

**What to do**

- Type continuously for ~30 seconds; include punctuation and multiple paragraphs.
- Use `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` (undo/redo).
- Use `Cmd/Ctrl+S` (save) while typing.

**Expected**

- Typing feels responsive (no noticeable lag).
- Undo/redo works logically and returns the document to the exact prior text.
- Save does not corrupt content; the file remains plain Markdown.
- The document dirty indicator clears when you undo back to the initial content.

### 5.2 External changes + Git friendliness

**What to do**

- Open the same file in VS Code’s default text editor (Source view button makes this easy).
- Edit a paragraph in source, save, and switch back to WYSIWYG.
- If using Git: make an edit, view diff, then undo back to clean state.

**Expected**

- WYSIWYG refreshes to reflect external edits (without losing your cursor in a surprising way).
- Git diffs reflect plain Markdown changes.

### 5.3 Toolbar formatting (inline + blocks)

**Buttons**

- Bold (`Cmd/Ctrl+B`)
- Italic (`Cmd/Ctrl+I`)
- Strikethrough
- Inline code
- Headings H1–H6 (H4–H6 via “More headings” dropdown)
- Bullet/Numbered/Task list

**What to do**

- Apply each formatting option to a selection and also with an empty selection (where applicable).
- For headings: create H1/H2/H3 and confirm outline entries.
- For lists: create nested lists; use `Tab` / `Shift+Tab` to indent/outdent.

**Expected**

- Formatting is applied correctly and round-trips as Markdown.
- Lists indent/outdent without breaking focus or inserting weird characters.

### 5.4 Code blocks (language + paste fidelity)

**How to use**

- Toolbar → “Code block” dropdown → choose language (e.g. TypeScript).

**What to do**

- Select formatted text and convert it to a code block using the dropdown.
- Paste multi-line code into a code block; verify indentation is preserved.
- Press `Tab` in a code block; verify it indents with 2 spaces (and doesn’t jump focus).

**Expected**

- Code blocks keep plain text content (no bold/italics inside).
- Language selection changes syntax highlighting.
- No double-paste or lost indentation.

### 5.5 Tables (insert, navigate, resize, context menu)

**How to use**

- Toolbar → “Table” dropdown → “Insert Table”
- While in a table: use the same dropdown to add/remove rows/columns
- Right-click table cells for a dedicated table context menu

**What to do**

- Create a 3×3 table, type in cells, use `Tab` to move between cells.
- Resize columns by dragging borders.
- Add and delete a row/column via dropdown and via right-click menu.

**Expected**

- Table editing is stable; resizing is smooth.
- Context menu appears only when right-clicking inside a table.

### 5.6 Links

**How to use**

- Toolbar → Link (or `Cmd/Ctrl+K Cmd/Ctrl+L`)

**What to do**

- Create a link with selected text.
- Edit an existing link.

**Expected**

- Link is created/edited correctly in Markdown.
- Clicking a link should not unexpectedly navigate while editing (links are not “open-on-click” in the editor).

### 5.7 Search overlay (in-document)

**How to use**

- `Cmd/Ctrl+F` toggles the overlay.
- Enter: next match, Shift+Enter: previous match, `Esc`: close.

**What to do**

- Search for a word that appears 10+ times.
- Verify active match styling and “X of Y” counter.

**Expected**

- Matches highlight across the doc, scrolling to the active match.
- Closing the overlay restores editor focus and clears highlights.

### 5.8 Document outline (Explorer view + overlay)

**Surfaces**

- Explorer view: “Markdown for Humans: Outline”
- Toolbar button: “Outline” (overlay)

**What to do**

- Create multiple headings (H1–H3 nested).
- In Outline view:
  - Click headings to navigate.
  - Use “Outline: Filter Headings” and type a filter query.
  - Use “Outline: Reveal Current Heading”.
- In overlay:
  - Open it from toolbar and navigate with arrow keys + Enter.

**Expected**

- Outline updates quickly after edits.
- Active heading highlights as you move the cursor through sections.
- Filtering updates the visible tree without errors.

### 5.9 GitHub Alerts (callouts)

**How to use**

- Toolbar → “Alert” dropdown (NOTE/TIP/IMPORTANT/WARNING/CAUTION)
- Or write markdown directly:
  - `> [!WARNING]`
  - `> Your content`

**What to do**

- Insert each alert type and add:
  - a paragraph
  - a list
  - inline bold/italic/link inside
- Backspace/delete within alert content.

**Expected**

- Alerts render with a header (icon + label) and a styled body.
- Content editing syncs to Markdown correctly (no “looks deleted but file didn’t change” bugs).
- Markdown round-trip stays GitHub-compatible (`> [!TYPE]` + `>` lines).

### 5.10 Mermaid diagrams

**How to use**

- Toolbar → “Mermaid” dropdown → choose a template, or type a fenced block:
  - ```mermaid
    graph TD
    A-->B
    ```
- Single click highlights the block and shows “Double-click to edit”.
- Double click opens a modal editor (textarea), `Cmd/Ctrl+S` saves inside the modal.

**What to do**

- Insert a template and verify rendering.
- Edit to an invalid diagram and confirm an error UI appears (and source remains accessible).

**Expected**

- Valid Mermaid renders as SVG.
- Invalid Mermaid shows a clear error without breaking the editor.
- Markdown round-trips as a fenced ` ```mermaid ` block.

### 5.11 Images (insert, drag/drop, menu actions, resize, rename)

#### Insert images

**Ways**

- Toolbar → “Image” opens an insert dialog (drop zone + file picker).
- Drag/drop from:
  - Desktop/Finder/File Explorer
  - VS Code Explorer (drops file paths/URIs)
- Paste from clipboard (`Cmd/Ctrl+V`)

**Expected**

- Images appear immediately (may show placeholders while saving).
- Markdown uses relative paths when reasonable.

#### Image menu

Hover an image to reveal a **three-dots** menu, with:

- Resize
- Rename
- Open in Finder/Explorer (local images)
- Show in Workspace (local images)

**Expected**

- Menu opens/closes reliably, supports keyboard navigation, and doesn’t leave the editor in a broken focus state.

#### Resize images

**How to use**

- Image menu → Resize
- A sticky resize modal appears (bottom-right), with live preview.

**Expected**

- Resizing a **local workspace image** overwrites the image and creates a backup:
  - Backups stored under `YOUR_WORKSPACE/.md4h/image-backups/…`
- Resizing an **external image** (http/https) is blocked with a clear message.
- Undo/redo within the resize flow restores the image file visually and updates metadata.

#### Rename images

**How to use**

- Image menu → Rename

**Expected**

- Image file renames on disk and the Markdown reference updates.
- If the image is referenced elsewhere, the extension may show reference info (verify links remain valid).

### 5.12 Copy selection as Markdown

**How to use**

- Select formatted content → Toolbar → “Copy MD” → paste into a plain text buffer.

**Expected**

- Clipboard contains Markdown representing the selection (not HTML).

### 5.13 Pasting code: copy button vs. copying from a source file

This is **intentional, non-configurable behavior** — the editor's paste handling looks at what the clipboard actually contains, not a user setting, so the same paste action can produce different results depending on where the content was copied from. Both outcomes below are correct.

**Why they differ**

- The **copy button on a rendered code block** (top-right icon) copies **plain text only** — no HTML flavor is placed on the clipboard.
- **Copying source code from a file** (a `.js`/`.py`/etc. file in an editor, a GitHub file view, another rich code viewer) typically puts a `<pre><code>` HTML fragment on the clipboard alongside the plain text.

**What to do**

- Click the copy-button on an existing code block, then paste into a normal paragraph (cursor **not** inside a code block).
- Separately, open a source file, copy a few lines, and paste into a normal paragraph.
- Repeat both pastes with the cursor already inside an existing code block.

**Expected**

- Copy-button paste (plain text, no HTML) into a normal paragraph: treated like any plain-text paste — Markdown-looking syntax (`#`, `**`, lists, etc.) renders as formatting; otherwise it lands as plain paragraph text. It is **not** re-wrapped in a fenced code block, since the clipboard carries no signal that it was code.
- Source-file paste (HTML with `<pre><code>`) into a normal paragraph: recognized as rich HTML and converted into a properly fenced Markdown code block (` ``` `), including the language tag when the source annotates one (e.g. `class="language-ts"`).
- Either paste with the cursor already inside an existing code block: inserted as literal text with no Markdown/HTML parsing at all, regardless of source (see §5.4).

### 5.14 Source view (split pane)

**How to use**

- Toolbar → “Source” opens the default VS Code editor beside the WYSIWYG view.

**What to do**

- Make an edit in source, save, and verify the WYSIWYG view updates.

**Expected**

- Two views stay in sync without duplication or “fight” loops.

### 5.15 Export (PDF + Word)

**How to use**

- Toolbar → “Export” dropdown → “Export as PDF” or “Export as Word”

**PDF requirements**

- Chrome/Chromium is required; the extension will:
  - use `markdownForHumans.chromePath` if set, otherwise
  - auto-detect common Chrome/Chromium locations, otherwise
  - prompt you to browse/enter a path or download Chrome.

**What to do**

- Export a doc with:
  - headings, lists, tables
  - at least one Mermaid diagram
  - at least one local image
- Cancel once to ensure cancellation is handled.

**Expected**

- A save dialog appears with a sensible default filename in the document’s folder.
- Success shows a VS Code info message; failures show a VS Code error message with useful guidance.

### 5.16 Settings

Open settings via:

- Toolbar → “Export settings” (gear) or
- VS Code Settings search for “Markdown for Humans”

**Settings to verify**

- `markdownForHumans.imagePath` (default `images`)
- `markdownForHumans.imagePathBase` (`relativeToDocument` or `workspaceFolder`)
- `markdownForHumans.chromePath` (PDF export)
- `markdownForHumans.imageResize.skipWarning`

### 5.17 Feedback reliability and split views

Use a saved Markdown file with several paragraphs, a long table, an image, Mermaid, math, and enough content to scroll.

**Start and recover**

- Start Feedback, then add a text comment, a block comment, a 4 by 4 table-cell comment, and an area capture.
- Cancel a capture with Escape, pointer cancellation, window blur, and by switching tabs. Start another capture after each cancellation.
- Reload the owning webview during Start and after Feedback becomes active. Reopen the durable draft when offered.

**Split and source changes**

- Open the same document in two rich-editor splits. Start Feedback in one split and confirm both splits become non-editable before the snapshot is fixed.
- Close either split during Start, Finish, and Discard. The survivor must never expose an editable gap while a Feedback lock is active.
- Finish and discard rounds with both splits visible. Both must show the exact restored Markdown before either becomes editable.
- Make an external source edit while Feedback is active. The round must invalidate visibly, preserve its draft, and block sealing against stale content.
- Create different unsent edits in two splits, then Start Feedback. The operation must stop with a visible conflict instead of choosing one split silently.

**Images and hidden renderers**

- Paste or drop an image, immediately switch tabs, then save and reopen the file. The Markdown must contain the saved relative image path or recoverable image data, never a broken pending marker.
- With VS Code `files.autoSave` set to `onFocusChange`, type and immediately leave a non-retained rich-editor tab. Reopen it and verify the latest text was saved.

**Expected**

- Start always reaches active review, a clearly editable recovery state, or a resumable draft.
- Capture always reaches a terminal state and can be started again.
- Table-cell actions remain available for rectangular selections.
- No split unlocks from a timeout alone, and no source bytes are selected by reply order.
- Use **Copy Feedback Diagnostics** after any failure and attach the content-free result to the bug report.

---

## 6) Reading experience + performance verification (required)

This extension’s core value is **long-form readability**.

**Minimum manual check**

- Open a long doc (recommended: `docs/DEVELOPMENT.md` or `docs/ARCHITECTURE.md`).
- Read/scroll for **10 minutes** in both a light and dark theme.
- On the reference Windows i5/16 GB machine, repeat with the 10,000-line stress document, several split views, and at least one hidden rich-editor tab.

**Look for regressions**

- Janky scrolling, selection jumps, cursor teleporting, lag while typing.
- Extension Host CPU stalls or memory that continues to grow after repeatedly opening, hiding, restoring, and closing long documents.
- Poor contrast in the theme you use.
- Too-tight spacing, inconsistent paragraph margins, code readability issues.

---

## 7) Diagnostics (when reporting bugs)

When filing a bug, include:

- Repro steps + expected vs actual
- OS + VS Code version
- Whether the file is `file:` or `untitled:` and whether a workspace is open
- If it involves images: whether the image is local, in-workspace, or external URL

Where to look for logs:

- Extension host logs: VS Code → `View: Toggle Output` and also `Developer: Toggle Developer Tools` / “Console”
- Webview logs: VS Code → `Developer: Open Webview Developer Tools` (look for `[MD4H]` messages)

**Bug report template**

```
Title:
Environment:
  OS:
  VS Code:
  Extension version:
  Workspace open?: (yes/no)
File type: (file/untitled)

Steps to reproduce:
1)
2)
3)

Expected:
Actual:

Logs/screenshots:
```
