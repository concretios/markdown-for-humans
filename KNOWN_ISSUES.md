# Known Issues

Living list of open limitations for **Markdown for Humans 0.4.0**. For release history, see [CHANGELOG.md](CHANGELOG.md). To report something new: [GitHub Issues](https://github.com/concretios/markdown-for-humans/issues).

**Status:** 0.4.0 (2026-10-01) · **Last updated:** 2026-10-03

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

### Escaped Markdown characters
Escaped characters such as `\*` may be saved without the backslash and turn into formatting.

### Loose / ordered list markers
Loose lists can round-trip as tight lists; `1)` markers may become `1.`.

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
