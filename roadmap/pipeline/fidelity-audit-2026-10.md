# Source fidelity audit, October 2026

**Date:** 2026-10-11 · **Checked against:** `main` at `4475045` (0.4.4) plus `e590ea7` · **Status:** audit done, nothing fixed · **Owner decisions pending:** section 7

The editor's promise is that a Markdown file comes back from the rich view unchanged except for what the user edited. Six months of fixes (HTML comments, wrapper tags, `<kbd>`, link definitions, Feedback refusals) were all the same bug in different shapes. This audit measures the whole class at once and names where it comes from, so the next fix is structural.

**Since this audit (same day):** the two repeated-definition shapes of class A are fixed (`../shipped/task-fix-duplicate-link-definitions.md`), and the loss guard of section 6 item 3 is built (`../shipped/task-html-loss-guard.md`). The numbers below are from before both.

Related: `html-loss-findings-2026-10.md` (the HTML subset, measured first), `../shipped/task-fix-feedback-link-definitions.md`.

---

## 1. Verdict

- **One root cause, three symptoms.** The rich view has a closed set of block and inline types. Source that has no type is dropped on load, rewritten on edit, or makes Feedback refuse the document.
- **Unedited content is mostly safe, with 14 exceptions.** 237 of 251 shapes save identical when nothing in them is edited. The 14 that do not are lost on the first edit anywhere in the file.
- **Editing a block is where most loss happens.** 52 of 229 testable shapes (23%) lose or change content when their own text is edited. Raw HTML is the worst group (29 of 44), but escapes, code spans, lists and links are affected too.
- **Feedback's refusal is the same bug showing early.** 63 of 251 shapes make Feedback refuse. 47 of the 52 shapes that lose content on edit are among them.
- **Real documents are better than the shape list suggests.** Of 5,469 distinct blocks in this repository's own Markdown, 91 (1.7%) lose or change content when edited. Still, Feedback refuses 16 of this repository's 143 Markdown files.

---

## 2. Method

The audit is in the repository and runs in about 10 seconds:

```bash
MD4H_FIDELITY_AUDIT=1 npx jest src/__tests__/audit
```

- `src/__tests__/audit/fidelityCorpus.ts`: 251 shapes (79 inline, 106 block, 55 raw HTML, 11 whole-document).
- `src/__tests__/audit/fidelityAudit.realEditor.test.ts`: the harness. It is skipped in a normal test run and asserts nothing about the shapes; it writes a JSON report (`MD4H_FIDELITY_AUDIT_OUT`, default: the system temp folder).
- The editor is built from the parse and save extensions of `src/webview/editor.ts`, in the same order, with the shipped default `blankLines.mode` (`strip`). `MD4H_FIDELITY_AUDIT_BLANK_LINES=preserve` runs the other mode.
- Second corpus: every tracked `*.md` file of this repository (143 files) and its 5,530 distinct top-level blocks.

Four checks per shape, framed as `# Title`, the shape, `Tail paragraph.`:

| Check | What is done | Pass |
|---|---|---|
| untouched | Load, save | Saved text is identical |
| elsewhere | Type in the tail paragraph, save | The shape's text is identical |
| inside | Type in the first text of each of the shape's blocks, save | Nothing lost, same rendering |
| feedback | The checks `MarkdownEditorProvider` runs before a Feedback session starts | Accepted |

Verdicts: **identical**; **rewritten** (other text, same rendering in markdown-it and marked); **dialect** (the two parsers disagree); **changed** (renders differently in both); **lost** (an HTML tag, comment or link definition is gone).

---

## 3. Numbers

Default settings (`blankLines.mode: strip`).

| Corpus | Samples | Fails untouched or elsewhere | Fails inside (of testable) | Rewritten inside, same rendering | Feedback refuses |
|---|---|---|---|---|---|
| Inline shapes | 79 | 0 | 12 of 76 | 12 | 11 |
| Block shapes | 106 | 3 | 11 of 100 | 34 | 9 |
| Raw HTML shapes | 55 | 11 | 29 of 44 | 3 | 42 |
| Whole-document shapes | 11 | 0 | 0 of 9 | 0 | 1 (harness only, see section 8) |
| **All shapes** | **251** | **14** | **52 of 229** | **49** | **63** |
| Repository files | 143 | 4 (rewritten, same rendering) | not run on whole files | | 16 |
| Repository blocks | 5,530 | 5 | 91 of 5,469 | 431 | 26 |

---

## 4. Root cause and failure classes

