# Raw HTML loss in the rich editor, October 2026

**Date:** 2026-10-11 · **Checked against:** `main` at `4475045` (0.4.4) plus `e590ea7` · **Status:** logged, not fixed · **Owner decision pending:** which option in section 5

Markdown files often contain raw HTML (centered logos, `<details>`, `<kbd>`, anchors). The editor still drops some of it from the file. This has been fixed one shape at a time since April 2026. This file records what was measured, so the next step starts from evidence.

**How it was measured:** a temporary Jest real-editor probe (jsdom) with production's exact extension list from `src/webview/editor.ts`, loading with `setMarkdownContentPreservingSource` and serializing with `getEditorMarkdownForSync`. It was not run in a real VS Code window, and the probe is not in the repository. Its 45 sources are in section 7.

---

## 1. Summary

| Outcome | Count | Meaning for the user |
|---|---|---|
| Lost on the first edit anywhere in the file | 7 of 45 | The tags never enter the editor. Any edit, even in another paragraph, writes the file without them. |
| Lost when that block is edited | 22 of 37 testable | The file is safe until the user types in that paragraph, heading, list item or code block. |
| Kept in every mode | 15 of 37 testable | Safe. |
| Feedback refuses to start | 21 of 45 | "Log feedback for an LLM" cannot match the document to the saved file (anchor-map check only). |

8 of the 45 shapes have no editable text (for example a lone `<img>`), so the "edit that block" check does not apply to them.

---

## 2. Root cause

```
source text --marked--> tokens --TipTap--> closed ProseMirror schema --serializer--> saved text
                                             |
                                             +-- HTML with no node or mark is dropped here
```

- The schema is closed. A tag survives only if some node or mark represents it (`htmlComment`, `HtmlKbd`, `HtmlPreservingTable`, `CustomImage`, and so on).
- Since 0.4.1, a block the user does not edit is written back from its original source. That hides the loss until the block is edited.
- HTML that produces no block at all has nothing to carry its source, so it is lost on the first edit anywhere.
- Every fix so far added one more node, mark or marker rule for one more shape.

---

## 3. History

| Release | Date | Shape fixed | Commits |
|---|---|---|---|
| 0.1.5 | 2026-04-20 | Pasted raw HTML auto-rendering; HTML tables losing classes | `d9f97db` |
| 0.3.0 | 2026-08-07 | Pasted HTML tables | `8f637ab` |
| 0.4.0 | 2026-10-01 | `&lt;tag&gt;` text turned into deletable HTML; `<` and `>` entity-encoded in prose; `<br>` in HTML table cells | `512b80f`, `255e98c`, `80d2a71` |
| 0.4.1 | 2026-10-04 | HTML comments deleted on save since 0.3.0 | `356f6f3`, `e0cfd08` |
| 0.4.2 | 2026-10-06 | Wrapper tags (`<div align>`, `<center>`, `<p>`, `<details>`), `<kbd>` `<sub>` `<sup>`, link reference definitions | `685b4d4`, `8f00b15` |
| Unreleased | 2026-10-11 | Feedback refusing link reference definitions | `e590ea7` |

Related open issue: #72 asks for HTML5 tags such as `<video>` to render.

---

## 4. Results by shape

"Open and edit elsewhere" covers both an untouched save and an edit in another paragraph; the two always agreed.

