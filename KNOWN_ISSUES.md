# Known Issues

Living list of open limitations for **Markdown for Humans 0.4.2**. For release history, see [CHANGELOG.md](CHANGELOG.md). To report something new: [GitHub Issues](https://github.com/concretios/markdown-for-humans/issues).

**Status:** 0.4.2 (2026-10-06) · **Last updated:** 2026-10-06

---

## Open issues

### Workspace file drag-drop in Cursor IDE
Dragging images from the Cursor workspace explorer into the editor is often not detected. Works in VS Code / Windsurf. External drops (Finder/desktop) may still work.

**Workaround:** Image insert dialog, source view, or drop from Finder/desktop.

### Word export omits embedded images
Word (DOCX) export does not embed images. PDF export is not affected by this specific gap. Both formats also omit images the editor itself cannot show (paths outside the document/workspace roots, `http:` URLs). Keep images next to the document or inside the workspace; prefer relative paths. Remote HTTPS may embed in PDF; Word skips remote HTTP/HTTPS.

### Task-item line breaks can lose text
Text after a line break inside a task item can disappear on reopen (e.g. `- [ ] task\` with a backslash break). Avoid line breaks inside task items until fixed.

### HTML `<img>` resize drops attributes
Resizing a hand-written HTML `<img>` rewrites the tag without other attributes (`align`, `class`, `style`).

### Edited blocks are saved in a standard Markdown form
Since 0.4.1, blocks you do not edit keep their exact source on save. A block you do edit (a paragraph, list, table or heading) is re-written in a standard form: soft line breaks become two-space line breaks, tables are padded, `*` list markers become `-`, and setext headings become `#` headings. The rendered result is the same.

### Escaped Markdown characters
In a block you edit, escaped characters such as `\*` may be saved without the backslash and turn into formatting. Unedited blocks keep the backslash.

### HTML comments inside links, emphasis, or before text
Comments are kept on their own lines, inside lists and blockquotes, and inside a line of text (`Text <!-- note --> more`). Two placements are still dropped when the file is saved from the editor: a comment inside link text or emphasis (`**bold <!-- note --> text**`), and a comment at the start of a line with text after it on that line (`<!-- note --> text`).

**Workaround:** Move the comment outside the link or emphasis, or put it on its own line.

### Loose / ordered list markers
In a list you edit, loose lists can round-trip as tight lists and `1)` markers may become `1.`. Unedited lists keep their source.

### Blank line added next to a block you edit
Blocks you do not edit keep the exact layout they had, including a heading, label or paragraph that sits directly above a list, code fence or text with no blank line. When you edit one of two such neighbors, saving puts a blank line between them (for example after an edited bold label above its list, or after an edited heading above text). The rendered result is the same; only the source layout changes.

### Feedback refuses lists that mix plain and task items
A list that contains both plain items and task items (`- note` and `- [ ] todo` in one list) stops **Log feedback for an LLM** from starting: the editor splits it into two lists, so Feedback cannot match its blocks to the saved file. A brief message says to split the list; the file itself is not changed.

**Workaround:** Separate the plain items and the task items into two lists.

### Undo can step back over a change made outside the editor
If the file is changed while it is open in the editor (a Git checkout, another extension, a formatter), pressing Undo first steps back to the text from before that change, and that older text is written to the file. VS Code's own text editor behaves the same way for edits that other extensions apply.

**Workaround:** Check **Source Control** before committing, or use **Git: Discard Changes** to return to the checked-out version.

### Files without a final newline get one
The editor writes every file with exactly one trailing newline (markdownlint MD047). A file that ended without one gains a newline on the first edit, which shows as a one-line change in Git.

### A new empty code fence is saved as `plaintext`
Typing three backticks and then code writes ```` ```plaintext ```` rather than a bare fence. A bare fence that is already in the file stays bare, even after you edit its block.

---

## Design limitations

### Large documents
Very large docs (10,000+ lines) may feel slower while editing (TipTap document model). Split files if needed.

### Large images
Images over ~2MB or 2000px trigger a resize dialog. Extremely large files (>10MB) can still be slow to process.

### Mermaid in exports
Diagrams that fail conversion in the webview may not appear correctly in PDF/Word. Confirm they render in the editor before exporting.

---

## Common workarounds

| Symptom | Workaround |
|---------|------------|
| “Open with Markdown for Humans” fails | Command Palette → **Markdown for Humans: Open File** |
| Theme colors look wrong | Reload Window; check VS Code theme settings |

---

## Recently fixed

- **Enter in table cells** — maps to hard break (`<br>`) so GFM tables stay valid (`TableCellEnterHardBreak`).
- **Enter at gap cursor before image** — inserts before/after the containing block correctly.

---

**Agents:** Prefer [CHANGELOG.md](CHANGELOG.md) Known Issues for the current release. Do not treat this file as a roadmap or metrics dashboard. Active work: [`roadmap/pipeline/`](roadmap/pipeline/). Shipped plans: [`roadmap/shipped/`](roadmap/shipped/).