```
 source text
     |  marked lexer + markedLexerNormalizer.ts
     v
  tokens ---- token with no node or mark ----> dropped            (class A)
     |
     v
 ProseMirror document (closed schema)
     |
     +-- block not edited: its original source text is written back   (safe)
     |
     +-- block edited: serializer writes it again from the nodes
     |        anything the nodes do not hold is gone              (class B)
     v
 saved text
     |
     +-- Feedback compares rich-view blocks with markdown-it's blocks
              any disagreement: the whole document is refused     (class C)
```

### Class A: never enters the editor (lost on the first edit anywhere), 14 shapes

| Shape | What happens | Where |
|---|---|---|
| `<video>`, `<audio>`, `<iframe>`, inline `<svg>`, `<style>`, `<script>` | Whole element gone | `@tiptap/markdown` parses each `html` token through the schema; nothing matches. `isContentFreeHtmlToken` in `markedLexerNormalizer.ts` drops what is left. |
| Standalone `<a name="x"></a>`, `<dl>`, `<figure>` with `<figcaption>` | Tags gone, inner text kept as paragraphs | Same |
| `<?xml ?>`, `<![CDATA[ ]]>` | Gone | Same |
| Duplicate link definition, definition differing only by case | Second definition line gone | marked emits no `def` token for a label it already has; `toHtmlCommentToken` never sees it |
| List mixing plain and task items | A blank line is inserted, splitting it into two lists | The task-list tokenizer splits the list (location not traced); `KNOWN_ISSUES.md` says the file is not changed, which is wrong once anything is edited |

Why "unedited blocks keep their source" does not help here: that source is carried by a block. These shapes produce no block, so nothing carries them.

### Class B: rewritten with loss when the block is edited, 52 shapes