| Shape | Open and edit elsewhere | Edit that block | Feedback |
|---|---|---|---|
| centered logo in `<p>` | kept | n/a | refuses |
| centered `<h1>` | kept | **lost** | refuses |
| badge row in `<p>` | kept | n/a | refuses |
| div with Markdown, no blank lines | kept | **lost** | refuses |
| div with Markdown, blank lines | kept | kept | starts |
| details with list | kept | kept | starts |
| details with code fence | kept | kept | starts |
| details, text directly inside | kept | **lost** | refuses |
| kbd sub sup | kept | kept | starts |
| mark u ins abbr | kept | **lost** | starts |
| span with style | kept | **lost** | starts |
| font color | kept | **lost** | starts |
| b i strong em | kept | **lost** | starts |
| br in paragraph | kept | **lost** | starts |
| br in table cell | kept | kept | starts |
| named anchor before heading | **lost** | **lost** | refuses |
| inline anchor id | kept | **lost** | starts |
| html link inline | kept | **lost** | starts |
| html img inline | kept | kept | starts |
| html img standalone | kept | n/a | starts |
| two html imgs | kept | kept | starts |
| linked html img | kept | n/a | starts |
| html table | kept | kept | starts |
| html table with colspan | kept | kept | starts |
| html table with Markdown cells | kept | kept | refuses |
| picture dark/light | kept | n/a | refuses |
| video | **lost** | n/a | refuses |
| iframe | **lost** | n/a | refuses |
| definition list | **lost** | **lost** | refuses |
| center one line | kept | **lost** | refuses |
| div one line | kept | **lost** | refuses |
| html paragraph | kept | **lost** | refuses |
| small note in sub | kept | kept | starts |
| heading with sup | kept | kept | starts |
| html in list items | kept | **lost** | starts |
| details inside list item | kept | **lost** | starts |
| hr tag | kept | kept | refuses |
| pre code html | kept | **lost** | refuses |
| html blockquote | kept | **lost** | refuses |
| style block | **lost** | **lost** | refuses |
| inline svg | **lost** | n/a | refuses |
| entities | kept | kept | starts |
| comment before text | kept | **lost** | refuses |
| figure with caption | **lost** | **lost** | refuses |
| align right img then text | kept | kept | starts |

