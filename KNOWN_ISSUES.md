# Known Issues

Living list of open limitations for **Markdown Editor for Humans 0.4.6**. For release history, see [CHANGELOG.md](CHANGELOG.md). To report something new: [GitHub Issues](https://github.com/concretios/markdown-for-humans/issues).

**Status:** 0.4.6 (2026-11-07) · **Last updated:** 2026-11-07

---

## Open issues

### Workspace file drag-drop in Cursor IDE
Dragging images from the Cursor workspace explorer into the editor is often not detected. Works in VS Code and Devin Desktop (formerly Windsurf). External drops (Finder/desktop) may still work.

**Workaround:** Image insert dialog, source view, or drop from Finder/desktop.

### Word export omits embedded images
Word (DOCX) export does not embed images. PDF export is not affected by this specific gap. Both formats also omit images the editor itself cannot show (paths outside the document/workspace roots, `http:` URLs). Keep images next to the document or inside the workspace; prefer relative paths. Remote HTTPS may embed in PDF; Word skips remote HTTP/HTTPS.

### Word export keeps the text, not all of the layout
Word (DOCX) export writes headings, paragraphs, lists, quotes, code blocks and block math. It is simpler than the PDF:

- **Lists:** bold, italic and inline code inside a list item export as plain text. Numbered lists export as bullets. A nested item is joined onto its parent's line.
- **Tables:** each cell exports as its own paragraph, so the grid is lost.
- **Links:** the link text is exported without its address.
- **Quotes and headings:** exported as plain text, without inline formatting. The paragraphs of a quote are joined into one.
- **Block math:** exported as its LaTeX source.

**Workaround:** Use PDF export when layout matters.

### SVG images
Raw inline `<svg>` markup and Marp's `w:1000` alt-text directive are not interpreted. An unsized SVG fills the reading column, the same way the built-in preview does. Word export does not include SVG images (see above).

**Workaround:** Reference SVGs as image files, and use **Image options > Display size** when one occurrence needs a different width.

### PDF export cannot use your browser sign-in
PDF export runs in a temporary incognito Chrome session, so remote images that need your browser's sign-in cookies do not appear. Local images, including SVGs at their display sizes, export normally.

**Workaround:** Keep images next to the document or inside the workspace.

### Task-item line breaks can lose text
Text after a line break inside a task item can disappear on reopen (e.g. `- [ ] task\` with a backslash break). Avoid line breaks inside task items until fixed.

### HTML the editor cannot keep
The rich view has no place for some raw HTML. Two cases:

- **Removed by any edit:** `<video>`, `<audio>`, `<iframe>`, inline `<svg>`, `<style>`, `<script>`, a standalone `<a name="...">` or `<a id="...">` anchor, a `<br>` on a line of its own, `<dl>` and `<figure>` with `<figcaption>`. The file is intact until you edit. A notice names the content and the editor stays read-only until you choose **Edit anyway**. Saving while it is read-only leaves the file as it is. **Open source view (split)** opens the Markdown beside the editor; it does not unlock the rich view. The choice is not remembered: the file is read-only again the next time it is opened, and after it changes on disk.
- **Removed when you edit that block:** inline tags such as `<mark>`, `<u>`, `<ins>`, `<abbr>`, `<span>`, `<font>`, `<b>`, `<i>`, a `<br>` in a paragraph, `<a id>` and `<a target>`; and one-line blocks such as `<h1 align="center">`, `<div>`, `<center>`, `<p>`, `<pre><code>`. A notice names what was removed and offers **Undo**. An edit that changes only how the block is written (a dropped `\*` escape, spaces inside a code span) shows a general notice instead; once closed, it does not appear again for that document until it is reopened.

Kept: comments, wrappers with blank lines around their content (`<div align="center">`, `<details>`), `<kbd>`, `<sub>`, `<sup>`, `<img>` and HTML tables. The first list was confirmed in VS Code for `<video>` and the anchor; the rest comes from automated tests outside VS Code.

**Workaround:** Edit such content in the source view.

### HTML `<img>` resize drops attributes
Resizing a hand-written HTML `<img>` rewrites the tag without other attributes (`align`, `class`, `style`).

### Edited blocks are saved in a standard Markdown form
Since 0.4.1, blocks you do not edit keep their exact source on save. A block you do edit (a paragraph, list, table or heading) is re-written in a standard form: soft line breaks become two-space line breaks, tables are padded, `*` list markers become `-`, and setext headings become `#` headings. The rendered result is the same.

### Escaped Markdown characters
In a block you edit, escaped characters such as `\*` may be saved without the backslash and turn into formatting. Unedited blocks keep the backslash.

### Plain-text paste and Markdown syntax
Text pasted with `Ctrl+Shift+V` (`Cmd+Shift+V` on macOS) is saved as written. When it contains Markdown syntax (`**bold**`, or a line that starts with `#` or `-`), the editor asks how to paste it. If you choose **Paste as plain text**, it shows as plain characters after the paste and is read as Markdown the next time the file is opened.

**Workaround:** Choose **Paste as code** for text that must stay literal.

### Copy Reference for AI
- **Multi-root workspaces:** the path is relative to the file's own workspace folder and does not include the folder's name, so two folders can give the same reference.
- **Files outside the workspace** are copied with their absolute path.
- **No line numbers:** if any block of the document cannot be matched to the saved file, the reference is the path alone, for every position in that file. The message says so.
- **Saves first:** a file with unsaved changes is saved before the reference is copied, so the lines match what the agent reads. During a Feedback review the file is not saved; with unsaved changes nothing is copied.
- **Untitled files** have no path and are refused with a message.
- **File names with `#` or `"`** are copied as they are, so the reference can be read wrongly by the agent.

### Translations have had no native review
The five translated languages (Simplified Chinese, Japanese, Spanish, Brazilian Portuguese, Russian) were drafted and checked by AI. No native speaker has reviewed them. Feedback files and the prompt handed to your agent stay in English. Corrections: see [Translations](./l10n/README.md).

### The editor shows English in a translated VS Code
A translation shows only when VS Code has the Language Pack for that language. **Configure Display Language** installs it for you. If VS Code was set to a language another way, for example started with `--locale`, and the pack is not installed, the editor shows English. Any display language other than the six shipped ones also shows English. Among Open VSX editors, only Cursor has been tested (Simplified Chinese and Japanese, with the Language Pack from its marketplace); VSCodium and Devin Desktop have not been tested.

**Workaround:** Run **Configure Display Language**, pick the language, and restart when asked.

### Font settings do not apply to exports
`markdownForHumans.font.*` change the editor only. PDF and Word exports keep their own fonts. A font that is not installed on your computer is ignored and the standard font is used. Code blocks stay monospace, and math and diagrams keep their own fonts.

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

### A link around both text and an image is split when edited
A single link that wraps text and an image together (`[see ![Logo](logo.png) here](https://example.com)`) is saved as separate links with the same address once you edit its paragraph: `[see](https://example.com) [![Logo](logo.png)](https://example.com) [here](https://example.com)`. Every part still links to the same place. **Log feedback for an LLM** refuses to start on such a paragraph. A link around only an image (`[![Logo](logo.png)](https://example.com)`) is not affected.

**Workaround:** Use separate links for the text and the image.

### Feedback refuses escaped `*` and `_`
A backslash-escaped asterisk or underscore (`\*not italic\*`, `\_not italic\_`) stops **Log feedback for an LLM** from starting with "Canonical block content does not match the saved source snapshot." The text shows and saves correctly; only Feedback is affected. Escaped brackets (`\[`) are fine.

**Workaround:** Wrap the literal characters in inline code (`` `*not italic*` ``) while you review with Feedback.

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
| “Open with Markdown Editor for Humans” fails | Right-click the editor tab → **Reopen Editor With...** → **Visual Editor** (Markdown Editor for Humans) |
| Theme colors look wrong | Reload Window; check VS Code theme settings |

---

## Recently fixed

Fixed in 0.4.4; see [CHANGELOG.md](CHANGELOG.md) for the full list.

- **Feedback and link reference definitions:** Feedback starts on a document that has `[label]: https://...` definitions.
- **Duplicate link reference definitions** are no longer deleted on save.
- **Word export** keeps code blocks and block math, and shows checklist items as ☐ and ☑.
- **Links to other Markdown files** open in this editor, including links with a section (`guide.md#install`) or encoded characters.

---

**Agents:** Prefer [CHANGELOG.md](CHANGELOG.md) Known Issues for the current release. Do not treat this file as a roadmap or metrics dashboard. Active work: [`roadmap/pipeline/`](roadmap/pipeline/). Shipped plans: [`roadmap/shipped/`](roadmap/shipped/).