| Group | Count | Examples | Result |
|---|---|---|---|
| Raw HTML with no node or mark | 29 | `<mark> <u> <ins> <abbr> <span> <font> <b> <i> <del> <s>`, `<br>` in a paragraph, `<a id>`, `<a target>`, `<h1 align>`, one-line `<div>`/`<center>`/`<p>`, `<ul><li>`, `<pre><code>`, `<blockquote>`, custom elements, a comment before text or inside emphasis | Tags gone; `<font>` and `<center>` are written back entity-encoded |
| Backslash escapes | 7 | `\*`, `\_`, `` \` ``, `\[`, `\<`, `\# Not a heading`, `1\. Not a list` | The backslash is dropped. The last two turn the paragraph into a heading or a list. |
| Lists | 6 | Loose list becomes tight; a blank line before a child fence or quote is dropped; `- one` then `* two` both become `-`; a break in a task item | Rendering changes. Partly listed in `KNOWN_ISSUES.md`. |
| Code spans | 1 shape, also seen in repository blocks | `` `  padded  ` `` and `` `### ` `` | Edge spaces move out of the code span, so the code changes |
| Links | 2 | `[x](<a b>)` loses its angle brackets and no longer parses as a link; a link around text and an image is split | Broken or split link |
| Literal angle brackets | 1 shape, also seen in repository blocks | `List<String>`, `v<version>` | Written back as `&lt;`, which changes what other renderers show |
| Other | 6 | Multi-line setext heading (second line falls out of the heading), `H~2~O` becomes `H~~2~~O`, `[X]` becomes `[x]`, three-space indent dropped, definitions as in class A | Mixed |

Where: `renderMarkdown` of each node and mark, and `serializeBlockMarkdown` / `getEditorMarkdownForSync` in `src/webview/utils/markdownSerialization.ts`. Loading keeps the meaning of an escape or an unknown tag only as plain text or not at all, so the serializer cannot write it back.

### Class C: Feedback refuses, 63 shapes

| Reason | Count | Meaning |
|---|---|---|
| `block-content-mismatch` | 29 | The block's serialized form does not render like its source. This is class B, caught before any edit. |
| `block-kind-mismatch` | 14 | An HTML block the rich view shows as a paragraph, heading, list, code or quote (`<p align>`, `<h1>`, `<picture>`, `<hr>`, `<pre>`) |
| `rendered Markdown differs` | 11 | Class A |
| `invalid-canonical-block` | 8 | One rich-view block serializes as a different kind or as several blocks |
| `block-count-mismatch` | 1 | The mixed list |

- 47 of the 52 class B shapes are refused by Feedback. The refusal is an early, unintended warning of that loss.
- 10 shapes are refused although editing them is safe: centered logo, badge row, `<picture>`, `<hr>`, linked HTML image, HTML tables (2), an empty fence, a line that is only `- `, and the byte order mark (harness only).
- Where: `buildFeedbackAnchorMap` in `src/editor/feedbackAnchors.ts` and `FeedbackSnapshotService.finalize`. One block that cannot be proven refuses the whole document.

---

## 5. Why it keeps coming back

| Cause | Evidence |
|---|---|
| Fixes are per shape | Each release added one node, mark or marker rule for the shape that was reported (see `html-loss-findings-2026-10.md` section 3). |
| No test states the promise | There was no test saying "any Markdown in, same Markdown out". `layoutFuzz.realEditor.test.ts` covers blank-line layout for eight block kinds only. |
| Tests do not run the shipped configuration | 54 test files build their own editor with a hand-copied extension list. 52 of them lack `HtmlKbd`, `HtmlSub`, `HtmlSup`, including the Feedback harness. A fix can pass its tests and still not hold in the product, and the reverse. |
| Loss is silent | Nothing compares what was loaded with what is about to be written. |
| Feedback's signal is not used | Feedback already detects 47 of the 52 lossy shapes, but only says the document cannot be matched. |
| Known issues are worded as cosmetic | "Edited blocks are saved in a standard Markdown form. The rendered result is the same." The audit shows 15 edited shapes where the rendering is not the same. |

---

## 6. What would end the class

Ranked by how much of the class each one closes. Effort figures are rough guesses.

| # | Change | Closes | Effort |
|---|---|---|---|
| 1 | **Fidelity gate.** Turn this audit into a ratchet in CI: commit today's failures as the baseline; a new failure, or a baseline entry that no longer fails without being removed, fails the build. Add the CommonMark and GFM spec examples as a third corpus. | Stops regressions and makes every new shape a one-line addition. Fixes nothing by itself. | 1 to 2 days |
| 2 | **One extension list.** Export production's list from one module; `editor.ts` and every real-editor test use it. | The gap between tests and product. | 1 to 2 days, mostly mechanical |
| 3 | **Loss guard.** Before writing, compare what the block held with what the serializer produced; never write a silent loss, and tell the user what the editor cannot keep. | All of class A and B as data loss, including shapes not in the corpus. The shapes still do not round-trip, but the file is safe. | 2 to 3 days |
| 4 | **Generic passthrough.** Unknown block HTML becomes a marker block; unknown inline HTML becomes an inline atom; duplicate definitions get a marker. Same pattern as pitfall 17. | Class A (13 of 14) and the HTML part of class B (29 of 52). | About 1 week |
| 5 | **Keep escapes and exact inline source.** Carry the source text of an inline run and reuse it when the run's nodes are unchanged, the way blocks already do. | Escapes, code spans, literal angle brackets, link forms (about 11 of 52). | About 1 week, needs a design |
| 6 | **Feedback degrades instead of refusing.** Anchor every block that can be proven; mark the others as not reviewable. | Class C for users. | 3 to 5 days, changes the Feedback contract |

**Recommendation:** 1 and 2 first (they make every later fix provable), then 3 (the file is safe from then on), then 4. Decide 5 and 6 afterwards with the gate's numbers.

---

## 7. Decisions needed from the owner

1. Order of work: the recommendation above, or the loss guard first because it protects users soonest.
2. Whether a save may be blocked or must only warn when the guard finds a loss.
3. Whether Feedback may start on a document with blocks it cannot anchor (item 6).
4. Whether to add the CommonMark and GFM spec example files to the repository (a download of two public JSON files; not done yet).
5. `KNOWN_ISSUES.md` wording: it understates escapes (`\#` and `1\.` change the block type) and says the mixed list leaves the file unchanged.

---

## 8. Limits of this audit

- **jsdom, not a real VS Code window.** HTML parsing differs from Chromium in places. Confirm class A in an Extension Development Host before any public wording. `issue-triage-2026-10.md` says `<video>` is "shown as source"; the audit found no block for it.
- **Frontmatter is stripped** from repository files, because the host wraps it before the webview sees it.
- **The edit is one insertion of text** at the end of the first text of each block. Deleting, pasting, formatting, Enter, drag and undo are not exercised.
- **Line endings, byte order mark and final newline** are taken out of the comparison, on the assumption that VS Code keeps them. The byte order mark refusal in the Feedback column comes from that shortcut. An Extension Host test should confirm it.
- **Rendering is judged by markdown-it and marked**, not by GitHub. "rewritten" means both agree the result renders the same.
- **Shape counts are not user frequency.** The repository-block numbers are closer to real use, but come from one project's writing style, with very little raw HTML.
- Four repository files and four blocks are rewritten without an edit, with the same rendering. One was examined: a list that ends in an empty item (`- `). The other three were not examined. The fifth block is a lone `</details>` cut out of its document by the block splitter.