**Not verified:**
- Nothing here was checked in a real VS Code window. jsdom parses HTML differently from Chromium in places, so single rows may differ.
- `issue-triage-2026-10.md` says `<video>` (#72) is "shown as source". The probe found no block for it at all. One of the two is wrong; check it in a real window first.
- "Feedback" is the anchor-map check (`buildFeedbackAnchorMap`) only, not a full Feedback start.

---

## 5. Options

Effort figures are rough guesses.

| Option | What it does | Effort | Stops the loss? |
|---|---|---|---|
| A. Blanket warning on any HTML | A notice when a file with HTML opens | About 0.5 day | No. It also fires on files that are safe (most READMEs), so it would be ignored. |
| B. Loss guard | Compare the HTML tags in the source with the tags in the serialized text. On open, name the tags and lines the editor cannot keep. On edit, never write a block that silently lost tags. | About 2 to 3 days | Yes, for every shape, including ones not in this list. |
| C. Generic passthrough | Unknown block HTML becomes a marker block and unknown inline HTML an inline atom, the pattern already used for comments (pitfall 17). | About 1 week, with regression risk | Yes, by construction. Ends the one-shape-at-a-time fixes. |

**Recommendation:** B first, then C. B works from the output, not from a list of known tags, so it also protects shapes nobody has reported.

---

## 6. Next steps

- [ ] Owner picks an option.
- [ ] Check `<video>`, the standalone `<a name>` anchor and `<figure>` in a real Extension Development Host before any public wording.
- [ ] `KNOWN_ISSUES.md` has no entry for this yet. Add one once the list is confirmed in a real window.
- [ ] If B: plan file `../shipped/task-html-loss-guard.md` (built and shipped in 0.4.4), failing tests from section 7, UX wording approved before building.

---

## 7. Probe sources

Each source was placed between a `# Title` heading and a `Tail paragraph.`. Three runs per source: no edit, `ZZ` appended to the tail paragraph, `ZZ` appended to the first text inside the source. A tag counts as lost when it is in the source and not in the output.

```ts
const CASES: Array<[string, string]> = [
  ['centered logo in <p>', '<p align="center">\n  <img src="logo.png" width="200" alt="Logo">\n</p>'],
  ['centered <h1>', '<h1 align="center">Project name</h1>'],
  ['badge row in <p>', '<p align="center">\n  <a href="https://x.example"><img src="https://img.shields.io/a.svg" alt="a"></a>\n  <a href="https://y.example"><img src="https://img.shields.io/b.svg" alt="b"></a>\n</p>'],
  ['div with Markdown, no blank lines', '<div align="center">\n**bold** text\n</div>'],
  ['div with Markdown, blank lines', '<div align="center">\n\n**bold** text\n\n</div>'],
  ['details with list', '<details>\n<summary>Click to expand</summary>\n\n- one\n- two\n\n</details>'],
  ['details with code fence', '<details>\n<summary>Code</summary>\n\n```js\nconst a = 1;\n```\n\n</details>'],
  ['details, text directly inside', '<details>\n<summary>S</summary>\nPlain line inside\n</details>'],
  ['kbd sub sup', 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O and x<sup>2</sup> here.'],
  ['mark u ins abbr', 'Some <mark>marked</mark>, <u>under</u>, <ins>ins</ins> and <abbr title="x">abbr</abbr> text.'],
  ['span with style', 'Some <span style="color:red">red</span> text here.'],
  ['font color', 'Some <font color="red">red</font> text here.'],
  ['b i strong em', 'Some <b>bold</b> and <i>italic</i> and <strong>strong</strong> and <em>em</em> text.'],
  ['br in paragraph', 'Line one<br>Line two<br/>Line three'],
  ['br in table cell', '| A | B |\n|---|---|\n| one<br>two | x |'],
  ['named anchor before heading', '<a name="install"></a>\n\n## Install\n\nSteps here.'],
  ['inline anchor id', 'Intro text <a id="top"></a> continues here.'],
  ['html link inline', 'See <a href="https://x.example" target="_blank">the site</a> now.'],
  ['html img inline', 'Text <img src="a.png" width="20" height="20" align="left"> more text.'],
  ['html img standalone', '<img src="a.png" width="300" alt="shot">'],
  ['two html imgs', '<img src="a.png" width="100"> <img src="b.png" width="100">'],
  ['linked html img', '<a href="https://x.example"><img src="a.png" width="100" alt="a"></a>'],
  ['html table', '<table>\n  <tr>\n    <td>A</td>\n    <td>B</td>\n  </tr>\n</table>'],
  ['html table with colspan', '<table>\n<tr><th colspan="2">Head</th></tr>\n<tr><td>A</td><td>B</td></tr>\n</table>'],
  ['html table with Markdown cells', '<table>\n<tr>\n<td>\n\n**bold** cell\n\n</td>\n<td>\n\n- item\n\n</td>\n</tr>\n</table>'],
  ['picture dark/light', '<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="dark.png">\n  <img src="light.png" alt="logo">\n</picture>'],
  ['video', '<video src="demo.mp4" controls width="600"></video>'],
  ['iframe', '<iframe src="https://example.com/embed" width="560" height="315"></iframe>'],
  ['definition list', '<dl>\n  <dt>Term</dt>\n  <dd>Definition</dd>\n</dl>'],
  ['center one line', '<center>Centered text</center>'],
  ['div one line', '<div class="note">Note text</div>'],
  ['html paragraph', '<p>Plain html paragraph with <b>bold</b> text.</p>'],
  ['small note in sub', '<sub>Small note under a figure</sub>'],
  ['heading with sup', '## Title <sup>beta</sup>\n\nBody text.'],
  ['html in list items', '- item <kbd>K</kbd> here\n- second <br> line'],
  ['details inside list item', '- parent\n\n  <details>\n  <summary>More</summary>\n\n  hidden\n\n  </details>'],
  ['hr tag', 'Above\n\n<hr>\n\nBelow'],
  ['pre code html', '<pre><code>line 1\nline 2</code></pre>'],
  ['html blockquote', '<blockquote>\nQuoted text\n</blockquote>'],
  ['style block', '<style>\n.x { color: red; }\n</style>\n\nText after.'],
  ['inline svg', '<svg width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>'],
  ['entities', 'A&nbsp;B &copy; 2026 &lt;tag&gt; text.'],
  ['comment before text', '<!-- note --> text after comment'],
  ['figure with caption', '<figure>\n  <img src="a.png" alt="a">\n  <figcaption>Caption text</figcaption>\n</figure>'],
  ['align right img then text', '<img align="right" src="a.png" width="120">\n\nParagraph next to image.'],
];
```
